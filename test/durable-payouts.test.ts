// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingPayout, settlePayout, type PayoutDocument } from '../src/durable-payouts';
import { PayError, type PaymentSigner } from '../src/payouts';
import { fsBackend } from '../src/store/fs';

// Only the chain boundary is mocked; the document and its transitions use a
// real store.
vi.mock('../src/payouts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/payouts')>()),
  buildPayout: vi.fn(),
  sendPayout: vi.fn(),
  confirmPayout: vi.fn(),
}));
vi.mock('../src/references', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/references')>()),
  findPayoutByReference: vi.fn(),
}));

import { buildPayout, confirmPayout, sendPayout } from '../src/payouts';
import { findPayoutByReference } from '../src/references';

const root = await mkdtemp(join(tmpdir(), 'bankroll-durable-'));
const store = fsBackend(root);
const TREASURY = 'Treasury111';
const START = 1_800_000_000_000;
let now = START;
let local = true;
// What a service signer declares; the delegated and Privy signers say 24h.
let replayWindowMs: number | undefined = 24 * 60 * 60_000;
const keys: string[] = [];

const signer = (key: string): PaymentSigner => ({
  address: TREASURY,
  ...(keys.push(key) && {}),
  sendTransaction: async () => `sent:${key}`,
  ...(local
    ? { signTransaction: (transaction: string) => ({ transaction, signature: `signed:${transaction}` }) }
    : replayWindowMs === undefined
      ? {}
      : { replayWindowMs }),
});
const settle = (path: string) => settlePayout(path, { store, signer });
const read = async (path: string) => (await store.readJson<PayoutDocument>(path))!.value.payout!;

let count = 0;
async function obligation(recipients = [{ to: 'alice', amountCents: 180 }], memo?: string): Promise<string> {
  const path = `matches/${++count}.json`;
  await store.writeJson(path, { winner: 'alice', payout: pendingPayout(TREASURY, recipients, memo) });
  return path;
}

