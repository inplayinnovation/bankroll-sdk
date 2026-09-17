// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmedCharge } from '../src/charges';
import { claimCharge, ReceiptError, receiptPath } from '../src/receipts';
import { fsBackend } from '../src/store/fs';

vi.mock('../src/charges', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/charges')>()),
  confirmCharge: vi.fn(),
}));
vi.mock('../src/references', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/references')>()),
  findChargeByReference: vi.fn(),
}));

import { confirmCharge } from '../src/charges';
import { findChargeByReference } from '../src/references';

const root = await mkdtemp(join(tmpdir(), 'bankroll-receipts-'));
const store = fsBackend(root);

const expected = { payer: 'alice', payee: 'Treasury111', mint: 'Mint111', amountCents: 100, memo: 'entry:1' };
const charge = (signature: string, over: Partial<ConfirmedCharge> = {}): ConfirmedCharge =>
  ({ signature, ...expected, slot: 1, ...over }) as ConfirmedCharge;

beforeEach(() => {
  vi.resetAllMocks();
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('claimCharge', () => {
  it('confirms a reported charge, writes its receipt, and returns it on every repeat', async () => {
    vi.mocked(confirmCharge).mockResolvedValue(charge('sig-1'));
    const first = await claimCharge({ store, entry: 'e1', reference: 'ref-1', signature: 'sig-1', expected });
    expect(first).toEqual({ charge: charge('sig-1'), created: true });
    expect((await store.readJson(receiptPath('alice', 'sig-1')))?.value).toEqual({ entry: 'e1', charge: charge('sig-1') });
    // A crash after the receipt and before the entry's own write: repeating is harmless.
    const again = await claimCharge({ store, entry: 'e1', reference: 'ref-1', signature: 'sig-1', expected });
    expect(again).toEqual({ charge: charge('sig-1'), created: false });
    expect(findChargeByReference).not.toHaveBeenCalled();
  });

  it('recovers by reference when no signature was reported, with the same checks', async () => {
    vi.mocked(findChargeByReference).mockResolvedValueOnce(null);
    expect(await claimCharge({ store, entry: 'e2', reference: 'ref-2', expected })).toBeNull();
    vi.mocked(findChargeByReference).mockResolvedValueOnce(charge('sig-2'));
    expect((await claimCharge({ store, entry: 'e2', reference: 'ref-2', expected }))?.charge.signature).toBe('sig-2');
    expect(findChargeByReference).toHaveBeenCalledWith('ref-2', undefined);
    expect(confirmCharge).not.toHaveBeenCalled();
  });

  const mismatches: [string, Partial<ConfirmedCharge>][] = [
    ['payee', { payee: 'Other111' }],
    ['payer', { payer: 'mallory' }],
    ['mint', { mint: 'AppToken111' }],
    ['amountCents', { amountCents: 99 }],
    ['memo', { memo: 'entry:9' }],
    ['memo', { memo: null }],
  ];

  it.each(mismatches)('refuses a reported charge whose %s differs, naming the field, writing no receipt', async (field, over) => {
    vi.mocked(confirmCharge).mockResolvedValue(charge('sig-3', over));
    await expect(claimCharge({ store, entry: 'e3', reference: 'ref-3', signature: 'sig-3', expected })).rejects.toMatchObject({
      code: 'payment_mismatch',
      field,
    });
    expect(await store.readJson(receiptPath(expected.payer, 'sig-3'))).toBeNull();
  });

  it.each(mismatches)('refuses a recovered charge whose %s differs, with the same checks', async (field, over) => {
    vi.mocked(findChargeByReference).mockResolvedValue(charge('sig-3r', over));
    await expect(claimCharge({ store, entry: 'e3', reference: 'ref-3', expected })).rejects.toMatchObject({
      code: 'payment_mismatch',
      field,
    });
    expect(await store.readJson(receiptPath(expected.payer, 'sig-3r'))).toBeNull();
  });

  it('does not compare the memo when the terms leave it out', async () => {
    const { memo: _memo, ...noMemoCheck } = expected;
    vi.mocked(confirmCharge).mockResolvedValue(charge('sig-u', { memo: 'whatever' }));
    expect((await claimCharge({ store, entry: 'u', reference: 'ref-u', signature: 'sig-u', expected: noMemoCheck }))?.created).toBe(true);
  });

  it('treats a null memo as "no memo", not "any memo"', async () => {
    const noMemo = { ...expected, memo: null };
    vi.mocked(confirmCharge).mockResolvedValue(charge('sig-m1', { memo: 'entry:1' }));
    await expect(claimCharge({ store, entry: 'm', reference: 'ref-m', signature: 'sig-m1', expected: noMemo })).rejects.toMatchObject({
      code: 'payment_mismatch',
    });
    vi.mocked(confirmCharge).mockResolvedValue(charge('sig-m2', { memo: null }));
    expect((await claimCharge({ store, entry: 'm', reference: 'ref-m', signature: 'sig-m2', expected: noMemo }))?.charge.signature).toBe('sig-m2');
  });

  it('assigns one signature to one entry, whichever claim races in first', async () => {
    vi.mocked(confirmCharge).mockResolvedValue(charge('sig-4'));
    const results = await Promise.allSettled([
      claimCharge({ store, entry: 'a', reference: 'ref-a', signature: 'sig-4', expected }),
      claimCharge({ store, entry: 'b', reference: 'ref-b', signature: 'sig-4', expected }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ReceiptError);
    expect(failure.reason).toMatchObject({ code: 'payment_already_used' });
  });

  it('refuses an empty, oversized, or non-string reported signature before touching the chain', async () => {
    for (const signature of ['', 'x'.repeat(2_001), 123, { sig: 'x' }]) {
      await expect(
        claimCharge({ store, entry: 'e5', reference: 'ref-5', signature: signature as never, expected }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    }
    expect(confirmCharge).not.toHaveBeenCalled();
    expect(findChargeByReference).not.toHaveBeenCalled();
  });
});
