// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmCharge, ConfirmChargeError } from '../src/charges';
import { BANKROLL_TOKEN_HEADER } from '../src/constants';
import {
  isMockPayoutSignature,
  isMockSignature,
  MOCK_WALLET,
  mockEnabled,
  mockHostScript,
  MOCK_BLOCKHASH,
  MOCK_REFERENCE_PREFIX,
  mockPayoutSigner,
  mockSession,
  mockToken,
  parseMockSignature,
  SIMULATOR_CHANNEL,
} from '../src/mock';
import { getSession } from '../src/next';
import { buildPayout, confirmPayout } from '../src/payouts';
import { findChargeByReference } from '../src/references';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'app.example' }),
}));

const decode = (segment: string) => JSON.parse(Buffer.from(segment, 'base64url').toString());

const PAYEE = 'uhpn1gHscLtCv1vkLSjYNNFXpZyJnGz1ynXWM9WaD7X';

type Host = Record<string, (input?: unknown) => Promise<unknown>>;

// Runs the browser script against a bare object standing in for window.
function hostFrom(script: string, fakeWindow: { bankroll?: Host } = {}) {
  new Function('window', 'btoa', 'unescape', 'encodeURIComponent', script)(
    fakeWindow,
    (value: string) => Buffer.from(value, 'binary').toString('base64'),
    unescape,
    encodeURIComponent,
  );
  if (!fakeWindow.bankroll) throw new Error('script did not define window.bankroll');
  return fakeWindow.bankroll;
}

// The same in a frame: a parent that records what it is posted, and a way to
// deliver a message as that parent, or as someone else. `page` is whatever
// else the window has, such as a document.
function framedHost(script: string, page: Record<string, unknown> = {}) {
  const posts: { message: Record<string, unknown>; to: string }[] = [];
  const parent = { postMessage: (message: Record<string, unknown>, to: string) => posts.push({ message, to }) };
  let listener: (event: { source: unknown; origin: string; data: unknown }) => void = () => {};
  const host = hostFrom(script, {
    ...page,
    parent,
    addEventListener: (_type: string, handler: typeof listener) => {
      listener = handler;
    },
  } as { bankroll?: Host });
  const hear = (origin: string, data: unknown, source: unknown = parent) => listener({ source, origin, data });
  return { host, posts, hear };
}

