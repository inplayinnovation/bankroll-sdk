// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';

import bs58 from 'bs58';
import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appAddress, loadAppKey, signAppToken } from '../src/app-auth';

function fixtureKey() {
  const keys = generateKeyPairSync('ed25519');
  const jwk = keys.privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d!, 'base64url');
  const publicBytes = Buffer.from(jwk.x!, 'base64url');
  return { ...keys, seed, publicBytes, address: bs58.encode(publicBytes), secret: bs58.encode(Buffer.concat([seed, publicBytes])) };
}
const first = fixtureKey();
const second = fixtureKey();

beforeEach(() => {
  vi.stubEnv('BANKROLL_APP_KEY', undefined);
  vi.stubEnv('BANKROLL_PUSH_KEY', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('app key selection', () => {
  it('returns null when unconfigured, even with a treasury key', () => {
    vi.stubEnv('BANKROLL_TREASURY_KEY', first.secret);
    expect(loadAppKey()).toBeNull();
    expect(appAddress()).toBeNull();
  });

  it('selects explicit, app, then legacy push credentials', () => {
    vi.stubEnv('BANKROLL_PUSH_KEY', first.secret);
    expect(appAddress()).toBe(first.address);
    vi.stubEnv('BANKROLL_APP_KEY', second.secret);
    expect(appAddress()).toBe(second.address);
    expect(loadAppKey(first.secret)?.address).toBe(first.address);
  });

  it.each([
    '',
    'invalid-secret-containing-0',
    bs58.encode(first.seed),
    bs58.encode(Buffer.concat([first.seed, second.publicBytes])),
  ])('rejects malformed selected credentials without exposing them or falling back', (secret) => {
    vi.stubEnv('BANKROLL_PUSH_KEY', first.secret);
    vi.stubEnv('BANKROLL_APP_KEY', secret);
    expect(() => loadAppKey()).toThrow('Invalid app key:');
    vi.stubEnv('BANKROLL_APP_KEY', first.secret);
    try {
      loadAppKey(secret);
      throw new Error('accepted malformed key');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^Invalid app key:/);
      if (secret) expect((error as Error).message).not.toContain(secret);
    }
  });

  it('updates both the address and signer after rotation', async () => {
    vi.stubEnv('BANKROLL_APP_KEY', first.secret);
    const old = loadAppKey()!;
    vi.stubEnv('BANKROLL_APP_KEY', second.secret);
    const current = loadAppKey()!;
    expect(current.address).toBe(second.address);
    const token = await signAppToken('https://app.example', current.key);
    await expect(jwtVerify(token, second.publicKey)).resolves.toBeDefined();
    await expect(jwtVerify(token, first.publicKey)).rejects.toThrow();
    expect(old.address).toBe(first.address);
    vi.stubEnv('BANKROLL_APP_KEY', undefined);
    expect(loadAppKey()).toBeNull();
  });
});

describe('signAppToken', () => {
  it('signs identity-only claims with the shared purpose and an exact 60s lifetime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
    const token = await signAppToken('https://app.example', first.privateKey);
    const { protectedHeader, payload } = await jwtVerify(token, first.publicKey, {
      issuer: 'https://app.example', audience: 'bankroll-api',
    });
    expect(protectedHeader).toEqual({ alg: 'EdDSA', typ: 'bankroll-app-auth+jwt' });
    const now = Math.floor(Date.now() / 1000);
    expect(payload).toEqual({ iss: 'https://app.example', aud: 'bankroll-api', iat: now, exp: now + 60 });
  });
});
