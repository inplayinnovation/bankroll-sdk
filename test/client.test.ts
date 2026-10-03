// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module carries state (init, token cache + single-flight). Reset the
// registry and re-import for a clean module per test, started the way an app
// starts it: init() first. `started: false` leaves init() uncalled.
async function load({ started = true }: { started?: boolean } = {}) {
  vi.resetModules();
  const module = await import('../src/index');
  if (started) void module.bankroll.init();
  return module;
}

type BridgeShape = {
  version: string;
  init?: unknown;
  refused?: unknown;
  session?: unknown;
  identity?: unknown;
  pay?: unknown;
  balances?: unknown;
  deposit?: unknown;
  haptics?: unknown;
  promptReview?: unknown;
};

function setBridge(bridge: BridgeShape): void {
  (window as unknown as { bankroll?: unknown }).bankroll = bridge;
}

function clearHost(): void {
  delete (window as unknown as { bankroll?: unknown }).bankroll;
  delete (window as unknown as { __BANKROLL_CONFIG__?: unknown }).__BANKROLL_CONFIG__;
}

// base64url JWT with a real payload, signature segment is a placeholder.
function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function mintToken(payload: object): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
}
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
function freshToken(): string {
  return mintToken({ sub: 'wallet', exp: nowSeconds() + 3600 });
}
function verifiedToken(): string {
  return mintToken({ sub: 'wallet', exp: nowSeconds() + 3600, kyc: { age: 23 } });
}
function nearExpiryToken(): string {
  return mintToken({ sub: 'wallet', exp: nowSeconds() + 10 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  clearHost();
});

afterEach(() => {
  clearHost();
  vi.restoreAllMocks();
});

describe('init', () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

  it('is required: every call but status() fails until it has been called', async () => {
    const bridge = {
      version: '4',
      session: vi.fn().mockResolvedValue(freshToken()),
      pay: vi.fn().mockResolvedValue('signature'),
      balances: vi.fn(),
      deposit: vi.fn(),
      haptics: vi.fn(),
      promptReview: vi.fn(),
    };
    setBridge(bridge);
    const { bankroll, BankrollError } = await load({ started: false });
    expect(bankroll.status()).toBe('ready');

    const calls = [
      () => bankroll.session(),
      () => bankroll.identity(),
      () => bankroll.charge({ amountCents: 100 }),
      () => bankroll.balances(),
      () => bankroll.deposit(),
      () => bankroll.haptics({ type: 'light' }),
      () => bankroll.promptReview(),
    ];
    for (const call of calls) {
      const error = await call().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BankrollError);
      expect((error as InstanceType<typeof BankrollError>).code).toBe('not_initialized');
      expect((error as Error).message).toContain('bankroll.init()');
    }
    for (const method of [bridge.session, bridge.pay, bridge.balances, bridge.deposit, bridge.haptics, bridge.promptReview]) {
      expect(method).not.toHaveBeenCalled();
    }

    // And from then on they work.
    await bankroll.init();
    await expect(bankroll.charge({ amountCents: 100 })).resolves.toBe('signature');
  });

  it('tells a stand-in host each call it refuses, by the host\'s name for it', async () => {
    const refused = vi.fn();
    setBridge({ version: '4', refused, session: vi.fn(), pay: vi.fn(), balances: vi.fn() });
    const { bankroll } = await load({ started: false });
    await bankroll.balances().catch(() => {});
    await bankroll.charge({ amountCents: 100 }).catch(() => {});
    await bankroll.identity().catch(() => {});
    expect(refused.mock.calls.map(([method]) => method)).toEqual(['balances', 'pay', 'session']);
    expect(refused.mock.calls[0]![1]).toContain('bankroll.init()');

    // Once started there is nothing to refuse.
    await bankroll.init();
    await bankroll.balances();
    expect(refused).toHaveBeenCalledTimes(3);
  });

  it('refuses all the same when the host cannot be told, or fails at it', async () => {
    setBridge({
      version: '4',
      refused: () => {
        throw new Error('broken');
      },
      balances: vi.fn(),
    });
    const { bankroll } = await load({ started: false });
    await expect(bankroll.balances()).rejects.toMatchObject({ code: 'not_initialized' });
  });

  it('tells the host which SDK the page runs', async () => {
    const init = vi.fn().mockResolvedValue(undefined);
    setBridge({ version: '4', init, session: vi.fn() });
    const { bankroll } = await load({ started: false });
    await expect(bankroll.init()).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({ sdk: version });
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs once: calling it again is the first call over again', async () => {
    const init = vi.fn().mockResolvedValue(undefined);
    setBridge({ version: '4', init, session: vi.fn() });
    const { bankroll } = await load({ started: false });
    const first = bankroll.init();
    expect(bankroll.init()).toBe(first);
    await first;
    await bankroll.init({});
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('holds a call made while it is still running, and lets it go when it is done', async () => {
    let finish = () => {};
    const order: string[] = [];
    const token = freshToken();
    setBridge({
      version: '4',
      init: vi.fn(() => new Promise<void>((resolve) => (finish = () => (order.push('init done'), resolve())))),
      session: vi.fn(async () => (order.push('session'), token)),
    });
    const { bankroll } = await load({ started: false });
    void bankroll.init();
    const asked = bankroll.session();
    // Long enough for a call that was not waiting to have gone through.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    finish();
    await expect(asked).resolves.toBe(token);
    expect(order).toEqual(['init done', 'session']);
  });

  it('works under a Bankroll app that has never heard of it, which is told nothing', async () => {
    const token = freshToken();
    setBridge({ version: '4', session: vi.fn().mockResolvedValue(token), pay: vi.fn() });
    const { bankroll } = await load({ started: false });
    await expect(bankroll.init()).resolves.toBeUndefined();
    await expect(bankroll.session()).resolves.toBe(token);
  });

  it('is not stopped by a host that refuses the introduction', async () => {
    const token = freshToken();
    setBridge({
      version: '4',
      init: vi.fn().mockRejectedValue(new Error('no')),
      session: vi.fn().mockResolvedValue(token),
    });
    const { bankroll } = await load({ started: false });
    await expect(bankroll.init()).resolves.toBeUndefined();
    await expect(bankroll.session()).resolves.toBe(token);
  });

  it('does nothing outside Bankroll, where a call still says so', async () => {
    const { bankroll, BankrollError } = await load({ started: false });
    await expect(bankroll.init()).resolves.toBeUndefined();
    const error = await bankroll.session().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('unavailable');
  });

  it('says nothing to a Bankroll app too old for this SDK', async () => {
    const init = vi.fn();
    setBridge({ version: '0', init });
    const { bankroll } = await load({ started: false });
    await bankroll.init();
    expect(init).not.toHaveBeenCalled();
  });
});

describe('status', () => {
  it('version "1" → ready', async () => {
    setBridge({ version: '1', identity: vi.fn(), pay: vi.fn() });
    const { bankroll } = await load();
    expect(bankroll.status()).toBe('ready');
  });

  it('version "0" → update_required', async () => {
    setBridge({ version: '0', identity: vi.fn(), pay: vi.fn() });
    const { bankroll } = await load();
    expect(bankroll.status()).toBe('update_required');
  });

  it('version "1.2" → ready (tolerant leading-int parse)', async () => {
    setBridge({ version: '1.2', identity: vi.fn(), pay: vi.fn() });
    const { bankroll } = await load();
    expect(bankroll.status()).toBe('ready');
  });

  it('version "garbage" → update_required (NaN is below min)', async () => {
    setBridge({ version: 'garbage', identity: vi.fn(), pay: vi.fn() });
    const { bankroll } = await load();
    expect(bankroll.status()).toBe('update_required');
  });

  it('no bridge but legacy __BANKROLL_CONFIG__ → update_required', async () => {
    (window as unknown as { __BANKROLL_CONFIG__?: unknown }).__BANKROLL_CONFIG__ = {
      walletAddress: 'abc',
    };
    const { bankroll } = await load();
    expect(bankroll.status()).toBe('update_required');
  });

  it('neither → unavailable', async () => {
    const { bankroll } = await load();
    expect(bankroll.status()).toBe('unavailable');
  });
});

// A page on this computer, in a frame: where the SDK puts its own bridge and
// the simulator around the page answers (src/bridge.ts). The parent is stood
// in for, and the bridge's listener is caught as it is registered.
describe('status in a simulator', () => {
  const SIMULATOR = 'http://localhost:4100';
  const original = Object.getOwnPropertyDescriptor(window, 'parent');

  function frameThePage() {
    const posts: { message: Record<string, unknown>; to: string }[] = [];
    const parent = { postMessage: (message: Record<string, unknown>, to: string) => posts.push({ message, to }) };
    Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | null = null;
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, handler: unknown) => {
      if (type === 'message') listener = handler as typeof listener;
    }) as typeof window.addEventListener);
    const hear = (data: unknown) => listener?.({ source: parent, origin: SIMULATOR, data });
    return { posts, hear };
  }

  afterEach(async () => {
    if (original) Object.defineProperty(window, 'parent', original);
    (await import('../src/bridge')).resetBridge();
  });

  it('puts a bridge on the page the first time it is asked, and the simulator answers the calls', async () => {
    expect(window.location.origin).toMatch(/^http:\/\/localhost/);
    const { posts, hear } = frameThePage();
    const { bankroll } = await load({ started: false });
    expect(bankroll.status()).toBe('ready');
    expect(posts).toEqual([{ message: { bankroll: 'simulator', type: 'ready', sdk: expect.any(String) }, to: '*' }]);

    hear({ bankroll: 'simulator', type: 'hello', version: '5' });
    const starting = bankroll.init();
    // A charge waits for init() to be answered, as every call does.
    const charging = bankroll.charge({ amountCents: 500, idempotencyKey: 'once' });
    const calls = () => posts.filter((post) => post.message.type === 'call').map((post) => post.message);
    expect(calls()).toEqual([{ bankroll: 'simulator', type: 'call', id: 1, feature: 'bankroll:init', input: { sdk: expect.any(String) }, at: expect.any(Number) }]);
    hear({ bankroll: 'simulator', type: 'result', id: 1, ok: true });
    await starting;
    await Promise.resolve();
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toEqual({ bankroll: 'simulator', type: 'call', id: 2, feature: 'bankroll:pay', input: { amountCents: 500, idempotencyKey: 'once' }, at: expect.any(Number) });
    hear({ bankroll: 'simulator', type: 'result', id: 2, ok: false, error: 'insufficient_funds' });
    await expect(charging).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it('tells the simulator of a call made before init()', async () => {
    const { posts, hear } = frameThePage();
    const { bankroll } = await load({ started: false });
    // The first call of all: the bridge goes on the page as it is refused, and
    // the refusal is kept for the simulator until it says hello.
    await expect(bankroll.balances()).rejects.toMatchObject({ code: 'not_initialized' });
    expect(posts.map((post) => post.message.type)).toEqual(['ready']);
    hear({ bankroll: 'simulator', type: 'hello' });
    expect(posts.at(-1)?.message).toMatchObject({ type: 'refused', feature: 'bankroll:balances' });
  });
});