// As much of a page's stylesheets as the script uses: a document that adopts
// them, and a sheet that keeps the text it was last given.
function stylesheets() {
  const made: { text: string }[] = [];
  class CSSStyleSheet {
    text = '';
    constructor() {
      made.push(this);
    }
    replaceSync(text: string) {
      this.text = text;
    }
  }
  const document = { adoptedStyleSheets: [] as unknown[] };
  return { made, document, page: { document, CSSStyleSheet } };
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

describe('mock payouts', () => {
  it('builds a payout for a mock signer without touching an RPC', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    vi.stubEnv('NODE_ENV', 'test');
    const fetchMock = vi.fn(async () => { throw new Error('no RPC under the mock'); });
    vi.stubGlobal('fetch', fetchMock);
    const built = await buildPayout(
      { recipients: [{ to: PAYEE, amountCents: 180 }, { to: PAYEE, amountCents: 0 }], memo: 'duel:1' },
      { signer: mockPayoutSigner(PAYEE) },
    );
    expect(built.blockhash).toBe(MOCK_BLOCKHASH);
    expect(built.lastValidBlockHeight).toBe(0);
    expect(JSON.parse(Buffer.from(built.transaction, 'base64').toString())).toMatchObject({ mock: 'payout' });
    expect(fetchMock).not.toHaveBeenCalled();
    // Still refuses what every build refuses.
    await expect(buildPayout({ to: 'nope', amountCents: 1 }, { signer: mockPayoutSigner(PAYEE) })).rejects.toThrow(/not a valid address/);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('signs nothing and answers with a mock payout signature the mock confirms outright', async () => {
    const signer = mockPayoutSigner('Payee111');
    expect(signer.address).toBe('Payee111');
    // Signs at send time, like a wallet service: nothing to store before the send.
    expect(signer.signTransaction).toBeUndefined();

    const signature = await signer.sendTransaction('AQ==');
    expect(isMockSignature(signature)).toBe(true);
    expect(isMockPayoutSignature(signature)).toBe(true);
    await expect(confirmPayout(signature)).resolves.toBeUndefined();
  });

  it('is a payout, not a payment: the charge side refuses it', async () => {
    const signature = await mockPayoutSigner('Payee111').sendTransaction('AQ==');
    expect(parseMockSignature(signature)).toBeNull();
    await expect(confirmCharge(signature)).rejects.toMatchObject({ code: 'not_a_payment' });
  });

  it('never confirms a mock charge signature as a payout', async () => {
    const host = hostFrom(mockHostScript({ payee: PAYEE }));
    const charge = (await host.pay!({ amountCents: 100 })) as string;
    expect(isMockPayoutSignature(charge)).toBe(false);
    // Off the mock path, confirmPayout goes to the chain — stubbed here to
    // fail fast — and a made-up signature is simply unknown to it.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no chain in this test')));
    await expect(confirmPayout(charge)).rejects.toBeInstanceOf(Error);
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
    expect(await host.promptReview!()).toBeUndefined();
  });
});

describe('mockHostScript and a simulator', () => {
  const HELLO = { bankroll: SIMULATOR_CHANNEL, type: 'hello' };
  const SIMULATOR = 'http://localhost:4100';

  // A test, a plain tab and a phone all run the app as the top window.
  it('says nothing outside a frame', async () => {
    const posts: unknown[] = [];
    const top: Record<string, unknown> = { postMessage: (message: unknown) => posts.push(message) };
    top.parent = top;
    const host = hostFrom(mockHostScript({ payee: PAYEE }), top as { bankroll?: Host });
    await host.balances!();
    expect(posts).toEqual([]);
  });

  it('says only that it is there, until a page on this computer says hello', async () => {
    const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE }));
    expect(posts).toEqual([{ message: { bankroll: SIMULATOR_CHANNEL, type: 'ready', version: '4' }, to: '*' }]);

    await host.session!();
    // Somebody else's page framing the app, and a local page that is not the parent.
    hear('https://simulator.example', HELLO);
    hear(SIMULATOR, HELLO, {});
    // The right page, saying something else.
    hear(SIMULATOR, { bankroll: SIMULATOR_CHANNEL, type: 'call' });
    expect(posts).toHaveLength(1);
  });

  it('tells a simulator every call, starting with the ones it missed', async () => {
    const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE, cashCents: 500 }));
    await host.balances!();
    hear(SIMULATOR, HELLO);
    await host.haptics!({ type: 'light' });

    const told = posts.slice(1);
    expect(told.map((post) => post.to)).toEqual([SIMULATOR, SIMULATOR, SIMULATOR, SIMULATOR]);
    expect(told.map((post) => post.message)).toMatchObject([
      { bankroll: SIMULATOR_CHANNEL, type: 'call', id: 1, method: 'balances' },
      { type: 'result', id: 1, method: 'balances', ok: true, value: { cashCents: 500, creditsCents: 0, tokens: {} } },
      { type: 'call', id: 2, method: 'haptics', input: { type: 'light' } },
      { type: 'result', id: 2, method: 'haptics', ok: true },
    ]);
    expect(told[0]!.message.at).toEqual(expect.any(Number));
    expect(told[1]!.message.ms).toEqual(expect.any(Number));
  });

  it('takes hello from any local address, and from nowhere else', async () => {
    for (const origin of ['http://127.0.0.1:4100', 'http://[::1]:4100', 'http://simulator.localhost:4100', 'https://localhost']) {
      const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE }));
      hear(origin, HELLO);
      await host.deposit!();
      expect(posts.at(-1)?.to).toBe(origin);
    }
    for (const origin of ['https://localhost.example', 'http://localhost:4100.example', 'https://example.com', 'null']) {
      const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE }));
      hear(origin, HELLO);
      await host.deposit!();
      expect(posts).toHaveLength(1);
    }
  });

  it('tells a call that failed as one, and still fails it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE }));
    hear(SIMULATOR, HELLO);
    await expect(host.pay!({ amountCents: 100, reference: `${MOCK_REFERENCE_PREFIX}one` })).rejects.toThrow('offline');
    expect(posts.at(-1)?.message).toMatchObject({ type: 'result', method: 'pay', ok: false, error: 'offline' });
  });

  it('stops keeping calls for a simulator that never comes', async () => {
    const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE }));
    for (let call = 0; call < 150; call++) await host.balances!();
    hear(SIMULATOR, HELLO);
    // 200 messages are kept, two to a call; the ready before them makes 201.
    expect(posts).toHaveLength(201);
  });
});

