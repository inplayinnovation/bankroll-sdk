// One transaction buys one entry. A charge the client reports, or one found
// by the entry's reference after the report was lost, is checked against what
// the entry was sold for and then assigned to that entry by an immutable
// receipt document under `receipts/` — created once, never rewritten — so the
// same signature can never buy a second entry, however the requests race or
// repeat.
import { createHash } from 'node:crypto';

import { confirmCharge, type ConfirmChargeOptions, type ConfirmedCharge } from './charges';
import { findChargeByReference } from './references';
import type { StoreBackend } from './store/index';

export type ReceiptErrorCode = 'invalid_signature' | 'payment_mismatch' | 'payment_already_used';
export type ChargeField = 'payee' | 'payer' | 'mint' | 'amountCents' | 'memo';

export class ReceiptError extends Error {
  constructor(
    readonly code: ReceiptErrorCode,
    message: string,
    /** For payment_mismatch: the first field that differed, so the app can say which. */
    readonly field?: ChargeField,
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}

/** What the entry was sold for. Every field must match the charge exactly. */
export interface ExpectedCharge {
  /** The verified session's wallet. */
  payer: string;
  /** The app's payments address. */
  payee: string;
  /** The mint the entry is priced in; an app token must never buy an HSUSD prize. */
  mint: string;
  amountCents: number;
  /**
   * The memo the quote carried: a string that must match, null for "must
   * carry none". Leave it out to not compare the memo at all.
   */
  memo?: string | null;
}

export interface ClaimChargeInput {
  store: StoreBackend;
  /** The entry this charge would pay for: the receipt's owner. */
  entry: string;
  /**
   * The reference minted for the entry before its quote left the server.
   * Without a reported signature, the chain is searched by it.
   */
  reference: string;
  /** The signature the client reported, if any. */
  signature?: string;
  expected: ExpectedCharge;
  confirm?: ConfirmChargeOptions;
}

export interface Receipt {
  entry: string;
  charge: ConfirmedCharge;
}

export interface ClaimedCharge {
  charge: ConfirmedCharge;
  /** True the first time this charge was assigned to the entry; false on a repeat. */
  created: boolean;
}

const SIGNATURE_LENGTH_LIMIT = 2_000;

const RECEIPT_PREFIX = 'receipts';

/**
 * Where a charge's receipt lives: under the payer, keyed by a digest of the
 * signature. Its own prefix, so an app's charge documents under `charges/`
 * never interleave with receipts in a listing.
 */
export function receiptPath(payer: string, signature: string): string {
  // The digest keeps the SDK's longer mock signatures within filesystem limits.
  const digest = createHash('sha256').update(signature).digest('hex');
  return `${RECEIPT_PREFIX}/${encodeURIComponent(payer)}/${digest}.json`;
}

/**
 * The charge that paid for `entry`, once it is assigned to it — or null when
 * nothing has landed yet. Recovery and the live path run the identical
 * checks: a found reference is a candidate, never a receipt. Throws
 * ReceiptError for a charge that does not match the entry's terms, or one
 * already assigned to another entry.
 *
 * Idempotent: repeating the call after a crash finds the receipt and returns
 * the same charge with `created: false`, so the caller can record it on the
 * entry and retry that write freely.
 */
export async function claimCharge(input: ClaimChargeInput): Promise<ClaimedCharge | null> {
  const { signature, expected } = input;
  // A reported signature usually arrives from a request body typed as anything.
  if (signature !== undefined && (typeof signature !== 'string' || !signature || signature.length > SIGNATURE_LENGTH_LIMIT)) {
    throw new ReceiptError('invalid_signature', 'The reported signature is not a string, is empty, or is too long');
  }
  const charge =
    signature !== undefined
      ? await confirmCharge(signature, input.confirm)
      : await findChargeByReference(input.reference, input.confirm);
  if (!charge) return null;

  const mismatch: ChargeField | null =
    charge.payee !== expected.payee ? 'payee'
    : charge.payer !== expected.payer ? 'payer'
    : charge.mint !== expected.mint ? 'mint'
    : charge.amountCents !== expected.amountCents ? 'amountCents'
    : expected.memo !== undefined && charge.memo !== expected.memo ? 'memo'
    : null;
  if (mismatch) {
    throw new ReceiptError(
      'payment_mismatch',
      `Charge ${charge.signature} does not match what the entry was sold for: ${mismatch}`,
      mismatch,
    );
  }

  const path = receiptPath(expected.payer, charge.signature);
  const created = await input.store.createIfAbsent(path, { entry: input.entry, charge } satisfies Receipt);
  const receipt = await input.store.readJson<Receipt>(path);
  if (receipt?.value.entry !== input.entry) {
    throw new ReceiptError('payment_already_used', `Charge ${charge.signature} already paid for another entry`);
  }
  return { charge, created };
}
