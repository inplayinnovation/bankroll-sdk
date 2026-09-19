// Finding a charge you never got the signature for.
//
// Your server mints a reference with createReference() and stores it with the
// order BEFORE calling charge(). The host carries it on the transfer as an
// inert read-only account, and validators index a transaction under every key
// it touches — so the handle exists before the payment does. If the page dies
// before it can hand you the signature, the order is still resolvable from the
// chain alone.
//
// The sibling of confirmCharge: that answers "what is this signature?", this
// answers "did the charge I'm waiting on ever happen?"
import bs58 from 'bs58';

import { AppRequestFailure, postAsApp, type AppRequestCode, type AppRequestOptions } from './app-request';
import { confirmCharge, ConfirmChargeError } from './charges';
import type { ConfirmChargeOptions, ConfirmedCharge } from './charges';
import type { Json } from './matchmaking';
import { record, snapshot } from './matchmaking-core';
import { armMockExpiry, mockEnabled, mockReference } from './mock';
import { PayError } from './payouts';
import { rpcUrl } from './rpc';

const REFERENCE_BYTES = 32;
// getSignaturesForAddress' own maximum. One page is the whole story for a
// reference used once, which is the only way to use one.
const DEFAULT_LIMIT = 1_000;

/**
 * A fresh reference: 32 random bytes, base58-encoded — the shape of a Solana
 * address, which is what lets it ride along as an account key.
 *
 * Deliberately not a keypair. Nothing ever signs with a reference, so minting
 * one would produce a secret whose only property is that it must be thrown
 * away, and an account key needn't sit on the ed25519 curve.
 *
 * Generate one per order, on your server, and store it with the order before
 * calling charge(). That's why it lives here rather than in the browser half:
 * a reference minted in the page is one the page can lose, reuse, or omit.
 *
 * It is public and permanent once the charge lands — anyone holding it can
 * find that payment, and through it the payer's wallet and the amount. Keep it
 * random and single-use; never derive it from an order id, a user id, or
 * anything else you'd mind publishing.
 */
export function createReference(): string {
  const bytes = new Uint8Array(REFERENCE_BYTES);
  crypto.getRandomValues(bytes);
  return bs58.encode(bytes);
}

export interface FindChargeOptions extends ConfirmChargeOptions {
  /** Signatures to examine per page. Default 1000 (the RPC's maximum). */
  limit?: number;
  /** Search backwards from this signature — how you walk past a page. */
  before?: string;
  /**
   * Stop at this signature. On a repeated sweep, pass the newest signature you
   * have already processed so the walk stays bounded rather than growing with
   * the reference's history.
   */
  until?: string;
}

interface RpcSignature {
  signature: string;
  slot: number;
  err: unknown;
}

type HistoryPage = Pick<FindChargeOptions, 'limit' | 'before' | 'until'>;

export interface FoundPayout {
  /** The landed transaction's signature: hand it to confirmPayout(). */
  signature: string;
  slot: number;
  /**
   * The transaction landed but failed, so no funds moved. confirmPayout()
   * reports it as `failed_on_chain`; a fresh attempt is then safe.
   */
  failed: boolean;
}

async function fetchSignatures(
  endpoint: string,
  reference: string,
  options: HistoryPage | undefined,
): Promise<RpcSignature[]> {
  const params: Record<string, unknown> = {
    commitment: 'confirmed',
    limit: options?.limit ?? DEFAULT_LIMIT,
  };
  if (options?.before) params.before = options.before;
  if (options?.until) params.until = options.until;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [reference, params],
      }),
    });
  } catch (cause) {
    throw new ConfirmChargeError('rpc_error', `RPC request to ${endpoint} failed`, { cause });
  }
  if (!response.ok) {
    throw new ConfirmChargeError('rpc_error', `RPC responded ${response.status}`);
  }
  let body: { error?: { code?: number; message?: string }; result?: RpcSignature[] };
  try {
    body = await response.json();
  } catch (cause) {
    throw new ConfirmChargeError('rpc_error', 'RPC responded with invalid JSON', { cause });
  }
  if (body.error) {
    throw new ConfirmChargeError('rpc_error', `RPC error ${body.error.code}: ${body.error.message}`);
  }
  return body.result ?? [];
}

