// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';

import bs58 from 'bs58';
import { importJWK, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PushError, pushAddress, notifyAudience, notifyUser } from '../src/push';

// A Solana-style 64-byte secret: seed followed by public key.
const keys = generateKeyPairSync('ed25519');
const jwk = keys.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
const seed = Buffer.from(jwk.d, 'base64url');
const publicKey = Buffer.from(jwk.x, 'base64url');
const SECRET = bs58.encode(Buffer.concat([seed, publicKey]));
const ADDRESS = bs58.encode(publicKey);

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const INPUT = {
  body: 'Your match is ready.',
  origin: 'https://acme.example',
  title: 'Match ready',
  to: 'J6L33Wi7hVEnBnBM8dpTgD8FfDDGgDFVKnfLLQZ1Ptvi',
};

const BROADCAST_INPUT = {
  body: 'Season two is live.',
  origin: INPUT.origin,
  title: 'New season',
};

beforeEach(() => {
  delete process.env.BANKROLL_APP_KEY;
  process.env.BANKROLL_PUSH_KEY = SECRET;
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  delete process.env.BANKROLL_APP_KEY;
  vi.useRealTimers();
  delete process.env.BANKROLL_PUSH_KEY;
  delete process.env.BANKROLL_API_URL;
  vi.clearAllMocks();
});

describe('pushAddress', () => {
  it('derives the public key from the secret, and is null unset', () => {
    expect(pushAddress()).toBe(ADDRESS);
    delete process.env.BANKROLL_PUSH_KEY;
    expect(pushAddress()).toBeNull();
  });
});

