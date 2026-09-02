// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmCharge, ConfirmChargeError } from '../src/charges';
import { BANKROLL_TOKEN_HEADER } from '../src/constants';
import {
  isMockSignature,
  MOCK_WALLET,
  mockEnabled,
  mockHostScript,
  mockSession,
  mockToken,
  parseMockSignature,
} from '../src/mock';
import { getSession } from '../src/next';
import { findChargeByReference } from '../src/references';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'app.example' }),
}));

const decode = (segment: string) => JSON.parse(Buffer.from(segment, 'base64url').toString());

const PAYEE = 'uhpn1gHscLtCv1vkLSjYNNFXpZyJnGz1ynXWM9WaD7X';

// Runs the browser script against a bare object standing in for window.
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

const originalEnv = { NODE_ENV: process.env.NODE_ENV, BANKROLL_MOCK: process.env.BANKROLL_MOCK };

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.BANKROLL_MOCK = '1';
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv.NODE_ENV;
  if (originalEnv.BANKROLL_MOCK === undefined) delete process.env.BANKROLL_MOCK;
  else process.env.BANKROLL_MOCK = originalEnv.BANKROLL_MOCK;
  vi.unstubAllGlobals();
});

describe('mockEnabled', () => {
  it('is on only with BANKROLL_MOCK=1 outside production', () => {
    expect(mockEnabled()).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(mockEnabled()).toBe(false);
    process.env.NODE_ENV = 'development';
    delete process.env.BANKROLL_MOCK;
    expect(mockEnabled()).toBe(false);
  });
});

describe('mockToken and mockSession', () => {
  it('mints an unsigned token in the real token shape, marked as a mock', () => {
    const token = mockToken({ username: 'sam', age: 21, geo: 'US-NY' });
    const [header, payload, signature] = token.split('.');
    expect(decode(header!)).toEqual({ alg: 'none', typ: 'JWT' });
    expect(signature).toBe('');
    const claims = decode(payload!);
    expect(claims.mock).toBe(true);
    expect(claims.sub).toBe(MOCK_WALLET);
    expect(claims.username).toBe('sam');
    expect(claims.kyc).toEqual({ age: 21 });
    expect(claims.geo).toBe('US-NY');
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('maps the token to a session, verified or not', () => {
    const verified = mockSession(mockToken({ wallet: 'W1', username: 'sam', age: 21, geo: 'US-NY' }));
    expect(verified?.user).toEqual({ wallet: 'W1', username: 'sam', identity: { age: 21 } });
    expect(verified?.geo).toBe('US-NY');

    const unverified = mockSession(mockToken({ age: false }));
    expect(unverified?.user.identity).toBe(false);
    expect(unverified?.user.wallet).toBe(MOCK_WALLET);
  });

  it('refuses anything that is not a mock token', () => {
    const real = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(
      '{"sub":"W1","exp":1}',
    ).toString('base64url')}.sig`;
    expect(mockSession(real)).toBeNull();
    expect(mockSession('garbage')).toBeNull();
    expect(mockSession(null)).toBeNull();
  });
});

describe('getSession under the mock', () => {
  const request = (token: string) =>
    new Request('https://app.example/api/me', { headers: { [BANKROLL_TOKEN_HEADER]: token } });

  it('accepts a mock token in development', async () => {
    const session = await getSession(request(mockToken({ username: 'sam' })));
    expect(session?.user.username).toBe('sam');
  });

  it('ignores a mock token in production and verifies for real', async () => {
    process.env.NODE_ENV = 'production';
    // jose rejects alg:none before ever fetching keys.
    expect(await getSession(request(mockToken()))).toBeNull();
  });
});

describe('mock signatures', () => {
  it('round-trip the charge facts the host encoded', () => {
    const host = hostFrom(mockHostScript({ payee: PAYEE, wallet: 'W1' }));
    return host.pay!({ amountCents: 250, memo: 'tip', token: 'Mint1' }).then((signature) => {
      expect(isMockSignature(signature as string)).toBe(true);
      expect(parseMockSignature(signature as string)).toEqual({
        amountCents: 250,
        payer: 'W1',
        payee: PAYEE,
        mint: 'Mint1',
        memo: 'tip',
      });
    });
  });

  it('are not parsed from real-looking signatures', () => {
    expect(parseMockSignature('5vZu5AJvt4Un4XwzjLqtbn1i1zjJuWNqZh5NXCujCZKC')).toBeNull();
    expect(parseMockSignature('mock-notbase64json')).toBeNull();
  });

  it('confirm from their own contents without touching an RPC', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = hostFrom(mockHostScript({ payee: PAYEE }));
    const signature = (await host.pay!({ amountCents: 100 })) as string;

    const charge = await confirmCharge(signature);

    expect(charge).toMatchObject({
      signature,
      payer: MOCK_WALLET,
      payee: PAYEE,
      mint: '4FVaHEubcqws8hKwJSiW8f8CmKGUyMsBxTKUytcGdRvd',
      amountCents: 100,
      memo: null,
    });
    expect(charge.slot).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await findChargeByReference('anything')).toBeNull();
  });

  it('are treated as ordinary signatures in production', async () => {
    process.env.NODE_ENV = 'production';
    const fetchMock = vi.fn().mockRejectedValue(new Error('no network in tests'));
    vi.stubGlobal('fetch', fetchMock);
    const host = hostFrom(mockHostScript({ payee: PAYEE }));
    const signature = (await host.pay!({ amountCents: 100 })) as string;

    await expect(confirmCharge(signature, { timeoutMs: 1 })).rejects.toBeInstanceOf(ConfirmChargeError);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('mockHostScript', () => {
  it('defines the host the client SDK expects', async () => {
    const host = hostFrom(mockHostScript({ payee: PAYEE, cashCents: 500 }));
    expect(host.version).toBe('4');
    expect(await host.session!()).toBe(await host.identity!());
    expect(mockSession((await host.session!()) as string)?.user.username).toBe('tester');
    expect(await host.balances!()).toEqual({ cashCents: 500, creditsCents: 0, tokens: {} });
    expect(await host.requestAmount!()).toEqual({ status: 'dismissed' });
    expect(await host.haptics!({ type: 'light' })).toBeUndefined();
  });
});