beforeEach(() => {
  vi.resetAllMocks();
  now = START;
  local = true;
  replayWindowMs = 24 * 60 * 60_000;
  keys.length = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(buildPayout).mockImplementation(async (input) => ({
    transaction: JSON.stringify(input),
    blockhash: 'blockhash',
    lastValidBlockHeight: 100,
  }));
  vi.mocked(sendPayout).mockImplementation(async (transaction) => ({ signature: `signed:${transaction}` }));
  vi.mocked(confirmPayout).mockResolvedValue();
  vi.mocked(findPayoutByReference).mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rm(root, { recursive: true, force: true }));

describe('settlePayout', () => {
  it('builds, stores the attempt, sends, confirms, and marks the document paid', async () => {
    const path = await obligation();
    const paid = await settle(path);
    expect(paid?.status).toBe('paid');
    expect(paid?.attempt?.signature).toMatch(/^signed:/);
    expect(paid?.attempt?.lastValidBlockHeight).toBe(100);
    expect(buildPayout).toHaveBeenCalledWith(
      { recipients: [{ to: 'alice', amountCents: 180 }], reference: paid!.attempt!.reference },
      { signer: expect.objectContaining({ address: TREASURY }) },
    );
    expect(paid?.attempt).not.toHaveProperty('error');
    expect(confirmPayout).toHaveBeenCalledWith(paid!.attempt!.signature, { lastValidBlockHeight: 100 });
    // The rest of the document is untouched.
    expect((await store.readJson<PayoutDocument>(path))!.value.winner).toBe('alice');
    // Settled means settled: nothing more is built or sent.
    expect((await settle(path))?.status).toBe('paid');
    expect(buildPayout).toHaveBeenCalledTimes(1);
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it('carries the memo and every line, zeros included, into one transaction', async () => {
    const lines = [
      { to: 'loser', amountCents: 0 },
      { to: 'alice', amountCents: 180 },
      { to: 'creator', amountCents: 20 },
    ];
    const path = await obligation(lines, 'payout:match-7');
    const paid = await settle(path);
    expect(paid?.status).toBe('paid');
    expect(paid?.memo).toBe('payout:match-7');
    expect(paid?.recipients).toEqual(lines);
    expect(vi.mocked(buildPayout).mock.calls[0]![0]).toEqual({ recipients: lines, reference: paid!.attempt!.reference, memo: 'payout:match-7' });
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it('is null for a missing document or one that owes nothing', async () => {
    expect(await settle('matches/none.json')).toBeNull();
    await store.writeJson('matches/free.json', { payout: null });
    expect(await settle('matches/free.json')).toBeNull();
  });

  it('refuses a signer for another treasury before building anything', async () => {
    const path = await obligation();
    await expect(
      settlePayout(path, { store, signer: () => ({ address: 'Other111', sendTransaction: async () => 'x' }) }),
    ).rejects.toThrow('Payout treasury changed');
    expect(buildPayout).not.toHaveBeenCalled();
    expect((await read(path)).status).toBe('pending');
  });

  it('stores the signature before send and reconciles a lost reply without sending again', async () => {
    const path = await obligation();
    // Captured inside the send and checked after it: an assertion thrown in
    // here would be swallowed with the send's own failure.
    let storedAtSend: string | null | undefined;
    vi.mocked(sendPayout).mockImplementationOnce(async () => {
      storedAtSend = (await read(path)).attempt?.signature;
      throw new PayError('rpc_error', 'reply lost');
    });
    vi.mocked(confirmPayout).mockRejectedValueOnce(new PayError('confirmation_timeout', 'not yet'));
    const paying = await settle(path);
    expect(paying?.status).toBe('paying');
    // The reason it is still paying is on the record for a screen or an operator.
    expect(paying?.attempt?.error).toBe('confirmation_timeout');
    expect(storedAtSend).toMatch(/^signed:/);
    expect((await settle(path))?.status).toBe('paid');
    expect(sendPayout).toHaveBeenCalledTimes(1);
    expect(buildPayout).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'failed_on_chain'] as const)('creates new bytes after ledger-proven %s', async (code) => {
    const path = await obligation();
    vi.mocked(confirmPayout).mockRejectedValueOnce(new PayError(code, 'no funds moved'));
    expect((await settle(path))?.status).toBe('pending');
    expect((await settle(path))?.status).toBe('paid');
    expect(buildPayout).toHaveBeenCalledTimes(2);
    const first = vi.mocked(buildPayout).mock.calls[0]![0];
    const second = vi.mocked(buildPayout).mock.calls[1]![0];
    expect(first.reference).not.toBe(second.reference);
  });

  it('recovers a service payout by its pre-stored reference', async () => {
    local = false;
    const path = await obligation();
    vi.mocked(sendPayout).mockRejectedValueOnce(new PayError('rpc_error', 'reply lost'));
    const paying = await settle(path);
    expect(paying!.attempt!.reference).toBeTruthy();
    expect(paying!.attempt!.signature).toBeNull();
    expect(paying!.attempt!.lastValidBlockHeight).toBeNull();
    vi.mocked(findPayoutByReference).mockResolvedValueOnce({ signature: 'landed', slot: 1, failed: false });
    expect((await settle(path))?.status).toBe('paid');
    expect(sendPayout).toHaveBeenCalledTimes(1);
    expect(confirmPayout).toHaveBeenCalledWith('landed', undefined);
  });

  it('replays the same service bytes and key only inside its idempotency window', async () => {
    local = false;
    const path = await obligation();
    vi.mocked(sendPayout).mockRejectedValue(new PayError('send_failed', 'unknown previous outcome'));
    await settle(path);
    await settle(path);
    const calls = vi.mocked(sendPayout).mock.calls;
    expect(calls).toHaveLength(2);
    // The same bytes, under a signer made with the same idempotency key.
    expect(calls[1]![0]).toBe(calls[0]![0]);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    // Past the margin but inside the window: no resend, the attempt waits.
    now = START + 23 * 60 * 60_000 + 1;
    expect((await settle(path))?.status).toBe('paying');
    expect(sendPayout).toHaveBeenCalledTimes(2);
    expect(buildPayout).toHaveBeenCalledTimes(1);
  });

  it('never resends blind for a service signer that declares no replay window', async () => {
    local = false;
    replayWindowMs = undefined;
    const path = await obligation();
    vi.mocked(sendPayout).mockRejectedValue(new PayError('rpc_error', 'reply lost'));
    const first = await settle(path);
    expect(first?.status).toBe('paying');
    expect(first?.attempt?.error).toBe('rpc_error');
    expect((await settle(path))?.status).toBe('paying');
    expect(sendPayout).toHaveBeenCalledTimes(1);
    // Recovery still works by reference.
    vi.mocked(findPayoutByReference).mockResolvedValueOnce({ signature: 'landed', slot: 1, failed: false });
    expect((await settle(path))?.status).toBe('paid');
  });

  it.each([
    ['declares a 24h replay window', 24 * 60 * 60_000, 24 * 60 * 60_000],
    ['declares no replay window', undefined, 60 * 60_000],
  ])('abandons an attempt that %s once nothing has landed and nothing more can, then pays fresh', async (_label, window, deadAfter) => {
    local = false;
    replayWindowMs = window;
    const path = await obligation();
    vi.mocked(sendPayout).mockRejectedValue(new PayError('rpc_error', 'reply lost'));
    const paying = await settle(path);
    const firstReference = paying!.attempt!.reference;
    // Still inside the time it could land: a clean lookup that finds nothing changes nothing.
    now = START + deadAfter - 1;
    expect((await settle(path))?.attempt?.reference).toBe(firstReference);
    // A failed lookup is not a negative answer, even later.
    now = START + deadAfter;
    vi.mocked(findPayoutByReference).mockRejectedValueOnce(new PayError('rpc_error', 'cannot read the chain'));
    expect((await settle(path))?.attempt?.reference).toBe(firstReference);
    // Past that time, an empty ledger is proof: the attempt is abandoned and new bytes are built.
    expect((await settle(path))?.status).toBe('pending');
    vi.mocked(sendPayout).mockImplementation(async (transaction) => ({ signature: `signed:${transaction}` }));
    const paid = await settle(path);
    expect(paid?.status).toBe('paid');
    expect(paid?.attempt?.reference).not.toBe(firstReference);
    expect(buildPayout).toHaveBeenCalledTimes(2);
  });

  it('accepts a signer factory that resolves asynchronously', async () => {
    const path = await obligation();
    const paid = await settlePayout(path, { store, signer: async (key) => signer(key) });
    expect(paid?.status).toBe('paid');
    expect(new Set(keys).size).toBe(1);
  });

  it('lets exactly one of two racing settlers broadcast', async () => {
    const path = await obligation();
    const results = await Promise.all([settle(path), settle(path)]);
    // Both built; only the swap's winner sent. The loser reports whatever
    // state it read back, which may already be paid.
    for (const payout of results) expect(['paying', 'paid']).toContain(payout?.status);
    expect(buildPayout).toHaveBeenCalledTimes(2);
    expect(sendPayout).toHaveBeenCalledTimes(1);
    expect((await read(path)).status).toBe('paid');
  });
});
