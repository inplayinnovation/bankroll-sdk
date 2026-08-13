// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';

import bs58 from 'bs58';
import { importJWK, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PushError, pushAddress, sendPush } from '../src/push';

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

beforeEach(() => {
  process.env.BANKROLL_PUSH_KEY = SECRET;
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
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

describe('sendPush', () => {
  it('POSTs a signed request JWT the app key verifies', async () => {
    await sendPush({ ...INPUT, path: '/match/9' });

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
    await sendPush(INPUT);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://api.example/api/push',
    );
  });

  it('maps a refusal to PushError with the server code', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'not_your_user' }),
    });
    await expect(sendPush(INPUT)).rejects.toMatchObject({
      code: 'not_your_user',
      name: 'PushError',
    });
    await expect(
      sendPush(INPUT).catch((e: unknown) => e instanceof PushError),
    ).resolves.toBe(true);
  });

  it('fails fast on missing key and empty text', async () => {
    await expect(sendPush({ ...INPUT, title: '  ' })).rejects.toThrow(/title/);
    await expect(sendPush({ ...INPUT, body: '' })).rejects.toThrow(/body/);

    delete process.env.BANKROLL_PUSH_KEY;
    await expect(sendPush(INPUT)).rejects.toThrow(/BANKROLL_PUSH_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