describe('identity', () => {
  it('resolves the token', async () => {
    const token = freshToken();
    setBridge({ version: '1', identity: vi.fn().mockResolvedValue(token), pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.identity()).resolves.toBe(token);
  });

  it('caches: a second call reuses a fresh token (one bridge call)', async () => {
    const token = freshToken();
    const identityMock = vi.fn().mockResolvedValue(token);
    setBridge({ version: '1', identity: identityMock, pay: vi.fn() });
    const { bankroll } = await load();
    const a = await bankroll.identity();
    const b = await bankroll.identity();
    expect(a).toBe(token);
    expect(b).toBe(token);
    expect(identityMock).toHaveBeenCalledTimes(1);
  });

  it('single-flight: two concurrent calls share one bridge call', async () => {
    const token = freshToken();
    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      resolveFn = r;
    });
    const identityMock = vi.fn(() => gate);
    setBridge({ version: '1', identity: identityMock, pay: vi.fn() });
    const { bankroll } = await load();
    const p1 = bankroll.identity();
    const p2 = bankroll.identity();
    resolveFn(token);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(token);
    expect(b).toBe(token);
    expect(identityMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token is within the refresh margin', async () => {
    const stale = nearExpiryToken();
    const fresh = freshToken();
    const identityMock = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    setBridge({ version: '1', identity: identityMock, pay: vi.fn() });
    const { bankroll } = await load();
    const first = await bankroll.identity();
    const second = await bankroll.identity();
    expect(first).toBe(stale);
    expect(second).toBe(fresh);
    expect(identityMock).toHaveBeenCalledTimes(2);
  });

  it('maps a declined consent rejection to BankrollError consent_declined', async () => {
    setBridge({
      version: '1',
      identity: vi.fn().mockRejectedValue(new Error('consent_declined')),
      pay: vi.fn(),
    });
    const { bankroll, BankrollError } = await load();
    await expect(bankroll.identity()).rejects.toBeInstanceOf(BankrollError);
    await expect(bankroll.identity()).rejects.toMatchObject({ code: 'consent_declined' });
  });

  it('off-host → BankrollError unavailable', async () => {
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.identity().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('unavailable');
  });

  it('below-min host → BankrollError update_required', async () => {
    setBridge({ version: '0', identity: vi.fn(), pay: vi.fn() });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.identity().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('update_required');
  });

  it('ready host missing the identity method → update_required (feature-detect)', async () => {
    setBridge({ version: '1', pay: vi.fn() }); // no identity
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.identity().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('update_required');
  });
});

