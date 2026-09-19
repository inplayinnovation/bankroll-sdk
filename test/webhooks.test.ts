// @vitest-environment node
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBuiltPayout, mockHostScript, mockPayoutSigner, MOCK_WALLET } from '../src/mock';
import { sendPayout } from '../src/payouts';
import { createManagedReference } from '../src/references';
import { createTimer } from '../src/timers';
import { bankrollWebhook, referenceWebhook, WEBHOOK_PATH, type ReferenceConfirmed, type ReferenceExpired, type TimerFired } from '../src/webhooks';

const ORIGIN = 'https://game.example';
const META = { entryId: 'entry-1', side: 'payin' };
const REFERENCE = 'GgRva3ZaFuqDDVxr8CDsFcSf7ETNqQFJRhc4Y5nqsFhk';
const SIGNATURE = '4Yq7bBLvV3nUoxEqKTGJ4QtbrsyybkXMtNAdRmFyLoLD1PgFqRkkMbtc1UJzumxsNwR6Rg7NdcnFzdJDHc1qsEuh';
const SECRET_BYTES = Buffer.from('a-secret-bankroll-hands-out-at-signing');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const PAYEE = 'uhpn1gHscLtCv1vkLSjYNNFXpZyJnGz1ynXWM9WaD7X';
const fetchMock = vi.fn<typeof fetch>();

const confirmed: ReferenceConfirmed = {
  type: 'reference.confirmed',
  reference: REFERENCE,
  meta: META,
  signature: SIGNATURE,
  slot: 371_204_118,
};
const expired: ReferenceExpired = {
  type: 'reference.expired',
  reference: REFERENCE,
  meta: META,
  expiredAt: '2026-09-18T18:07:00.000Z',
};

