// A payout that survives crashes, lost replies, and retries: the obligation
// and its whole lifecycle live on one document in the app's store, and every
// step is a compare-and-swap on that document.
//
//   pending  the document owes money; nothing has been built or sent
//   paying   an attempt exists: bytes, idempotency key, reference, and (for
//            a signer that signs locally) the signature — all stored BEFORE
//            anything is broadcast, so a crash after the send leaves either a
//            signature or a reference the chain can be asked about
//   paid     confirmed on chain
//
// Only ledger-proven nonpayment licenses new bytes: `expired` or
// `failed_on_chain` from confirmation, or a reference that still shows
// nothing once the attempt can no longer land. An unknown outcome keeps the
// attempt and asks again next time. A signer that signs at send time (a
// wallet service) is retried with the same bytes and key only inside the
// replay window the signer declares; after that, or when it declares none,
// recovery goes by the attempt's reference.
import { randomUUID } from 'node:crypto';

import {
  buildPayout,
  confirmPayout,
  PayError,
  sendPayout,
  signPayout,
  type PayErrorCode,
  type PayRecipient,
  type PaymentSigner,
} from './payouts';
import { createReference, findPayoutByReference } from './references';
import { PreconditionFailed, TooContended, type StoreBackend } from './store/index';

export interface PayoutAttempt {
  /** The idempotency key the signer was made with; the same one on every resend. */
  key: string;
  /** The reference the transaction carries, for recovery by `findPayoutByReference`. */
  reference: string;
  createdAt: number;
  /** The wire transaction, base64: signed for a local signer, unsigned otherwise. */
  transaction: string;
  /** Known before the send for a local signer; learned from the send or by reference otherwise. */
  signature: string | null;
  /** Null for a signer that may replace the blockhash when it signs. */
  lastValidBlockHeight: number | null;
  /** The last outcome that left this attempt unresolved, for a screen or an operator. */
  error?: PayErrorCode;
}

export interface Payout {
  status: 'pending' | 'paying' | 'paid';
  /** The treasury the money leaves; a signer for another address is refused. */
  payee: string;
  /** Every party, zero lines included: the record says who got what. */
  recipients: PayRecipient[];
  /** The label the transaction carries on chain, e.g. `payout:<id>`. */
  memo?: string;
  attempt: PayoutAttempt | null;
}

/** A fresh obligation, to be stored on the document that owns it. */
export const pendingPayout = (payee: string, recipients: PayRecipient[], memo?: string): Payout => ({
  status: 'pending',
  payee,
  recipients,
  ...(memo === undefined ? {} : { memo }),
  attempt: null,
});

/** The document shape: the obligation under `payout`, the rest is the app's. */
export interface PayoutDocument {
  payout: Payout | null;
  [key: string]: unknown;
}

export interface SettlePayoutOptions {
  store: StoreBackend;
  /**
   * The signer for one attempt, made with that attempt's idempotency key —
   * for a wallet service, `(key) => delegatedPrivySigner({ idempotencyKey: key })`.
   * A resend of the same attempt gets the same key, so the service replays
   * instead of paying twice — for as long as the signer's `replayWindowMs`
   * says it will.
   */
  signer: (idempotencyKey: string) => PaymentSigner | Promise<PaymentSigner>;
}

// Stop resending this long before the signer's replay window closes, rather
// than send a request on the boundary. A later unknown outcome needs
// reconciliation by reference.
const REPLAY_MARGIN_MS = 60 * 60_000;
// A transaction lives only as long as its blockhash, about a minute, and a
// service signs only when asked, which stops when its replay window closes.
// So a reference that still shows nothing this long after the last possible
// send is proof the attempt never landed and never can — the same license
// `expired` gives a local signer. An hour also covers any indexing lag.
const LEDGER_SETTLE_MS = 60 * 60_000;
const CAS_ATTEMPTS = 5;

