// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  SignJWT,
  base64url,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { verifyToken, type BankrollSession } from '../src/server';

const ALG = 'RS256';
const ISSUER = 'https://joinbankroll.com';
const AUDIENCE = 'https://app.example';
const KID = 'bankroll-token-2026-06';

interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

async function makeSigningKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(ALG);
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { ...publicJwk, kid, alg: ALG, use: 'sig' }, kid };
}

// A real local JWKS server so createRemoteJWKSet's actual fetch path is exercised.
interface JwksServer {
  url: string;
  hits: number;
  close: () => Promise<void>;
}

async function startJwksServer(keys: JWK[]): Promise<JwksServer> {
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    get hits() {
      return state.hits;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface MintOptions {
  key: SigningKey;
  issuer?: string;
  audience?: string;
  subject?: string | null;
  claims?: Record<string, unknown>;
  expiresIn?: string;
  issuedAt?: number;
  omitKid?: boolean;
}

async function mint(options: MintOptions): Promise<string> {
  const jwt = new SignJWT(options.claims ?? {})
    .setProtectedHeader(
      options.omitKid ? { alg: ALG } : { alg: ALG, kid: options.key.kid },
    )
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(options.issuedAt)
    .setExpirationTime(options.expiresIn ?? '15m');
  if (options.subject !== null) jwt.setSubject(options.subject ?? 'wallet-abc');
  return jwt.sign(options.key.privateKey);
}

describe('verifyToken', () => {
  let key: SigningKey;
  let jwks: JwksServer | undefined;

  beforeAll(async () => {
    key = await makeSigningKey(KID);
  });

  afterEach(async () => {
    if (jwks) await jwks.close();
    jwks = undefined;
  });

  async function serve(keys: JWK[] = [key.publicJwk]): Promise<JwksServer> {
    jwks = await startJwksServer(keys);
    return jwks;
  }

  it('accepts a valid token with full claims and returns a complete BankrollSession', async () => {
    const server = await serve();
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await mint({
      key,
      subject: 'wallet-full',
      issuedAt,
      claims: { username: 'player-one', geo: 'US-NY', kyc: { age: 34 } },
    });

    const result = await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url });

    expect(result).not.toBeNull();
    const v = result as BankrollSession;
    expect(v.user.wallet).toBe('wallet-full');
    expect(v.user.username).toBe('player-one');
    expect(v.geo).toBe('US-NY');
    expect(v.user.identity).toEqual({ age: 34 });
    expect(v.aud).toBe(AUDIENCE);
    expect(v.iss).toBe(ISSUER);
    expect(v.iat).toBe(issuedAt);
    expect(typeof v.exp).toBe('number');
    expect(v.exp).toBeGreaterThan(v.iat);
  });

  it('returns only the required fields for a minimal token', async () => {
    const server = await serve();
    const token = await mint({ key, subject: 'wallet-min', claims: { username: 'min-user' } });

    const v = await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url });

    expect(v).not.toBeNull();
    expect(v).toMatchObject({
      aud: AUDIENCE,
      iss: ISSUER,
      user: { wallet: 'wallet-min', username: 'min-user' },
    });
    expect(typeof v!.iat).toBe('number');
    expect(typeof v!.exp).toBe('number');
    expect('geo' in v!).toBe(false);
    expect(v!.user.identity).toBe(false);
  });

  it('rejects a token with no username (the host guarantees one)', async () => {
    const server = await serve();
    const token = await mint({ key, subject: 'wallet-nouser' });
    expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
  });

  describe('security', () => {
    it('rejects a token with the wrong issuer', async () => {
      const server = await serve();
      const token = await mint({ key, issuer: 'https://evil.example.com' });
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it('rejects a token minted for a different audience', async () => {
      const server = await serve();
      const token = await mint({ key, audience: 'https://other.joinbankroll.com' });
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it('rejects an expired token', async () => {
      const server = await serve();
      const token = await mint({ key, expiresIn: '-1m' });
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it("rejects an alg 'none' forged token", async () => {
      const server = await serve();
      const header = base64url.encode(JSON.stringify({ alg: 'none', kid: KID }));
      const body = base64url.encode(
        JSON.stringify({
          iss: ISSUER,
          aud: AUDIENCE,
          sub: 'wallet-forged',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      );
      const token = `${header}.${body}.`;
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it('rejects an HS256 token signed with the RSA public key material as the secret', async () => {
      const server = await serve();
      const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
      const forged = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: KID })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('wallet-hs256')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(secret);
      expect(await verifyToken(forged, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it('rejects structural garbage', async () => {
      const server = await serve();
      expect(await verifyToken('abc', { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
      expect(await verifyToken('a.b.c', { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it('rejects a token with no sub', async () => {
      const server = await serve();
      const token = await mint({ key, subject: null });
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });

    it('rejects a token with an empty-string sub', async () => {
      const server = await serve();
      const token = await mint({ key, subject: '' });
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });
  });

  describe('nullish / blank tokens do not hit the network', () => {
    for (const [label, value] of [
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace', '   '],
    ] as const) {
      it(`returns null for ${label} without fetching the JWKS`, async () => {
        const server = await serve();
        const result = await verifyToken(value, { audience: AUDIENCE, jwksUrl: server.url });
        expect(result).toBeNull();
        expect(server.hits).toBe(0);
      });
    }
  });

  describe('misconfiguration throws', () => {
    it("throws when audience is an empty string", async () => {
      const server = await serve();
      const token = await mint({ key });
      await expect(
        verifyToken(token, { audience: '', jwksUrl: server.url }),
      ).rejects.toThrow('audience is required');
    });

    it('throws when audience is missing', async () => {
      const server = await serve();
      const token = await mint({ key });
      await expect(
        // @ts-expect-error deliberately omitting the required audience
        verifyToken(token, { jwksUrl: server.url }),
      ).rejects.toThrow('audience is required');
    });
  });

  describe('identity wire mapping', () => {
    async function identityOf(claims: Record<string, unknown>): Promise<BankrollSession> {
      const server = await serve();
      const token = await mint({ key, claims: { username: 'wire-user', ...claims } });
      const v = await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url });
      expect(v).not.toBeNull();
      return v as BankrollSession;
    }

    it('maps kyc { age } to identity { age }', async () => {
      const v = await identityOf({ kyc: { age: 34 } });
      expect(v.user.identity).toEqual({ age: 34 });
    });

    it('maps kyc {} to identity {} (approved, no DOB)', async () => {
      const v = await identityOf({ kyc: {} });
      expect(v.user.identity).toEqual({});
      expect(typeof v.user.identity).toBe('object');
    });

    it('maps kyc false to identity false (rejected)', async () => {
      const v = await identityOf({ kyc: false });
      expect(v.user.identity).toBe(false);
    });

    it('defaults identity to false when the claim is absent', async () => {
      const v = await identityOf({});
      expect(v.user.identity).toBe(false);
    });

    it('maps a non-numeric age to {} (approved, unusable age)', async () => {
      const v = await identityOf({ kyc: { age: 'x' } });
      expect(v.user.identity).toEqual({});
    });

    it("prefers the new 'identity' claim over 'kyc' when both are present", async () => {
      const v = await identityOf({ identity: { age: 21 }, kyc: { age: 99 } });
      expect(v.user.identity).toEqual({ age: 21 });
    });

    it("prefers 'identity' false even when kyc says approved", async () => {
      const v = await identityOf({ identity: false, kyc: { age: 30 } });
      expect(v.user.identity).toBe(false);
    });

    it('does not expose unrecognised claims', async () => {
      const v = await identityOf({ su: true, unrecognised: 'x' });
      expect('su' in v).toBe(false);
      expect('unrecognised' in v).toBe(false);
    });
  });

  describe('JWKS key selection', () => {
    it('verifies a token signed by the second key in a multi-kid JWKS', async () => {
      const second = await makeSigningKey('bankroll-token-second');
      const server = await serve([key.publicJwk, second.publicJwk]);
      const token = await mint({
        key: second,
        subject: 'wallet-second',
        claims: { username: 'second-user' },
      });
      const v = await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url });
      expect(v).not.toBeNull();
      expect(v!.user.wallet).toBe('wallet-second');
    });

    it('rejects a token whose signing key is not in the JWKS (unknown kid)', async () => {
      const stranger = await makeSigningKey('bankroll-token-stranger');
      const server = await serve([key.publicJwk]);
      const token = await mint({ key: stranger, subject: 'wallet-stranger' });
      expect(await verifyToken(token, { audience: AUDIENCE, jwksUrl: server.url })).toBeNull();
    });
  });
});
