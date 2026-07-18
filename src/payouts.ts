// Server-side payouts: pay() sends HSUSD from the app's treasury to a user's
// wallet. The SDK owns the mechanics — transaction build (transferChecked +
// idempotent recipient-ATA create + optional memo), signing, broadcast, and
// confirmation — while idempotency is deliberately the caller's duty: keep one
// payout row per settled order (UNIQUE), store the returned signature, and
// never blind-retry a timed-out send (the thrown error carries what you need
// to fence: the signature and lastValidBlockHeight).
//
// Solana mechanics come from @solana/web3.js + @solana/spl-token, pinned to
// EXACT versions (no ranges) — this entry sits next to treasury key material,
// so a newly published package version must never flow in via a range.
import {
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

import { BASE_UNITS_PER_CENT, HSUSD_DECIMALS, HSUSD_MINT } from './charges';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// A blockhash is valid for ~60-90s; poll until confirmed, provably expired, or
// this guard elapses with the outcome still unknown.
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PayErrorCode =
  | 'rpc_error' // an RPC request failed — if `signature` is absent, nothing was sent
  | 'send_failed' // the RPC rejected the broadcast (incl. preflight) — nothing was sent
  | 'failed_on_chain' // the transaction landed but failed — no funds moved
  | 'expired' // provably dead: blockhash expired unused — safe to retry
  | 'confirmation_timeout'; // outcome unknown — it may still land; fence before retrying

export class PayError extends Error {
  readonly code: PayErrorCode;
  /** Set once the transaction was handed to the network — check it before any retry. */
  readonly signature?: string;
  /**
   * The block height after which the transaction can no longer land. Set only
   * for the default keypair signer, whose broadcast blockhash is known — a
   * custom signer may re-sign with a fresh blockhash (Privy sponsorship does),
   * making this bound meaningless for what was actually sent.
   */
  readonly lastValidBlockHeight?: number;

  constructor(
    code: PayErrorCode,
    message: string,
    details?: { signature?: string; lastValidBlockHeight?: number; cause?: unknown },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'PayError';
    this.code = code;
    if (details?.signature !== undefined) this.signature = details.signature;
    if (details?.lastValidBlockHeight !== undefined) {
      this.lastValidBlockHeight = details.lastValidBlockHeight;
    }
  }
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required');
  return new Connection(rpcUrl, 'confirmed');
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

export interface PaymentSigner {
  /** The treasury wallet address the payout is sent from. */
  address: string;
  /** Sign the base64 wire transaction and broadcast it; resolve with the signature. */
  sendTransaction(txBase64: string): Promise<string>;
}

// Signers created by keypairSigner() sign the exact bytes pay() built, so the
// blockhash — and therefore the expiry fence — is known. A custom signer may
// re-blockhash (Privy sponsorship does), so pay() only applies the fence to
// its own signers.
const ownSigners = new WeakSet<PaymentSigner>();

/**
 * A PaymentSigner backed by a raw base58 secret key (the 64-byte format
 * `solana-keygen` and wallet exports use). Signs locally and broadcasts to
 * SOLANA_RPC_URL. The treasury pays the network fee and any recipient
 * token-account rent, so keep some SOL on it.
 */
export function keypairSigner(secretKey: string): PaymentSigner {
  let keypair: Keypair;
  try {
    // fromSecretKey validates that the embedded public key matches the seed.
    keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  } catch (cause) {
    throw new Error('secret key is not a valid base58-encoded 64-byte ed25519 secret key', {
      cause,
    });
  }
  const signer: PaymentSigner = {
    address: keypair.publicKey.toBase58(),
    async sendTransaction(txBase64: string): Promise<string> {
      const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
      tx.sign(keypair);
      // Ed25519 is deterministic, so the signature is known before broadcast.
      const signature = bs58.encode(tx.signature!);
      try {
        await getConnection().sendRawTransaction(tx.serialize(), {
          preflightCommitment: 'confirmed',
        });
      } catch (error) {
        if (error instanceof SendTransactionError) {
          // The RPC answered with a rejection — nothing was broadcast.
          throw new PayError('send_failed', `the RPC rejected the broadcast: ${error.message}`, {
            cause: error,
          });
        }
        // Transport failure: the broadcast may or may not have reached the
        // node, so surface the signature for the caller to check.
        throw new PayError('rpc_error', 'broadcast outcome unknown — check the signature', {
          signature,
          cause: error,
        });
      }
      return signature;
    },
  };
  ownSigners.add(signer);
  return signer;
}

function defaultSigner(): PaymentSigner {
  const secretKey = process.env.BANKROLL_TREASURY_KEY;
  if (!secretKey) {
    throw new Error('BANKROLL_TREASURY_KEY is required (or pass options.signer)');
  }
  return keypairSigner(secretKey);
}

// ---------------------------------------------------------------------------
// The payout lifecycle: buildPayout → sendPayout → confirmPayout.
// pay() is their composition. Apps with record-before-broadcast machinery use
// the steps directly: persist what buildPayout returns (the exact bytes and
// their expiry) in the same write that locks the payout row, broadcast those
// bytes with sendPayout — a recorded transaction replays byte-identically, so
// wallet-service idempotency (same key + same body) holds across retries —
// and confirm, or later re-confirm, with confirmPayout.
// ---------------------------------------------------------------------------

export interface PayInput {
  /** The recipient's wallet — `session.user.wallet` from your verified session. */
  to: string;
  /** Whole US cents; must be a positive integer. */
  amountCents: number;
  /** Optional on-chain label for the payout. */
  memo?: string;
}

export interface PayoutOptions {
  /** The treasury: signs and broadcasts. Default: keypairSigner(BANKROLL_TREASURY_KEY). */
  signer?: PaymentSigner;
}

export interface BuiltPayout {
  /** The unsigned wire transaction, base64. Persist verbatim; send verbatim. */
  transaction: string;
  /** The block height after which this transaction can never land. */
  lastValidBlockHeight: number;
  /** The recent blockhash the transaction is built on. */
  blockhash: string;
}

/**
 * Build the payout transaction without sending it: idiomatic ATA-create-if-
 * needed + transferChecked + the caller's memo, on a fresh blockhash. Nothing
 * is broadcast and nothing needs signing yet — record the result on your
 * payout row before you send, and the send can always be retried or audited
 * against exactly what was recorded.
 */
export async function buildPayout(
  input: PayInput,
  options?: PayoutOptions,
): Promise<BuiltPayout> {
  const { to, amountCents } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('amountCents must be a positive integer');
  }
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(to);
  } catch (cause) {
    throw new Error(`recipient wallet is not a valid address: ${to}`, { cause });
  }
  const signer = options?.signer ?? defaultSigner();
  const treasury = new PublicKey(signer.address);
  if (!PublicKey.isOnCurve(treasury.toBytes())) {
    throw new Error(
      `treasury ${signer.address} is a PDA/smart-contract wallet — ` +
        'payouts require a keypair-backed treasury that can sign directly',
    );
  }
  const mint = new PublicKey(HSUSD_MINT);
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
  // Smart-contract wallets are off-curve owners; they are still payable.
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);

  const connection = getConnection();
  let latest: { blockhash: string; lastValidBlockHeight: number };
  try {
    latest = await connection.getLatestBlockhash();
  } catch (cause) {
    throw new PayError('rpc_error', 'failed to fetch a recent blockhash — nothing was sent', {
      cause,
    });
  }

  const tx = new Transaction({
    feePayer: treasury,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(treasury, recipientAta, recipient, mint),
    createTransferCheckedInstruction(
      treasuryAta,
      mint,
      recipientAta,
      treasury,
      BigInt(amountCents) * BASE_UNITS_PER_CENT,
      HSUSD_DECIMALS,
    ),
  );
  // Deliberately idiomatic and nothing more: ATA-create-if-needed +
  // transferChecked + the caller's memo. One consequence is standard Solana:
  // two payouts with identical payer/recipient/amount/memo on the same
  // blockhash serialize to byte-identical transactions — one deterministic
  // signature, ONE transfer — so payouts that can fire in the same instant
  // must be distinguishable (a per-order memo does it; see the docs).
  if (input.memo !== undefined) {
    tx.add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(input.memo, 'utf8'),
      }),
    );
  }

  // Serialized unsigned (placeholder signature). web3.js enforces the packet
  // limit with an opaque buffer RangeError — translate it.
  let wire: Buffer;
  try {
    wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  } catch (cause) {
    throw new Error(
      `transaction too large (max ${PACKET_DATA_SIZE} bytes) — is the memo too long?`,
      { cause },
    );
  }

  return {
    transaction: wire.toString('base64'),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    blockhash: latest.blockhash,
  };
}

