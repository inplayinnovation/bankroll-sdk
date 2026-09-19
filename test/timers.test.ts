// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';

import bs58 from 'bs58';
import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMockTimer } from '../src/mock';
import { createTimer, TimerError } from '../src/timers';

const keys = generateKeyPairSync('ed25519');
const jwk = keys.privateKey.export({ format: 'jwk' });
const appSecret = bs58.encode(Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')]));
const ORIGIN = 'https://game.example';
const META = { kind: 'deadline', wallet: 'Wallet111', id: 'round-1' };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('BANKROLL_APP_KEY', appSecret);
  vi.stubEnv('BANKROLL_PUSH_KEY', undefined);
  vi.stubEnv('BANKROLL_API_URL', undefined);
  vi.stubEnv('BANKROLL_MOCK', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({ id: '8412', at: '2026-09-18T18:07:00.000Z' }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createTimer', () => {
  it('asks Bankroll under the app credential and hands back the timer', async () => {
    const created = await createTimer({ meta: META, firesInMinutes: 5 }, { origin: ORIGIN });

    expect(created).toEqual({ id: '8412', at: '2026-09-18T18:07:00.000Z' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.joinbankroll.com/api/v1/timers');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(init!.body as string)).toEqual({ meta: META, firesInMinutes: 5 });
    const token = new Headers(init!.headers).get('authorization')!.slice('Bearer '.length);
    const { payload } = await jwtVerify(token, keys.publicKey, { issuer: ORIGIN, audience: 'bankroll-api' });
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it.each([
    ['a meta that is not an object', { meta: [1] as never, firesInMinutes: 1 }],
    ['a non-finite number in the meta', { meta: { n: Number.NaN }, firesInMinutes: 1 }],
    ['no minutes', { meta: META, firesInMinutes: 0 }],
    ['fractional minutes', { meta: META, firesInMinutes: 1.5 }],
  ])('refuses %s before calling Bankroll', async (_label, input) => {
    await expect(createTimer(input, { origin: ORIGIN })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'app_not_verified'],
    [409, 'webhook_not_provisioned'],
    [400, 'invalid_argument'],
  ])("maps Bankroll's %s %s refusal", async (status, code) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: code }, { status }));
    const error = await createTimer({ meta: META, firesInMinutes: 1 }, { origin: ORIGIN }).catch((e) => e);
    expect(error).toBeInstanceOf(TimerError);
    expect(error).toMatchObject({ code, status });
  });

  it('says unavailable when Bankroll cannot be reached and invalid_response for a reply it cannot read', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(createTimer({ meta: META, firesInMinutes: 1 }, { origin: ORIGIN })).rejects.toMatchObject({ code: 'unavailable' });
    fetchMock.mockResolvedValueOnce(Response.json({ id: 8412 }));
    await expect(createTimer({ meta: META, firesInMinutes: 1 }, { origin: ORIGIN })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('under the mock sets the timer locally, carrying the meta and the time, and calls no one', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    vi.useFakeTimers({ now: new Date('2026-09-18T18:00:00.000Z') });
    const created = await createTimer({ meta: META, firesInMinutes: 1 }, { origin: ORIGIN });

    expect(created.at).toBe('2026-09-18T18:01:00.000Z');
    expect(parseMockTimer(created.id)).toEqual({ meta: META, at: '2026-09-18T18:01:00.000Z' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
