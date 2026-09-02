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

import { confirmCharge, ConfirmChargeError } from './charges';
import type { ConfirmChargeOptions, ConfirmedCharge } from './charges';
import { mockEnabled } from './mock';
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
  err: unknown;
}

async function fetchSignatures(
  endpoint: string,
  reference: string,
  options: FindChargeOptions | undefined,
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

  const endpoint = rpcUrl();
  const signatures = await fetchSignatures(endpoint, reference, options);

  // The RPC answers newest-first, so the oldest is the tail.
  for (let index = signatures.length - 1; index >= 0; index -= 1) {
    const entry = signatures[index]!;
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