/**
 * Sign and broadcast a built payout — EXACTLY the bytes given, unmodified, so
 * a transaction recorded at build time replays byte-identically on retry.
 * Resolves with the signature as soon as the broadcast is accepted; it does
 * not wait for confirmation (that's confirmPayout's job).
 */
export async function sendPayout(
  transaction: string,
  options?: PayoutOptions,
): Promise<{ signature: string }> {
  const signer = options?.signer ?? defaultSigner();
  const signature = await signer.sendTransaction(transaction);
  return { signature };
}

export interface ConfirmPayoutOptions {
  /**
   * The transaction's expiry from buildPayout. When given, a payout that
   * provably died (finalized height passed it, never landed) throws `expired`
   * — the safe-to-retry signal. Omit it when the broadcast blockhash isn't
   * yours to know (a sponsoring wallet service may have re-signed with a
   * fresh one) and rely on `confirmation_timeout` + your service's
   * idempotency instead.
   */
  lastValidBlockHeight?: number;
}

type ConfirmStatus = 'confirmed' | 'failed' | 'expired' | 'unknown';

async function awaitConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number | undefined,
): Promise<ConfirmStatus> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const statuses = await connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];
      if (status) {
        // A result only counts once the cluster confirmed it — at 'processed'
        // it may be a minority-fork verdict. Same gating stock
        // confirmTransaction('confirmed') applies via its subscription.
        if (
          status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized'
        ) {
          return status.err ? 'failed' : 'confirmed';
        }
      } else if (lastValidBlockHeight !== undefined) {
        // Standard expiry semantics: once the finalized height passes
        // lastValidBlockHeight, the transaction can never be processed. A
        // landed transaction would have surfaced in the status polls above
        // (the status cache spans the blockhash's entire validity window).
        const finalizedHeight = await connection.getBlockHeight('finalized');
        if (finalizedHeight > lastValidBlockHeight) return 'expired';
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_INTERVAL_MS));
    }
  } catch (cause) {
    // The payout was already broadcast — an RPC failure here must not read as
    // "nothing happened", so carry the signature for the caller's fence.
    throw new PayError(
      'rpc_error',
      'confirmation check failed — the payout may have landed; check the signature',
      {
        signature,
        ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
        cause,
      },
    );
  }
  return 'unknown';
}