// A delivery signed the way Bankroll signs one.
function signed(body: string, options: { secret?: string; timestamp?: number; signatures?: string[] } = {}): Request {
  const id = 'msg_test';
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const key = Buffer.from((options.secret ?? SECRET).slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return new Request(`${ORIGIN}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': (options.signatures ?? [`v1,${signature}`]).join(' '),
    },
    body,
  });
}

const unsigned = (body: string) =>
  new Request(`${ORIGIN}${WEBHOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

const handlers = () => ({ onConfirmed: vi.fn(), onExpired: vi.fn(), onFired: vi.fn() });
const fired: TimerFired = { type: 'timer.fired', id: '8412', meta: { kind: 'deadline', id: 'round-1' }, at: '2026-09-18T18:07:00.000Z' };

function hostFrom(script: string) {
  const fakeWindow: { bankroll?: Record<string, (input?: unknown) => Promise<unknown>> } = {};
  new Function('window', 'btoa', 'unescape', 'encodeURIComponent', script)(
    fakeWindow,
    (value: string) => Buffer.from(value, 'binary').toString('base64'),
    unescape,
    encodeURIComponent,
  );
  if (!fakeWindow.bankroll) throw new Error('script did not define window.bankroll');
  return fakeWindow.bankroll;
}

beforeEach(() => {
  vi.stubEnv('BANKROLL_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('BANKROLL_MOCK', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({ received: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('referenceWebhook', () => {
  it('verifies the signature and hands each event to its handler', async () => {
    const handled = handlers();
    const route = referenceWebhook(handled);

    const first = await route(signed(JSON.stringify(confirmed)));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(handled.onConfirmed).toHaveBeenCalledWith(confirmed);
    expect(handled.onExpired).not.toHaveBeenCalled();

    const second = await route(signed(JSON.stringify(expired)));
    expect(second.status).toBe(200);
    expect(handled.onExpired).toHaveBeenCalledWith(expired);
  });

  it('accepts any of the signatures a rotation carries, and an explicit secret', async () => {
    const handled = handlers();
    const body = JSON.stringify(confirmed);
    const bad = `v1,${Buffer.alloc(32, 1).toString('base64')}`;
    const good = `v1,${createHmac('sha256', SECRET_BYTES).update(`msg_test.${Math.floor(Date.now() / 1000)}.${body}`).digest('base64')}`;
    expect((await referenceWebhook(handled)(signed(body, { signatures: [bad, good] }))).status).toBe(200);

    vi.stubEnv('BANKROLL_WEBHOOK_SECRET', undefined);
    expect((await referenceWebhook({ ...handled, secret: SECRET })(signed(body))).status).toBe(200);
    expect(handled.onConfirmed).toHaveBeenCalledTimes(2);
  });

  it('refuses a wrong signature, a stale timestamp, and an unsigned delivery outside the mock', async () => {
    const handled = handlers();
    const route = referenceWebhook(handled);
    const body = JSON.stringify(confirmed);

    const wrong = await route(signed(body, { secret: `whsec_${Buffer.from('another').toString('base64')}` }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'invalid_signature' });
    expect((await route(signed(body, { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 }))).status).toBe(401);
    expect((await route(unsigned(body))).status).toBe(401);
    expect(handled.onConfirmed).not.toHaveBeenCalled();
  });

  it('fails loudly without a secret, refuses a body it cannot read, and lets a handler failure propagate', async () => {
    const body = JSON.stringify(confirmed);
    vi.stubEnv('BANKROLL_WEBHOOK_SECRET', undefined);
    await expect(referenceWebhook(handlers())(signed(body))).rejects.toThrow(/BANKROLL_WEBHOOK_SECRET/);
    vi.stubEnv('BANKROLL_WEBHOOK_SECRET', SECRET);

    for (const bad of [
      '{not json',
      JSON.stringify({ type: 'reference.confirmed', reference: REFERENCE }),
      JSON.stringify({ ...confirmed, type: 'reference.vanished' }),
    ]) {
      expect((await referenceWebhook(handlers())(signed(bad))).status).toBe(400);
    }

    const failing = { ...handlers(), onConfirmed: vi.fn().mockRejectedValue(new Error('store away')) };
    await expect(referenceWebhook(failing)(signed(body))).rejects.toThrow('store away');
  });
});

describe('bankrollWebhook and timers', () => {
  it('hands a timer.fired to onFired, and acknowledges it when there is no onFired', async () => {
    const handled = handlers();
    expect((await bankrollWebhook(handled)(signed(JSON.stringify(fired)))).status).toBe(200);
    expect(handled.onFired).toHaveBeenCalledWith(fired);
    expect(handled.onConfirmed).not.toHaveBeenCalled();

    const { onFired: _none, ...without } = handled;
    expect((await bankrollWebhook(without)(signed(JSON.stringify(fired)))).status).toBe(200);
    expect((await bankrollWebhook(without)(signed(JSON.stringify({ ...fired, at: 7 })))).status).toBe(400);
  });

  it('is the 0.28 name too', () => {
    expect(referenceWebhook).toBe(bankrollWebhook);
  });
});

describe('under the mock', () => {
  beforeEach(() => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    vi.stubEnv('PORT', '4242');
  });

  it('accepts an unsigned delivery and fills the meta in from the reference', async () => {
    const created = await createManagedReference({ meta: META }, { origin: ORIGIN });
    const handled = handlers();

    const response = await referenceWebhook(handled)(
      unsigned(JSON.stringify({ type: 'reference.confirmed', reference: created.reference, signature: 'mock-sig', slot: 7 })),
    );

    expect(response.status).toBe(200);
    expect(handled.onConfirmed).toHaveBeenCalledWith({
      type: 'reference.confirmed',
      reference: created.reference,
      meta: META,
      signature: 'mock-sig',
      slot: 7,
    });
  });

  it("the mock host's pay() delivers reference.confirmed to the route before answering the signature", async () => {
    const created = await createManagedReference({ meta: META }, { origin: ORIGIN });
    const host = hostFrom(mockHostScript({ payee: PAYEE }));

    const signature = (await host.pay!({ amountCents: 500, reference: created.reference })) as string;

    expect(signature.startsWith('mock-')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEBHOOK_PATH);
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init!.body as string)).toEqual({
      type: 'reference.confirmed',
      reference: created.reference,
      signature,
      slot: expect.any(Number),
    });

    fetchMock.mockClear();
    await host.pay!({ amountCents: 500 });
    await host.pay!({ amountCents: 500, reference: REFERENCE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a mock payout carrying the reference delivers reference.confirmed to the dev server', async () => {
    const created = await createManagedReference({ meta: META }, { origin: ORIGIN });
    const signer = mockPayoutSigner(PAYEE);
    const built = mockBuiltPayout({ to: MOCK_WALLET, amountCents: 900, reference: created.reference });

    const { signature } = await sendPayout(built.transaction, { signer });

    expect(signature.startsWith('mock-payout-')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:4242${WEBHOOK_PATH}`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ type: 'reference.confirmed', reference: created.reference, signature });

    fetchMock.mockClear();
    await sendPayout(mockBuiltPayout({ to: MOCK_WALLET, amountCents: 900 }).transaction, { signer });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers the same signature for the same payout bytes, so a resend learns what it sent', async () => {
    const signer = mockPayoutSigner(PAYEE);
    const built = mockBuiltPayout({ to: MOCK_WALLET, amountCents: 900 });
    const first = await sendPayout(built.transaction, { signer });
    const second = await sendPayout(built.transaction, { signer });
    expect(second.signature).toBe(first.signature);
    expect((await sendPayout(mockBuiltPayout({ to: MOCK_WALLET, amountCents: 901 }).transaction, { signer })).signature).not.toBe(first.signature);
  });

  it("says out loud when the route refuses the mock host's delivery", async () => {
    const created = await createManagedReference({ meta: META }, { origin: ORIGIN });
    const host = hostFrom(mockHostScript({ payee: PAYEE }));
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_event' }, { status: 500 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await host.pay!({ amountCents: 500, reference: created.reference });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('answered 500'));
    error.mockRestore();
  });

  it('delivers timer.fired to the dev server when the timer fires, and the route fills the meta in', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-18T18:00:00.000Z') });
    const created = await createTimer({ meta: { kind: 'deadline', id: 'round-1' }, firesInMinutes: 1 }, { origin: ORIGIN });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:4242${WEBHOOK_PATH}`);
    const body = init!.body as string;
    expect(JSON.parse(body)).toEqual({ type: 'timer.fired', id: created.id, at: '2026-09-18T18:01:00.000Z' });

    const handled = handlers();
    expect((await bankrollWebhook(handled)(unsigned(body))).status).toBe(200);
    expect(handled.onFired).toHaveBeenCalledWith({ type: 'timer.fired', id: created.id, meta: { kind: 'deadline', id: 'round-1' }, at: '2026-09-18T18:01:00.000Z' });
  });

  it('delivers reference.expired when the window ends, unless the route was told first', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-18T18:00:00.000Z') });
    const silent = await createManagedReference({ meta: META, expiresInSeconds: 60 }, { origin: ORIGIN });
    const paid = await createManagedReference({ meta: { entryId: 'entry-2' }, expiresInSeconds: 60 }, { origin: ORIGIN });
    await referenceWebhook(handlers())(
      unsigned(JSON.stringify({ type: 'reference.confirmed', reference: paid.reference, signature: 'mock-sig', slot: 1 })),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:4242${WEBHOOK_PATH}`);
    expect(JSON.parse(init!.body as string)).toEqual({
      type: 'reference.expired',
      reference: silent.reference,
      expiredAt: '2026-09-18T18:01:00.000Z',
    });
  });
});
