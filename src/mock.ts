// A stand-in for the Bankroll host, for tests and for coding agents working in
// a plain browser. Two halves that must agree:
//
//   mockHostScript()  the browser half — defines window.bankroll the way the
//                     Bankroll app does, so the client SDK reports 'ready' and
//                     every call succeeds without a phone. Hand it to
//                     Playwright's addInitScript or Puppeteer's
//                     evaluateOnNewDocument.
//   mockSession() /   the server half — accepts that host's unsigned token, and
//   mock signatures   the made-up signatures its pay() returns, so the app's
//                     own routes run end to end.
//
// The server half is honoured ONLY when BANKROLL_MOCK=1 and NODE_ENV is not
// production. A production build never reads the flag, so a token or
// signature from this file is worthless against a deployment.
import type { BankrollSession } from './server';

export const MOCK_FLAG = 'BANKROLL_MOCK';
const ENABLED = '1';
const PRODUCTION = 'production';

/** True when the server half is switched on: BANKROLL_MOCK=1 outside production. */
export function mockEnabled(): boolean {
  return process.env.NODE_ENV !== PRODUCTION && process.env[MOCK_FLAG] === ENABLED;
}

// The claim that marks a token as this file's. A real token never carries it,
// and a verifying server never looks for it.
const MOCK_CLAIM = 'mock';
const MOCK_ISSUER = 'bankroll-mock';
const MOCK_HOST_VERSION = '4';
const TOKEN_TTL_SECONDS = 3600;
const MS_PER_SECOND = 1000;

export const MOCK_WALLET = 'MockWa11et11111111111111111111111111111111';
const DEFAULT_USERNAME = 'tester';
const DEFAULT_AGE = 30;
const DEFAULT_CASH_CENTS = 100_000;

export interface MockUser {
  /** The pretend user's wallet address. */
  wallet?: string;
  username?: string;
  /**
   * The verified age. `false` makes the user unverified, so the app's
   * identity gates can be exercised too.
   */
  age?: number | false;
  /** The session's region, e.g. "US-CA". */
  geo?: string;
}

export interface MockHostOptions extends MockUser {
  /**
   * The address the app's manifest declares under capabilities.payments. The
   * mock signature carries it, so the server's payee check passes for this
   * app and fails for any other — the same check a real payment faces.
   */
  payee: string;
  /** The pretend cash balance, in cents. */
  cashCents?: number;
}

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function decodeJson(segment: string | undefined): Record<string, unknown> | null {
  if (!segment) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * An unsigned token in the same shape as a real Bankroll session token, with
 * a `mock: true` claim. The client SDK reads `exp` and `kyc` from it exactly
 * as it would from a real one.
 */
export function mockToken(user: MockUser = {}): string {
  const now = Math.floor(Date.now() / MS_PER_SECOND);
  const age = user.age ?? DEFAULT_AGE;
  const payload = {
    [MOCK_CLAIM]: true,
    iss: MOCK_ISSUER,
    sub: user.wallet ?? MOCK_WALLET,
    username: user.username ?? DEFAULT_USERNAME,
    kyc: age === false ? false : { age },
    ...(user.geo ? { geo: user.geo } : {}),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.`;
}

/**
 * The session a mock token describes, or null for anything that is not one.
 * No signature is checked — there is none — so call this only behind
 * `mockEnabled()`. `getSession` from `@joinbankroll/sdk/next` already does.
 */
export function mockSession(token: string | null | undefined): BankrollSession | null {
  if (!token) return null;
  const payload = decodeJson(token.split('.')[1]);
  if (payload?.[MOCK_CLAIM] !== true) return null;
  const now = Math.floor(Date.now() / MS_PER_SECOND);
  const kyc = payload.kyc;
  const age = typeof kyc === 'object' && kyc !== null ? (kyc as { age?: unknown }).age : undefined;
  return {
    iss: MOCK_ISSUER,
    aud: typeof payload.aud === 'string' ? payload.aud : '',
    iat: typeof payload.iat === 'number' ? payload.iat : now,
    exp: typeof payload.exp === 'number' ? payload.exp : now + TOKEN_TTL_SECONDS,
    ...(typeof payload.geo === 'string' ? { geo: payload.geo } : {}),
    user: {
      wallet: typeof payload.sub === 'string' ? payload.sub : MOCK_WALLET,
      username: typeof payload.username === 'string' ? payload.username : DEFAULT_USERNAME,
      identity:
        typeof kyc === 'object' && kyc !== null
          ? typeof age === 'number'
            ? { age }
            : {}
          : false,
    },
  };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export const MOCK_SIGNATURE_PREFIX = 'mock-';

/** What the mock host's pay() encodes into the signature it returns. */
export interface MockCharge {
  amountCents: number;
  payer: string;
  payee: string;
  /** The mint that paid, or null for HSUSD. */
  mint: string | null;
  memo: string | null;
}

export function isMockSignature(signature: string): boolean {
  return signature.startsWith(MOCK_SIGNATURE_PREFIX);
}

/** The facts a mock signature carries, or null if it is not a well-formed one. */
export function parseMockSignature(signature: string): MockCharge | null {
  if (!isMockSignature(signature)) return null;
  const facts = decodeJson(signature.slice(MOCK_SIGNATURE_PREFIX.length));
  if (!facts) return null;
  const { amountCents, payer, payee, mint, memo } = facts;
  if (typeof amountCents !== 'number' || typeof payer !== 'string' || typeof payee !== 'string') {
    return null;
  }
  return {
    amountCents,
    payer,
    payee,
    mint: typeof mint === 'string' ? mint : null,
    memo: typeof memo === 'string' ? memo : null,
  };
}

// ---------------------------------------------------------------------------
// The browser half
// ---------------------------------------------------------------------------

/**
 * JavaScript that defines `window.bankroll` as the Bankroll app would, with
 * every call succeeding at once. Run it before the page's own scripts:
 *
 *   await context.addInitScript(mockHostScript({ payee }));   // Playwright
 *
 * `payee` is the address the app's manifest declares; read it from
 * `/.well-known/bankroll.jwt` so the server's payee check exercises the real
 * value.
 */
export function mockHostScript(options: MockHostOptions): string {
  const token = mockToken(options);
  const wallet = options.wallet ?? MOCK_WALLET;
  const cashCents = options.cashCents ?? DEFAULT_CASH_CENTS;
  // Everything the script needs is baked in as JSON, so it has no closure
  // over this module and works in any page.
  const config = JSON.stringify({
    token,
    wallet,
    payee: options.payee,
    cashCents,
    version: MOCK_HOST_VERSION,
    prefix: MOCK_SIGNATURE_PREFIX,
  });
  return `(() => {
  const config = ${config};
  const base64url = (value) =>
    btoa(unescape(encodeURIComponent(JSON.stringify(value))))
      .replace(/\\+/g, '-')
      .replace(/\\//g, '_')
      .replace(/=+$/, '');
  window.bankroll = {
    version: config.version,
    session: async () => config.token,
    identity: async () => config.token,
    pay: async (input) =>
      config.prefix +
      base64url({
        amountCents: input && typeof input.amountCents === 'number' ? input.amountCents : 0,
        payer: config.wallet,
        payee: config.payee,
        mint: input && typeof input.token === 'string' ? input.token : null,
        memo: input && typeof input.memo === 'string' ? input.memo : null,
      }),
    balances: async () => ({ cashCents: config.cashCents, creditsCents: 0, tokens: {} }),
    deposit: async () => undefined,
    haptics: async () => undefined,
    quote: async () => undefined,
    requestAmount: async () => ({ status: 'dismissed' }),
  };
})();`;
}