/**
 * Wait for a broadcast payout's outcome. Resolves once the cluster confirms
 * it; throws PayError otherwise (`failed_on_chain`, `expired` when
 * lastValidBlockHeight was given and provably passed unused, or
 * `confirmation_timeout` while the outcome is still unknown).
 *
 * Also the reconciliation primitive: re-run it any time against a stored
 * signature + lastValidBlockHeight to resolve a payout row stuck in your
 * "submitted" state to confirmed / failed / expired.
 */
export async function confirmPayout(
  signature: string,
  options?: ConfirmPayoutOptions,
): Promise<void> {
  const lastValidBlockHeight = options?.lastValidBlockHeight;
  const status = await awaitConfirmation(getConnection(), signature, lastValidBlockHeight);
  switch (status) {
    case 'confirmed':
      return;
    case 'failed':
      throw new PayError('failed_on_chain', `payout ${signature} failed on-chain`, { signature });
    case 'expired':
      throw new PayError('expired', `payout ${signature} expired unused — safe to retry`, {
        signature,
        ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
      });
    case 'unknown':
      throw new PayError(
        'confirmation_timeout',
        `payout ${signature} was broadcast but its outcome is unknown — ` +
          'check the signature before retrying',
        {
          signature,
          ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
        },
      );
  }
}

/**
 * Pay a user: an HSUSD transfer from your treasury to `to`, confirmed before
 * it resolves. Throws PayError; a return value means the payout settled at
 * cluster commitment (not absolute finality — no success status anywhere in
 * payments is; see the docs on reconciliation).
 *
 * This is the composition buildPayout → sendPayout → confirmPayout in one
 * call, for apps without their own payout bookkeeping between the steps.
 * Idempotency is yours either way: keep one payout row per settled order
 * (UNIQUE), store the returned signature, and on `confirmation_timeout` use
 * the error's signature + lastValidBlockHeight to check the outcome before
 * retrying — `expired` and `send_failed` are the only codes that guarantee
 * nothing moved.
 */
export async function pay(
  input: PayInput,
  options?: PayoutOptions,
): Promise<{ signature: string }> {
  const signer = options?.signer ?? defaultSigner();
  const built = await buildPayout(input, { signer });
  const ownSigner = ownSigners.has(signer);

  let signature: string;
  try {
    ({ signature } = await sendPayout(built.transaction, { signer }));
  } catch (error) {
    // For the SDK's own signer the broadcast blockhash is known — enrich a
    // broadcast-outcome-unknown error with the fence datum the caller needs.
    if (
      ownSigner &&
      error instanceof PayError &&
      error.signature !== undefined &&
      error.lastValidBlockHeight === undefined
    ) {
      throw new PayError(error.code, error.message, {
        signature: error.signature,
        lastValidBlockHeight: built.lastValidBlockHeight,
        cause: error.cause,
      });
    }
    throw error;
  }

  // Only the default signer's blockhash is known; a custom signer may have
  // re-signed with a fresher one, so no expiry bound is claimed for it.
  await confirmPayout(
    signature,
    ownSigner ? { lastValidBlockHeight: built.lastValidBlockHeight } : {},
  );
  return { signature };
}