describe('mockHostScript and the safe area of a simulated phone', () => {
  const HELLO = { bankroll: SIMULATOR_CHANNEL, type: 'hello' };
  const SIMULATOR = 'http://localhost:4100';
  const PHONE = { top: 62, right: 0, bottom: 34, left: 0 };

  it('puts it where the page\'s CSS can read it, in a stylesheet of its own', () => {
    const { made, document, page } = stylesheets();
    const { hear } = framedHost(mockHostScript({ payee: PAYEE }), page);
    expect(document.adoptedStyleSheets).toEqual([]);

    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    expect(document.adoptedStyleSheets).toEqual([made[0]]);
    expect(made[0]!.text).toBe(
      ':root{--bankroll-safe-area-inset-top:62px;--bankroll-safe-area-inset-right:0px;--bankroll-safe-area-inset-bottom:34px;--bankroll-safe-area-inset-left:0px}',
    );
  });

  it('takes another phone in place of the last, in the same stylesheet', () => {
    const { made, document, page } = stylesheets();
    const { hear } = framedHost(mockHostScript({ payee: PAYEE }), page);
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    hear(SIMULATOR, { ...HELLO, safeArea: { ...PHONE, top: 47 } });
    expect(made).toHaveLength(1);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(made[0]!.text).toContain('--bankroll-safe-area-inset-top:47px');
    expect(made[0]!.text).not.toContain('62px');

    // A hello that says nothing of a phone leaves the last one standing.
    hear(SIMULATOR, HELLO);
    expect(made[0]!.text).toContain('--bankroll-safe-area-inset-top:47px');
  });

  it('keeps its stylesheet beside the page\'s own, and puts it back if the page drops it', () => {
    const { made, document, page } = stylesheets();
    const theirs = { text: 'the page\'s own' };
    document.adoptedStyleSheets = [theirs];
    const { hear } = framedHost(mockHostScript({ payee: PAYEE }), page);
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    expect(document.adoptedStyleSheets).toEqual([theirs, made[0]]);

    document.adoptedStyleSheets = [];
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    expect(document.adoptedStyleSheets).toEqual([made[0]]);
  });

  it('takes it only with a hello it takes, and only as lengths', () => {
    // Somebody else's page framing the app, and a local page that is not the parent.
    const refused = stylesheets();
    const stranger = framedHost(mockHostScript({ payee: PAYEE }), refused.page);
    stranger.hear('https://simulator.example', { ...HELLO, safeArea: PHONE });
    stranger.hear(SIMULATOR, { ...HELLO, safeArea: PHONE }, {});
    expect(refused.made).toEqual([]);
    expect(refused.document.adoptedStyleSheets).toEqual([]);

    // Anything that is not a length from an edge is left out: it would be CSS of the sender's choosing.
    const { made, page } = stylesheets();
    const { hear } = framedHost(mockHostScript({ payee: PAYEE }), page);
    hear(SIMULATOR, { ...HELLO, safeArea: { top: '62px;color:red', right: -1, bottom: Infinity, left: 3.5 } });
    expect(made[0]!.text).toBe(':root{--bankroll-safe-area-inset-left:3.5px}');
    hear(SIMULATOR, { ...HELLO, safeArea: { top: Number.NaN } });
    expect(made[0]!.text).toBe(':root{}');
    hear(SIMULATOR, { ...HELLO, safeArea: 'tall' });
    expect(made[0]!.text).toBe(':root{}');
  });

  it('still tells its calls where a page cannot adopt a stylesheet', async () => {
    const { host, posts, hear } = framedHost(mockHostScript({ payee: PAYEE }));
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    await host.deposit!();
    expect(posts.at(-1)?.message).toMatchObject({ type: 'result', method: 'deposit', ok: true });
  });
});