describe('session', () => {
  it('resolves the token from host.session()', async () => {
    const token = freshToken();
    const session = vi.fn().mockResolvedValue(token);
    setBridge({ version: '1', session, pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.session()).resolves.toBe(token);
    expect(session).toHaveBeenCalledWith();
  });

  it('falls back to host.identity() on a legacy host with no session()', async () => {
    const token = freshToken();
    const identity = vi.fn().mockResolvedValue(token);
    setBridge({ version: '1', identity, pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.session()).resolves.toBe(token);
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('deprecated identity() delegates to session()', async () => {
    const token = freshToken();
    const session = vi.fn().mockResolvedValue(token);
    setBridge({ version: '1', session, pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.identity()).resolves.toBe(token);
    expect(session).toHaveBeenCalledTimes(1);
  });

  it('session({ identity: true }) calls host.session with { identity: true }', async () => {
    const token = verifiedToken();
    const session = vi.fn().mockResolvedValue(token);
    setBridge({ version: '1', session, pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.session({ identity: true })).resolves.toBe(token);
    expect(session).toHaveBeenCalledWith({ identity: true });
  });

  it('session({ identity: true }) is update_required on a legacy host lacking session()', async () => {
    const identity = vi.fn().mockResolvedValue(freshToken());
    setBridge({ version: '1', identity, pay: vi.fn() });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.session({ identity: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('update_required');
    // Never silently hands back a possibly-unverified token from the legacy method.
    expect(identity).not.toHaveBeenCalled();
  });

  it('maps a verification_declined rejection', async () => {
    const session = vi.fn().mockRejectedValue(new Error('verification_declined'));
    setBridge({ version: '1', session, pay: vi.fn() });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.session({ identity: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('verification_declined');
  });

  it('does not reuse an unverified cached token for an identity request', async () => {
    const unverified = freshToken();
    const verified = verifiedToken();
    const session = vi.fn().mockResolvedValueOnce(unverified).mockResolvedValueOnce(verified);
    setBridge({ version: '1', session, pay: vi.fn() });
    const { bankroll } = await load();
    await bankroll.session(); // caches an unverified token
    await expect(bankroll.session({ identity: true })).resolves.toBe(verified);
    expect(session).toHaveBeenCalledTimes(2);
    expect(session).toHaveBeenLastCalledWith({ identity: true });
  });

  it('reuses a verified cached token for a later plain session()', async () => {
    const token = verifiedToken();
    const session = vi.fn().mockResolvedValue(token);
    setBridge({ version: '1', session, pay: vi.fn() });
    const { bankroll } = await load();
    await bankroll.session({ identity: true }); // caches a verified token
    await expect(bankroll.session()).resolves.toBe(token);
    expect(session).toHaveBeenCalledTimes(1); // plain call served from cache
  });
});

describe('pay validation', () => {
  it.each([0, -5, 1.5, NaN])(
    'rejects %p as invalid_amount without calling the bridge',
    async (amountCents) => {
      const payMock = vi.fn();
      setBridge({ version: '1', identity: vi.fn(), pay: payMock });
      const { bankroll, BankrollError } = await load();
      const error = await bankroll.charge({ amountCents }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BankrollError);
      expect((error as InstanceType<typeof BankrollError>).code).toBe('invalid_amount');
      expect((error as InstanceType<typeof BankrollError>).message).toBe(
        'pay requires a positive whole-cent amount',
      );
      expect(payMock).not.toHaveBeenCalled();
    },
  );
});

describe('pay bridge payload', () => {
  function payPayload(mock: ReturnType<typeof vi.fn>): {
    amountCents: number;
    idempotencyKey: string;
    memo?: string;
  } {
    return mock.mock.calls[0]![0] as {
      amountCents: number;
      idempotencyKey: string;
      memo?: string;
    };
  }

  it('trims and caps the memo to 80 chars', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100, memo: `  ${'x'.repeat(200)}  ` });
    expect(payPayload(payMock).memo).toBe('x'.repeat(80));
  });

  it('omits a memo that is empty after trim', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100, memo: '   ' });
    expect('memo' in payPayload(payMock)).toBe(false);
  });

  it('omits the memo entirely when none is supplied', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100 });
    expect('memo' in payPayload(payMock)).toBe(false);
  });

  it('auto-generates a uuid idempotencyKey and always includes it', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100 });
    expect(payPayload(payMock).idempotencyKey).toMatch(UUID_RE);
  });

  it('passes a caller-supplied idempotencyKey through verbatim', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100, idempotencyKey: 'caller-key-123' });
    expect(payPayload(payMock).idempotencyKey).toBe('caller-key-123');
  });

  it('resolves the settled signature', async () => {
    const payMock = vi.fn().mockResolvedValue('the-signature');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await expect(bankroll.charge({ amountCents: 100 })).resolves.toBe('the-signature');
  });
});

