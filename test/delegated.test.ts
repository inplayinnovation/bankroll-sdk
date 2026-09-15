// @vitest-environment node
import { generateKeyPairSync, verify } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalize, delegatedPrivySigner, DelegatedPrivySignerError } from '../src/delegated';
import { PayError } from '../src/payouts';
import { treasuryAddress, treasurySigner } from '../src/treasury';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PKCS8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const PAYEE = 'ServerWa11etAddress1111111111111111111111111';
const WALLET_ID = 'wallet-abc';
const ENV = {
  BANKROLL_PAYEE: PAYEE,
  BANKROLL_DELEGATED_KEY: `wallet-auth:${PKCS8}`,
  BANKROLL_DELEGATED_WALLET_ID: WALLET_ID,
  BANKROLL_PRIVY_APP_ID: 'app-id',
  BANKROLL_API_URL: 'https://api-s.example',
} as const;
const ENV_KEYS = [...Object.keys(ENV), 'BANKROLL_TREASURY_KEY'] as const;

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('delegatedPrivySigner', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
    delete process.env.BANKROLL_TREASURY_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it('is configured, not looked up: the address is the payee', () => {
    expect(delegatedPrivySigner().address).toBe(PAYEE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the Privy request to the relay, signed over the payload Privy verifies', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { method: 'signAndSendTransaction', data: { hash: 'Sig111' } }));
    const before = Date.now();

    const signer = delegatedPrivySigner({ idempotencyKey: 'payout:42' });
    const hash = await signer.sendTransaction('AQ==');

    expect(hash).toBe('Sig111');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api-s.example/api/v1/server-wallets/${WALLET_ID}/rpc`);
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      sponsor: true,
      params: { transaction: 'AQ==', encoding: 'base64' },
    });
    expect(headers['privy-app-id']).toBe('app-id');
    expect(headers['privy-idempotency-key']).toBe('payout:42');
    expect(Number(headers['privy-request-expiry'])).toBeGreaterThanOrEqual(before + 5 * 60_000);
    // The signature is ECDSA P-256 over SHA-256 of the canonical payload —
    // body, app id, idempotency key and expiry at Privy's own URL — by the
    // app's key. This is exactly what the relay, and then Privy, verify.
    const payload = canonicalize({
      version: 1,
      method: 'POST',
      url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
      body,
      headers: {
        'privy-app-id': 'app-id',
        'privy-request-expiry': headers['privy-request-expiry'],
        'privy-idempotency-key': 'payout:42',
      },
    });
    const valid = verify(
      'sha256',
      Buffer.from(payload),
      publicKey,
      Buffer.from(headers['privy-authorization-signature']!, 'base64'),
    );
    expect(valid).toBe(true);
  });

  it('accepts the bare base64 key as well as the wallet-auth form', () => {
    expect(delegatedPrivySigner({ privateKey: PKCS8 }).address).toBe(PAYEE);
  });

  it('refuses a malformed key or missing env at construction', () => {
    expect(() => delegatedPrivySigner({ privateKey: 'nope' })).toThrow(/PKCS8/);
    delete process.env.BANKROLL_DELEGATED_WALLET_ID;
    expect(() => delegatedPrivySigner()).toThrow(/BANKROLL_DELEGATED_WALLET_ID/);
  });

  it("maps a refusal to send_failed — nothing was sent — with Privy's or the relay's reason as the cause", async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { error: 'RPC request denied due to policy violation', code: 'policy_violation' }, 'policy_denied'],
      [401, { code: 'bad_key', error: 'bad_key' }, 'bad_key'],
      [404, { code: 'unknown_wallet', error: 'unknown_wallet' }, 'unknown_wallet'],
      [400, { code: 'bad_request', error: 'bad_request' }, 'relay_error'],
    ];
    for (const [status, body, code] of cases) {
      fetchMock.mockResolvedValueOnce(answer(status, body));
      const error = await delegatedPrivySigner().sendTransaction('AQ==').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PayError);
      expect((error as PayError).code).toBe('send_failed');
      const cause = (error as PayError).cause;
      expect(cause).toBeInstanceOf(DelegatedPrivySignerError);
      expect((cause as DelegatedPrivySignerError).code).toBe(code);
      expect((cause as DelegatedPrivySignerError).status).toBe(status);
    }
  });

  it('reports an unreachable relay, a 5xx, or an answer without a signature as rpc_error — outcome unknown', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(delegatedPrivySigner().sendTransaction('AQ==')).rejects.toMatchObject({ code: 'rpc_error' });
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    await expect(delegatedPrivySigner().sendTransaction('AQ==')).rejects.toMatchObject({ code: 'rpc_error' });
    fetchMock.mockResolvedValueOnce(answer(200, { method: 'signAndSendTransaction', data: {} }));
    await expect(delegatedPrivySigner().sendTransaction('AQ==')).rejects.toMatchObject({ code: 'rpc_error' });
  });

  it('never pre-signs: pay() signs at send time and applies no fence', () => {
    const signer = delegatedPrivySigner();
    expect(signer.signTransaction).toBeUndefined();
  });

  it('is explicit: the treasury helpers ignore the server wallet env', () => {
    expect(treasurySigner()).toBeNull();
    expect(treasuryAddress()).toBeNull();
  });
});

describe('canonicalize', () => {
  it('sorts keys at every depth and emits no whitespace (RFC 8785)', () => {
    expect(canonicalize({ b: 1, a: { d: true, c: 'x' }, e: [3, { z: null, y: 2 }] })).toBe(
      '{"a":{"c":"x","d":true},"b":1,"e":[3,{"y":2,"z":null}]}',
    );
  });
});