// Both lookups start the same way: one page of the reference's history, oldest
// first. A reference is unguessable until it lands, so the first transaction
// ever to touch it is the one the app was waiting for; the RPC answers
// newest-first, hence the reversal. They part only at what to do with each
// entry — a charge is verified, a payout is reported.
async function historyOldestFirst(reference: string, page?: HistoryPage): Promise<RpcSignature[]> {
  const signatures = await fetchSignatures(rpcUrl(), reference, page);
  return signatures.reverse();
}

/**
 * The charge carrying `reference`, or null if none has landed yet.
 *
 * **null means "not yet" only for a while.** A charge can still be in flight,
 * but not indefinitely: every charge expires, and a transaction cannot land
 * once its own blockhash has died. Allow roughly five minutes from the
 * charge() call at the default window — longer by however much an
 * `expiresInSeconds` widened it — and after that a null is conclusive.
 *
 * Check what comes back exactly as you check the live path: payee is your
 * payment address, mint is the asset you priced in, amountCents matches the
 * order, payer is the session's wallet. A reference is public once it lands,
 * so anyone can attach it to a transfer of their own — a returned charge is a
 * candidate, never a receipt.
 *
 * Returns the OLDEST charge carrying the reference, because a reference is
 * unguessable until it lands: the payment you're waiting for is normally the
 * first transaction ever to touch that key. Transactions that landed and
 * failed are skipped — nothing moved, so none of them is a charge.
 *
 * Throws ConfirmChargeError('rpc_error') if the chain couldn't be read. A
 * failure to look is not a negative answer, and must never be treated as one.
 */
export async function findChargeByReference(
  reference: string,
  options?: FindChargeOptions,
): Promise<ConfirmedCharge | null> {
  // The mock host settles nothing on-chain, so there is never anything to
  // recover. Answering "nothing found" keeps a sweep from reaching an RPC.
  if (mockEnabled()) return null;

  for (const entry of await historyOldestFirst(reference, options)) {
    if (entry.err) continue;
    try {
      return await confirmCharge(entry.signature, options);
    } catch (error) {
      // Someone else's transaction carrying your key parses as
      // 'not_a_payment'; an index still catching up reads as 'not_found' and
      // the next sweep will see it. Neither is an error in your flow — an RPC
      // failure is, and propagates.
      if (error instanceof ConfirmChargeError && error.code !== 'rpc_error') continue;
      throw error;
    }
  }
  return null;
}


/**
 * The payout carrying `reference`, or null while none has landed.
 *
 * The payout twin of findChargeByReference, for the signers that cannot know a
 * signature before the send (privySigner, a wallet service): store the
 * reference with the payout row before sending, and this answers "did it
 * land?" by an id that existed before the transaction did — whatever
 * blockhash or fee payer the service signed with.
 *
 * Returns the first transaction ever to carry the reference, failed ones
 * included: a reference is unguessable until it lands, so that transaction is
 * the attempt you sent, and a landed-but-failed attempt is exactly what makes
 * a fresh one safe. One page of history is all a single-use key ever has.
 * Judge the result with confirmPayout(found.signature).
 *
 * **null means "not yet" only for a while.** With a sponsoring signer the
 * blockhash the service used is not yours to know, so no expiry fence exists;
 * what bounds a retry is the service's own idempotency (Privy replays a
 * same-key, same-body send for 24 hours instead of executing it again). Inside
 * that window a resend of the stored bytes under the stored key is safe; past
 * it, a null is a row to reconcile, never a licence to send blind.
 *
 * Throws PayError('rpc_error') if the chain couldn't be read. A failure to
 * look is not a negative answer, and must never be treated as one.
 */
export async function findPayoutByReference(reference: string): Promise<FoundPayout | null> {
  // The mock host settles nothing on-chain, so there is never anything to find.
  if (mockEnabled()) return null;

  let history: RpcSignature[];
  try {
    history = await historyOldestFirst(reference);
  } catch (error) {
    if (error instanceof ConfirmChargeError) {
      throw new PayError('rpc_error', error.message, { cause: error.cause ?? error });
    }
    throw error;
  }
  const first = history[0];
  if (first === undefined) return null;
  return { signature: first.signature, slot: first.slot, failed: first.err != null };
}