describe('notifyUser', () => {
  it('POSTs a signed request JWT the app key verifies', async () => {
    await notifyUser({ ...INPUT, path: '/match/9' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.joinbankroll.com/api/push');
    expect(init.headers).toEqual({ 'content-type': 'application/jwt' });

    const key = await importJWK({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(init.body as string, key, {
      audience: 'bankroll-push',
      issuer: INPUT.origin,
    });
    expect(protectedHeader).toEqual({ alg: 'EdDSA', typ: 'bankroll-push+jwt' });
    expect(payload).toMatchObject({
      body: INPUT.body,
      path: '/match/9',
      sub: INPUT.to,
      title: INPUT.title,
    });
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });

  it('honors BANKROLL_API_URL for staging', async () => {
    process.env.BANKROLL_API_URL = 'https://api.example';
    await notifyUser(INPUT);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://api.example/api/push',
    );
  });

  it('maps a refusal to PushError with the server code', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'not_your_user' }),
    });
    await expect(notifyUser(INPUT)).rejects.toMatchObject({
      code: 'not_your_user',
      name: 'PushError',
    });
    await expect(
      notifyUser(INPUT).catch((e: unknown) => e instanceof PushError),
    ).resolves.toBe(true);
  });

  it('fails fast on missing key and empty text', async () => {
    await expect(notifyUser({ ...INPUT, title: '  ' })).rejects.toThrow(/title/);
    await expect(notifyUser({ ...INPUT, body: '' })).rejects.toThrow(/body/);

    delete process.env.BANKROLL_PUSH_KEY;
    await expect(notifyUser(INPUT)).rejects.toThrow(/BANKROLL_PUSH_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('notifyAudience', () => {
  it('POSTs a signed broadcast JWT with no sub', async () => {
    await notifyAudience({ ...BROADCAST_INPUT, path: '/season/2' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.joinbankroll.com/api/push/broadcast');
    expect(init.headers).toEqual({ 'content-type': 'application/jwt' });

    const key = await importJWK({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(init.body as string, key, {
      audience: 'bankroll-push',
      issuer: BROADCAST_INPUT.origin,
    });
    expect(protectedHeader).toEqual({
      alg: 'EdDSA',
      typ: 'bankroll-push-broadcast+jwt',
    });
    expect(payload).toMatchObject({
      body: BROADCAST_INPUT.body,
      path: '/season/2',
      title: BROADCAST_INPUT.title,
    });
    expect(payload.sub).toBeUndefined();
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });

  it('maps a refusal to PushError with the server code', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'broadcast_not_configured' }),
    });
    await expect(notifyAudience(BROADCAST_INPUT)).rejects.toMatchObject({
      code: 'broadcast_not_configured',
      name: 'PushError',
    });
  });
});

const sharedKeys = generateKeyPairSync('ed25519');
const sharedJwk = sharedKeys.privateKey.export({ format: 'jwk' });
const SHARED_SECRET = bs58.encode(Buffer.concat([
  Buffer.from(sharedJwk.d!, 'base64url'), Buffer.from(sharedJwk.x!, 'base64url'),
]));

describe('push with shared app authentication', () => {
  it.each([
    {
      name: 'unicast', path: '/api/push',
      send: () => notifyUser({ ...INPUT, title: '  Match ready  ', path: '/match/9' }),
      body: { to: INPUT.to, title: INPUT.title, body: INPUT.body, path: '/match/9' },
    },
    {
      name: 'broadcast', path: '/api/push/broadcast',
      send: () => notifyAudience({ ...BROADCAST_INPUT, body: ' Season two is live. ' }),
      body: { title: BROADCAST_INPUT.title, body: BROADCAST_INPUT.body },
    },
  ])('sends $name as JSON with a fresh identity-only Bearer token', async ({ send, path, body }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
    process.env.BANKROLL_APP_KEY = SHARED_SECRET;
    process.env.BANKROLL_API_URL = 'https://api.example';
    expect(pushAddress()).toBe(bs58.encode(Buffer.from(sharedJwk.x!, 'base64url')));
    for (let i = 0; i < 2; i++) {
      await send();
      const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
      expect(url).toBe(`https://api.example${path}`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(body);
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBe('application/json');
      const authorization = headers.get('authorization');
      expect(authorization).toMatch(/^Bearer /);
      const token = authorization!.slice(7);
      const { payload, protectedHeader } = await jwtVerify(token, sharedKeys.publicKey, {
        issuer: INPUT.origin, audience: 'bankroll-api',
      });
      expect(protectedHeader).toEqual({ alg: 'EdDSA', typ: 'bankroll-app-auth+jwt' });
      const now = Math.floor(Date.now() / 1000);
      expect(payload).toEqual({ iss: INPUT.origin, aud: 'bankroll-api', iat: now, exp: now + 60 });
      await expect(jwtVerify(token, keys.publicKey)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 61_000);
    }
  });

  it('signs with the new app key after rotation', async () => {
    process.env.BANKROLL_APP_KEY = SECRET;
    await notifyUser(INPUT);
    process.env.BANKROLL_APP_KEY = SHARED_SECRET;
    await notifyAudience(BROADCAST_INPUT);
    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    const token = new Headers(init.headers).get('authorization')!.slice(7);
    await expect(jwtVerify(token, sharedKeys.publicKey)).resolves.toBeDefined();
    await expect(jwtVerify(token, keys.publicKey)).rejects.toThrow();
  });

  it.each(['', 'not-a-base58-key', bs58.encode(Buffer.concat([
    seed, Buffer.from(sharedJwk.x!, 'base64url'),
  ]))])('rejects an invalid app key instead of using the configured legacy key', async (secret) => {
    process.env.BANKROLL_APP_KEY = secret;
    await expect(notifyUser(INPUT)).rejects.toThrow(/^Invalid app key:/);
    await expect(notifyAudience(BROADCAST_INPUT)).rejects.toThrow(/^Invalid app key:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves generic auth errors and never retries through legacy push', async () => {
    process.env.BANKROLL_APP_KEY = SHARED_SECRET;
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'app_not_verified' }) });
    await expect(notifyUser(INPUT)).rejects.toMatchObject({ name: 'PushError', code: 'app_not_verified' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).has('authorization')).toBe(true);
  });
});