describe('pay bridge-rejection mapping', () => {
  async function payCodeFor(reason: string): Promise<string> {
    const payMock = vi.fn().mockRejectedValue(new Error(reason));
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.charge({ amountCents: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    return (error as InstanceType<typeof BankrollError>).code;
  }

  it('exact consent_declined', async () => {
    expect(await payCodeFor('consent_declined')).toBe('consent_declined');
  });

  it('exact insufficient_funds', async () => {
    expect(await payCodeFor('insufficient_funds')).toBe('insufficient_funds');
  });

  it('exact idempotency_conflict', async () => {
    expect(await payCodeFor('idempotency_conflict')).toBe('idempotency_conflict');
  });

  it('exact payment_denied', async () => {
    expect(await payCodeFor('payment_denied')).toBe('payment_denied');
  });

  it('exact charge_expired', async () => {
    expect(await payCodeFor('charge_expired')).toBe('charge_expired');
  });

  it('exact "pay requires a positive whole-cent amount" → invalid_amount', async () => {
    expect(await payCodeFor('pay requires a positive whole-cent amount')).toBe('invalid_amount');
  });

  it('"… is not registered for …" → capability_not_registered', async () => {
    expect(await payCodeFor('https://foo.example is not registered for pay')).toBe(
      'capability_not_registered',
    );
  });

  it('a manifest failure → manifest_error', async () => {
    expect(await payCodeFor('Malformed Bankroll manifest at https://foo.example')).toBe(
      'manifest_error',
    );
  });

  it('missing-merchantWallet manifest variant → manifest_error', async () => {
    expect(
      await payCodeFor('Bankroll manifest at https://foo.example is missing merchantWallet'),
    ).toBe('manifest_error');
  });

  it('unknown message → unknown, original message preserved', async () => {
    const payMock = vi.fn().mockRejectedValue(new Error('Authentication required'));
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.charge({ amountCents: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('unknown');
    expect((error as InstanceType<typeof BankrollError>).message).toBe('Authentication required');
  });
});

describe('charge reference', () => {
  const REFERENCE = 'GgRva3ZaFuqDDVxr8CDsFcSf7ETNqQFJRhc4Y5nqsFhk';

  it('passes the reference through to the bridge on a v3 host', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '3', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100, reference: REFERENCE });
    expect((payMock.mock.calls[0]![0] as { reference?: string }).reference).toBe(REFERENCE);
  });

  // An older host would ignore it and settle a charge the app can never find.
  it('rejects update_required on a pre-3 host without calling the bridge', async () => {
    const payMock = vi.fn();
    setBridge({ version: '2', identity: vi.fn(), pay: payMock });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll
      .charge({ amountCents: 100, reference: REFERENCE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('update_required');
    expect(payMock).not.toHaveBeenCalled();
  });

  it('omits the field entirely when no reference is supplied', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '3', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100 });
    expect('reference' in (payMock.mock.calls[0]![0] as object)).toBe(false);
  });

  // The gate is opt-in: a charge without a reference still works everywhere.
  it('leaves a plain charge working on an old host', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '2', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await expect(bankroll.charge({ amountCents: 100 })).resolves.toBe('sig');
  });
});