// ---------------------------------------------------------------------------
// Managed references: Bankroll does the watching
// ---------------------------------------------------------------------------
//
// createReference() above is for a server that watches the chain itself.
// createManagedReference() asks Bankroll for the reference instead, and
// Bankroll polls the chain for the first successful transaction carrying it,
// then reports to /api/bankroll/webhook on the app's origin (sdk/webhooks):
// `reference.confirmed` with the signature, or `reference.expired` when the
// window ends with none. Verified apps only. Bankroll never reads the
// transaction; the app does, as always (checkCharge, confirmPayout).
//
// With BANKROLL_MOCK=1 outside production nothing reaches Bankroll: the
// reference is minted here, the mock host's charge() and the mock payout
// signer deliver `reference.confirmed` to the route themselves, and the
// window's end delivers `reference.expired`.

const REFERENCES_PATH = '/api/v1/references';
// Bankroll's default when the call names no window: charge()'s own window
// plus time for the transaction to land.
const DEFAULT_EXPIRES_SECONDS = 7 * 60;

export type ManagedReferenceErrorCode = AppRequestCode;

export class ManagedReferenceError extends Error {
  readonly code: ManagedReferenceErrorCode;
  readonly status?: number;

  constructor(code: ManagedReferenceErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ManagedReferenceError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export type ManagedReferenceOptions = AppRequestOptions;

export interface ManagedReferenceInput {
  /**
   * Your own routing data, echoed verbatim on the event: what the reference
   * is for. Plain JSON, up to 4 KiB.
   */
  meta: Record<string, Json>;
  /**
   * How long Bankroll watches, 60 seconds to 24 hours. Default: seven
   * minutes, charge()'s own window plus time to land. A payout signer with
   * a replay window (the Privy signers: 24 hours) passes that, so that
   * `reference.expired` is safe to act on.
   */
  expiresInSeconds?: number;
}

export interface ManagedReference {
  /** Put it on the charge() or the payout; Bankroll is watching for it. */
  reference: string;
  /** When Bankroll stops watching and, absent a transaction, reports expiry. */
  expiresAt: string;
}

const invalidManaged = (message: string): never => {
  throw new ManagedReferenceError('invalid_argument', message);
};

/**
 * Ask Bankroll for a reference and start it watching. Store the reference
 * on your entry before the charge() or the payout that carries it; the
 * event that follows brings `meta` back so you can find the entry again.
 */
export async function createManagedReference(
  input: ManagedReferenceInput,
  options: ManagedReferenceOptions,
): Promise<ManagedReference> {
  let meta: Json;
  try {
    meta = snapshot(input.meta);
  } catch {
    return invalidManaged('meta must contain only plain, finite JSON values');
  }
  if (!record(meta)) return invalidManaged('meta must be a plain JSON object');
  const expiresInSeconds = input.expiresInSeconds;
  if (expiresInSeconds !== undefined && !Number.isInteger(expiresInSeconds)) {
    return invalidManaged('expiresInSeconds must be a whole number of seconds');
  }

  if (mockEnabled()) {
    const expiresAt = new Date(Date.now() + (expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS) * 1000).toISOString();
    const reference = mockReference(meta, expiresAt);
    armMockExpiry(reference, expiresAt);
    return { reference, expiresAt };
  }

  let result: Record<string, unknown>;
  try {
    result = await postAsApp(
      REFERENCES_PATH,
      { meta, ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }) },
      options,
    );
  } catch (error) {
    if (error instanceof AppRequestFailure) throw new ManagedReferenceError(error.code, error.message, error.status);
    throw error;
  }
  if (typeof result.reference !== 'string' || typeof result.expiresAt !== 'string') {
    throw new ManagedReferenceError('invalid_response', 'Malformed reply from Bankroll');
  }
  return { reference: result.reference, expiresAt: result.expiresAt };
}
