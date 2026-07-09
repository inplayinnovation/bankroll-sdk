// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module carries state (token cache + single-flight). Reset the registry
// and re-import for a clean module per test.
async function load() {
  vi.resetModules();
  return import('../src/index');
}

type BridgeShape = {
  version: string;
  identity?: unknown;
  pay?: unknown;
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

describe('pay validation', () => {
  it.each([0, -5, 1.5, NaN])(
    'rejects %p as invalid_amount without calling the bridge',
    async (amountCents) => {
      const payMock = vi.fn();
      setBridge({ version: '1', identity: vi.fn(), pay: payMock });
      const { bankroll, BankrollError } = await load();
      const error = await bankroll.pay({ amountCents }).catch((e: unknown) => e);
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
    await bankroll.pay({ amountCents: 100, memo: `  ${'x'.repeat(200)}  ` });
    expect(payPayload(payMock).memo).toBe('x'.repeat(80));
  });

  it('omits a memo that is empty after trim', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.pay({ amountCents: 100, memo: '   ' });
    expect('memo' in payPayload(payMock)).toBe(false);
  });

  it('omits the memo entirely when none is supplied', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.pay({ amountCents: 100 });
    expect('memo' in payPayload(payMock)).toBe(false);
  });

  it('auto-generates a uuid idempotencyKey and always includes it', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.pay({ amountCents: 100 });
    expect(payPayload(payMock).idempotencyKey).toMatch(UUID_RE);
  });

  it('passes a caller-supplied idempotencyKey through verbatim', async () => {
    const payMock = vi.fn().mockResolvedValue('sig');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await bankroll.pay({ amountCents: 100, idempotencyKey: 'caller-key-123' });
    expect(payPayload(payMock).idempotencyKey).toBe('caller-key-123');
  });

  it('resolves the settled signature', async () => {
    const payMock = vi.fn().mockResolvedValue('the-signature');
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll } = await load();
    await expect(bankroll.pay({ amountCents: 100 })).resolves.toBe('the-signature');
  });
});

describe('pay bridge-rejection mapping', () => {
  async function payCodeFor(reason: string): Promise<string> {
    const payMock = vi.fn().mockRejectedValue(new Error(reason));
    setBridge({ version: '1', identity: vi.fn(), pay: payMock });
    const { bankroll, BankrollError } = await load();
    const error = await bankroll.pay({ amountCents: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    return (error as InstanceType<typeof BankrollError>).code;
  }

  it('exact consent_declined', async () => {
    expect(await payCodeFor('consent_declined')).toBe('consent_declined');
  });

  it('exact insufficient_funds', async () => {
    expect(await payCodeFor('insufficient_funds')).toBe('insufficient_funds');
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
    const error = await bankroll.pay({ amountCents: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankrollError);
    expect((error as InstanceType<typeof BankrollError>).code).toBe('unknown');
    expect((error as InstanceType<typeof BankrollError>).message).toBe('Authentication required');
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
});