describe('charge expiry', () => {
  it('passes expiresInSeconds through to the bridge on a v3 host', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '3', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100, expiresInSeconds: 60 });
    expect((payMock.mock.calls[0]![0] as { expiresInSeconds?: number }).expiresInSeconds).toBe(60);
  });

  it('rejects update_required on a pre-3 host without calling the bridge', async () => {
    const payMock = vi.fn();
    setBridge({ version: '2', identity: vi.fn(), pay: payMock });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll
      .charge({ amountCents: 100, expiresInSeconds: 60 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('update_required');
    expect(payMock).not.toHaveBeenCalled();
  });

  it('omits the field entirely when no expiry is supplied', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '3', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.charge({ amountCents: 100 });
    expect('expiresInSeconds' in (payMock.mock.calls[0]![0] as object)).toBe(false);
  });
});

describe('haptics', () => {
  it('resolves silently with no host at all', async () => {
    const { bankroll } = await load();
    await expect(bankroll.haptics({ type: 'heavy' })).resolves.toBeUndefined();
  });

  it('resolves silently on a host without the method', async () => {
    setBridge({ version: '3', identity: vi.fn(), pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.haptics()).resolves.toBeUndefined();
  });

  it('forwards the input to a current host', async () => {
    const hapticsFn = vi.fn().mockResolvedValue(undefined);
    setBridge({ version: '4', identity: vi.fn(), pay: vi.fn(), haptics: hapticsFn });
    const { bankroll } = await load();
    await bankroll.haptics({ type: 'success' });
    expect(hapticsFn).toHaveBeenCalledWith({ type: 'success' });
  });

  it('resolves silently when the bridge rejects', async () => {
    const hapticsFn = vi.fn().mockRejectedValue(new Error('engine down'));
    setBridge({ version: '4', identity: vi.fn(), pay: vi.fn(), haptics: hapticsFn });
    const { bankroll } = await load();
    await expect(bankroll.haptics()).resolves.toBeUndefined();
  });
});

describe('promptReview', () => {
  it('resolves silently with no host at all', async () => {
    const { bankroll } = await load();
    await expect(bankroll.promptReview()).resolves.toBeUndefined();
  });

  it('resolves silently on a host without the method', async () => {
    setBridge({ version: '4', identity: vi.fn(), pay: vi.fn() });
    const { bankroll } = await load();
    await expect(bankroll.promptReview()).resolves.toBeUndefined();
  });

  it('asks a current host', async () => {
    const promptReviewFn = vi.fn().mockResolvedValue(undefined);
    setBridge({ version: '4', identity: vi.fn(), pay: vi.fn(), promptReview: promptReviewFn });
    const { bankroll } = await load();
    await expect(bankroll.promptReview()).resolves.toBeUndefined();
    expect(promptReviewFn).toHaveBeenCalledTimes(1);
  });

  it('resolves silently when the bridge rejects', async () => {
    const promptReviewFn = vi.fn().mockRejectedValue(new Error('bridge down'));
    setBridge({ version: '4', identity: vi.fn(), pay: vi.fn(), promptReview: promptReviewFn });
    const { bankroll } = await load();
    await expect(bankroll.promptReview()).resolves.toBeUndefined();
  });
});

describe('withBankrollToken', () => {
  it('attaches the token header when ready', async () => {
    const token = freshToken();
    setBridge({ version: '1', identity: vi.fn().mockResolvedValue(token), pay: vi.fn() });
    const { withBankrollToken, BANKROLL_TOKEN_HEADER } = await load();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const decorated = withBankrollToken(fetchImpl as unknown as typeof fetch);
    await decorated('https://api.example/x');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get(BANKROLL_TOKEN_HEADER)).toBe(token);
  });

  it('sends a bare request when unavailable (no header)', async () => {
    const { withBankrollToken, BANKROLL_TOKEN_HEADER } = await load();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const decorated = withBankrollToken(fetchImpl as unknown as typeof fetch);
    await decorated('https://api.example/x', { method: 'POST' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init?.headers);
    expect(headers.has(BANKROLL_TOKEN_HEADER)).toBe(false);
  });

  it('still sends a bare request outside Bankroll when init() was never called', async () => {
    const { withBankrollToken, BANKROLL_TOKEN_HEADER } = await load({ started: false });
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    await withBankrollToken(fetchImpl as unknown as typeof fetch)('https://api.example/x');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchImpl.mock.calls[0]![1] as RequestInit)?.headers).has(BANKROLL_TOKEN_HEADER)).toBe(false);
  });

  it('inside Bankroll, fails as every call does when init() was never called', async () => {
    setBridge({ version: '1', identity: vi.fn().mockResolvedValue(freshToken()), pay: vi.fn() });
    const { withBankrollToken, BankrollError } = await load({ started: false });
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const error = await withBankrollToken(fetchImpl as unknown as typeof fetch)('https://api.example/x').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('not_initialized');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates consent_declined without calling fetch', async () => {
    setBridge({
      version: '1',
      identity: vi.fn().mockRejectedValue(new Error('consent_declined')),
      pay: vi.fn(),
    });
    const { withBankrollToken, BankrollError } = await load();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const decorated = withBankrollToken(fetchImpl as unknown as typeof fetch);
    const error = await decorated('https://api.example/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('consent_declined');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('playLink', () => {
  it('encodes an https app url onto the play base', async () => {
    const { playLink } = await load();
    const link = playLink('https://app.example/game?a=1');
    expect(link).toBe(
      `https://joinbankroll.com/play?url=${encodeURIComponent(
        'https://app.example/game?a=1',
      )}`,
    );
  });

  it('rejects a non-https url', async () => {
    const { playLink } = await load();
    expect(() => playLink('http://app.example')).toThrow();
  });

  it('rejects an unparseable url', async () => {
    const { playLink } = await load();
    expect(() => playLink('not a url')).toThrow();
  });

  it('appends the referrer, and omits it when there is none', async () => {
    const { playLink } = await load();
    const url = 'https://app.example/game';
    const wallet = 'J6L33Wi7hVEnBnBM8dpTgD8FfDDGgDFVKnfLLQZ1Ptvi';

    expect(playLink(url, { referrer: wallet })).toBe(
      `https://joinbankroll.com/play?url=${encodeURIComponent(url)}&ref=${wallet}`,
    );
    expect(playLink(url, { referrer: `  ${wallet}\n` })).toBe(
      `https://joinbankroll.com/play?url=${encodeURIComponent(url)}&ref=${wallet}`,
    );
    // An absent, empty, or whitespace-only referrer is simply no referrer —
    // never a dangling &ref= for the host to puzzle over.
    for (const options of [undefined, {}, { referrer: '' }, { referrer: '   ' }]) {
      expect(playLink(url, options)).toBe(
        `https://joinbankroll.com/play?url=${encodeURIComponent(url)}`,
      );
    }
  });

  // The link builder does not police wallet shape — that is the host's call at
  // attribution — but it must never let a referrer break the url it builds.
  it('percent-encodes a referrer rather than trusting it', async () => {
    const { playLink } = await load();
    expect(playLink('https://app.example/', { referrer: 'a&url=evil' })).toBe(
      `https://joinbankroll.com/play?url=${encodeURIComponent(
        'https://app.example/',
      )}&ref=a%26url%3Devil`,
    );
  });
});