async function changePayout(
  store: StoreBackend,
  path: string,
  key: string,
  change: (payout: Payout) => Payout,
): Promise<void> {
  for (let i = 0; i < CAS_ATTEMPTS; i++) {
    const stored = await store.readJson<PayoutDocument>(path);
    // Gone, or a different attempt owns the document now: nothing to say.
    if (!stored?.value.payout || stored.value.payout.attempt?.key !== key) return;
    const payout = change(stored.value.payout);
    if (payout === stored.value.payout) return;
    try {
      await store.writeJson(path, { ...stored.value, payout }, stored.etag);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new TooContended(path, CAS_ATTEMPTS);
}

// Whether a lost reply may be answered by sending the same bytes again.
function withinReplayWindow(signer: PaymentSigner, attempt: PayoutAttempt): boolean {
  if (signer.replayWindowMs === undefined) return false;
  return Date.now() - attempt.createdAt < signer.replayWindowMs - REPLAY_MARGIN_MS;
}

// Whether an attempt with no signature and nothing under its reference can
// still land: not once every send it could have been given has expired.
function couldStillLand(signer: PaymentSigner, attempt: PayoutAttempt): boolean {
  return Date.now() - attempt.createdAt < Math.max(signer.replayWindowMs ?? 0, LEDGER_SETTLE_MS);
}

function abandonAttempt(store: StoreBackend, path: string, key: string): Promise<void> {
  return changePayout(store, path, key, (current) =>
    current.status === 'paid' ? current : { ...current, status: 'pending', attempt: null },
  );
}

function recordError(store: StoreBackend, path: string, key: string, code: PayErrorCode): Promise<void> {
  return changePayout(store, path, key, (current) =>
    current.status === 'paid' ? current : { ...current, attempt: { ...current.attempt!, error: code } },
  );
}

/**
 * Drive the payout on the document at `path` as far as it will go right now
 * and return its state: null when the document or its obligation is absent.
 * Safe to call from a worker, a request, or two of them at once — the
 * document arbitrates.
 *
 * A send or confirmation outcome never throws; it is recorded on the
 * document and asked about next time. What does throw: store failures, a
 * signer for the wrong treasury, and a build that fails before anything is
 * stored (`buildPayout`'s PayError, typically the RPC) — the obligation is
 * still pending then, so a worker retries it later.
 */
export async function settlePayout(path: string, options: SettlePayoutOptions): Promise<Payout | null> {
  const { store } = options;
  let stored = await store.readJson<PayoutDocument>(path);
  let payout = stored?.value.payout ?? null;
  if (!stored || !payout || payout.status === 'paid') return payout;
  let firstSend = false;

  if (payout.status === 'pending') {
    const key = randomUUID();
    const reference = createReference();
    const signer = await options.signer(key);
    if (signer.address !== payout.payee) throw new Error('Payout treasury changed');
    const built = await buildPayout(
      { recipients: payout.recipients, reference, ...(payout.memo === undefined ? {} : { memo: payout.memo }) },
      { signer },
    );
    const signed = signer.signTransaction ? signPayout(built.transaction, { signer }) : null;
    payout = {
      ...payout,
      status: 'paying',
      attempt: {
        key,
        reference,
        createdAt: Date.now(),
        transaction: signed?.transaction ?? built.transaction,
        signature: signed?.signature ?? null,
        lastValidBlockHeight: signed ? built.lastValidBlockHeight : null,
      },
    };
    try {
      // Only the CAS winner may broadcast these bytes. A crash after this write
      // still leaves either a signature or a reference to reconcile.
      await store.writeJson(path, { ...stored.value, payout }, stored.etag);
      firstSend = true;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      return (await store.readJson<PayoutDocument>(path))?.value.payout ?? null;
    }
  }

  const attempt = payout.attempt!;
  let signature = attempt.signature;
  try {
    const signer = firstSend || !signature ? await options.signer(attempt.key) : null;
    if (signer && signer.address !== payout.payee) throw new Error('Payout treasury changed');
    if (!signature && !firstSend) {
      // A failure to look throws PayError('rpc_error') and is not a negative answer.
      signature = (await findPayoutByReference(attempt.reference))?.signature ?? null;
      if (!signature && signer && !couldStillLand(signer, attempt)) {
        await abandonAttempt(store, path, attempt.key);
        stored = await store.readJson<PayoutDocument>(path);
        return stored?.value.payout ?? null;
      }
    }
    if (signer && (firstSend || (!signature && withinReplayWindow(signer, attempt)))) {
      try {
        const sent = await sendPayout(attempt.transaction, { signer });
        if (signature && signature !== sent.signature) throw new Error('Payout signature changed');
        signature = sent.signature;
      } catch (error) {
        // A rejected send says nothing about an earlier landing. For local
        // signing we already have the authoritative signature to ask about.
        if (error instanceof PayError && !signature) await recordError(store, path, attempt.key, error.code);
      }
    }
    if (signature) {
      await changePayout(store, path, attempt.key, (current) =>
        current.status === 'paid' ? current : { ...current, attempt: { ...current.attempt!, signature } },
      );
      await confirmPayout(
        signature,
        attempt.lastValidBlockHeight === null ? undefined : { lastValidBlockHeight: attempt.lastValidBlockHeight },
      );
      await changePayout(store, path, attempt.key, (current) => ({ ...current, status: 'paid' }));
    }
  } catch (error) {
    if (!(error instanceof PayError)) throw error;
    if (error.code === 'expired' || error.code === 'failed_on_chain') {
      // Only ledger-proven nonpayment permits a new attempt. An unknown
      // outcome keeps the original bytes, key, reference, and signature.
      await abandonAttempt(store, path, attempt.key);
    } else {
      await recordError(store, path, attempt.key, error.code);
    }
  }
  stored = await store.readJson<PayoutDocument>(path);
  return stored?.value.payout ?? null;
}
