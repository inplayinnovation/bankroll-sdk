// @joinbankroll/sdk — the client half. Talks to the native Build-on-Bankroll
// host injected as window.bankroll by the Bankroll app, plus a canonical
// fetch decorator and helpers. Server-side token verification lives in ./server.
//
// The host is the trust boundary: it resolves the origin, enforces consent, and
// is the only thing that signs. This module never touches a wallet — it only
// brokers the two capabilities (identity, pay) and normalises the host's
// machine-readable rejection reasons into typed BankrollError codes.

// The lowest window.bankroll.version this SDK can talk to. Below it (or a
// non-numeric version) the host is too old and the caller should prompt to
// update the Bankroll app.
const MIN_HOST_VERSION = 1;

// Refresh the session token this long before its exp so a request never goes out
// with one that expires mid-flight. Server TTL is 15 min.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Cap on a site-supplied pay memo — matches the host's own cap so we truncate
// before the bridge does rather than sending something it will silently trim.
const MEMO_MAX_LENGTH = 80;

const SECONDS_TO_MS = 1000;

// The header the server reads the session token from.
export const BANKROLL_TOKEN_HEADER = 'x-bankroll-token';

const PLAY_LINK_BASE = 'https://joinbankroll.com/play?url=';
const HTTPS_PROTOCOL = 'https:';

const PAY_METHOD = 'pay';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_UNAVAILABLE = 'unavailable';
const STATUS_UPDATE_REQUIRED = 'update_required';
const STATUS_READY = 'ready';

export type BankrollStatus =
  | typeof STATUS_UNAVAILABLE
  | typeof STATUS_UPDATE_REQUIRED
  | typeof STATUS_READY;

// parseInt so a semver-ish version ('1.2') reads its leading major; a
// non-numeric version yields NaN, which is deliberately below the minimum.
const leadingInt = (version: string): number => parseInt(version, 10);

// Synchronous and SSR-safe: never throws, never awaits.
//   'unavailable'     — not in a Bankroll host at all (incl. SSR).
//   'update_required' — a Bankroll app too old for this SDK (below-min or
//                       non-numeric window.bankroll, or the legacy pre-SDK
//                       bridge signalled only by window.__BANKROLL_CONFIG__).
//   'ready'           — a current host; session()/pay() will work.
function status(): BankrollStatus {
  if (typeof window === 'undefined') return STATUS_UNAVAILABLE;
  const host = window.bankroll;
  if (host) {
    return leadingInt(host.version) >= MIN_HOST_VERSION ? STATUS_READY : STATUS_UPDATE_REQUIRED;
  }
  if (window.__BANKROLL_CONFIG__ != null) return STATUS_UPDATE_REQUIRED;
  return STATUS_UNAVAILABLE;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const CODE_CONSENT_DECLINED = 'consent_declined';
const CODE_VERIFICATION_DECLINED = 'verification_declined';
const CODE_INSUFFICIENT_FUNDS = 'insufficient_funds';
const CODE_INVALID_AMOUNT = 'invalid_amount';
const CODE_CAPABILITY_NOT_REGISTERED = 'capability_not_registered';
const CODE_MANIFEST_ERROR = 'manifest_error';
const CODE_IDEMPOTENCY_CONFLICT = 'idempotency_conflict';
const CODE_PAYMENT_DENIED = 'payment_denied';
const CODE_UNKNOWN = 'unknown';

// Additional reasons the host can reject with — part of the stable public
// union so consumers can switch on them.
type ReservedErrorCode =
  | 'superseded_consent'
  | 'per_charge_declined'
  | 'blocked_origin'
  | 'charge_cap_exceeded';

export type BankrollErrorCode =
  | typeof STATUS_UNAVAILABLE
  | typeof STATUS_UPDATE_REQUIRED
  | typeof CODE_CONSENT_DECLINED
  | typeof CODE_VERIFICATION_DECLINED
  | typeof CODE_INSUFFICIENT_FUNDS
  | typeof CODE_INVALID_AMOUNT
  | typeof CODE_CAPABILITY_NOT_REGISTERED
  | typeof CODE_MANIFEST_ERROR
  | typeof CODE_IDEMPOTENCY_CONFLICT
  | typeof CODE_PAYMENT_DENIED
  | ReservedErrorCode
  | typeof CODE_UNKNOWN;

export class BankrollError extends Error {
  readonly code: BankrollErrorCode;

  constructor(code: BankrollErrorCode, message: string) {
    super(message);
    this.name = 'BankrollError';
    this.code = code;
  }
}

const MESSAGE_UNAVAILABLE = 'Bankroll is not available in this environment';
const MESSAGE_UPDATE_REQUIRED = 'the Bankroll app must be updated to use this feature';

const STATUS_ERROR_MESSAGE: Record<
  typeof STATUS_UNAVAILABLE | typeof STATUS_UPDATE_REQUIRED,
  string
> = {
  [STATUS_UNAVAILABLE]: MESSAGE_UNAVAILABLE,
  [STATUS_UPDATE_REQUIRED]: MESSAGE_UPDATE_REQUIRED,
};

// Authoritative host wire reasons. Exact reasons match by equality; the two
// markers below match by substring because the host interpolates the
// origin/capability into them. Every manifest failure message contains
// WIRE_MANIFEST_MARKER.
const WIRE_CONSENT_DECLINED = 'consent_declined';
const WIRE_VERIFICATION_DECLINED = 'verification_declined';
const WIRE_INSUFFICIENT_FUNDS = 'insufficient_funds';
const WIRE_INVALID_AMOUNT = 'pay requires a positive whole-cent amount';
const WIRE_IDEMPOTENCY_CONFLICT = 'idempotency_conflict';
const WIRE_PAYMENT_DENIED = 'payment_denied';
const WIRE_NOT_REGISTERED_MARKER = ' is not registered for ';
const WIRE_MANIFEST_MARKER = 'Bankroll manifest';

function mapReasonToCode(message: string): BankrollErrorCode {
  if (message === WIRE_CONSENT_DECLINED) return CODE_CONSENT_DECLINED;
  if (message === WIRE_VERIFICATION_DECLINED) return CODE_VERIFICATION_DECLINED;
  if (message === WIRE_INSUFFICIENT_FUNDS) return CODE_INSUFFICIENT_FUNDS;
  if (message === WIRE_INVALID_AMOUNT) return CODE_INVALID_AMOUNT;
  if (message === WIRE_IDEMPOTENCY_CONFLICT) return CODE_IDEMPOTENCY_CONFLICT;
  if (message === WIRE_PAYMENT_DENIED) return CODE_PAYMENT_DENIED;
  if (message.includes(WIRE_NOT_REGISTERED_MARKER)) return CODE_CAPABILITY_NOT_REGISTERED;
  if (message.includes(WIRE_MANIFEST_MARKER)) return CODE_MANIFEST_ERROR;
  // Everything else is deliberately 'unknown' with its message preserved —
  // origin-resolution failures, unsupported requests, GraphQL passthrough, etc.
  return CODE_UNKNOWN;
}

// The bridge rejects with Error instances whose .message is the wire reason.
// We normalise the code but preserve the original message on every code.
function mapBridgeError(error: unknown): BankrollError {
  const message = error instanceof Error ? error.message : String(error);
  return new BankrollError(mapReasonToCode(message), message);
}

// ---------------------------------------------------------------------------
// Bridge access + pre-flight
// ---------------------------------------------------------------------------

type BankrollBridge = NonNullable<Window['bankroll']>;

// Pre-flight for pay(): the host must be ready AND expose the method. An old
// host can present window.bankroll without a given method, so calling it would
// be a synchronous TypeError — feature-detect and surface it as
// 'update_required' instead.
function requireBridge(method: typeof PAY_METHOD): BankrollBridge {
  const current = status();
  if (current !== STATUS_READY) {
    throw new BankrollError(current, STATUS_ERROR_MESSAGE[current]);
  }
  const host = window.bankroll;
  if (!host || typeof host[method] !== 'function') {
    throw new BankrollError(STATUS_UPDATE_REQUIRED, STATUS_ERROR_MESSAGE[STATUS_UPDATE_REQUIRED]);
  }
  return host;
}

// ---------------------------------------------------------------------------
// Session token: cache + single-flight
// ---------------------------------------------------------------------------

// Private base64url payload decode — no signature check (the server verifies).
// Works in Node (Buffer) and the browser (atob). Fail-closed: an undecodable
// payload yields undefined so a bad token is never trusted.
function decodePayload(token: string): Record<string, unknown> | undefined {
  const segment = token.split('.')[1];
  if (!segment) return undefined;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const json =
      typeof Buffer !== 'undefined'
        ? Buffer.from(base64, 'base64').toString('utf8')
        : atob(base64);
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function tokenExpirySeconds(token: string): number | undefined {
  const exp = decodePayload(token)?.exp;
  return typeof exp === 'number' ? exp : undefined;
}

function isTokenFresh(token: string): boolean {
  const exp = tokenExpirySeconds(token);
  if (exp === undefined) return false;
  return exp * SECONDS_TO_MS - Date.now() >= TOKEN_REFRESH_MARGIN_MS;
}

// A token attests a verified identity when its identity claim is a truthy object
// ({ age }). On the wire the claim is delivered as `kyc`; accept `identity` too
// in case a host emits the exposed name.
function tokenIsVerified(token: string): boolean {
  const payload = decodePayload(token);
  if (!payload) return false;
  const claim = payload.identity ?? payload.kyc;
  return typeof claim === 'object' && claim !== null;
}

let cachedToken: string | null = null;
let inFlight: Promise<string> | null = null;
let inFlightIdentity = false;

// Resolve the host call for a session token, or throw (unavailable /
// update_required). identity: true requires the newer session() host method; the
// plain path falls back to a legacy host that only exposes identity().
function resolveTokenCall(identity: boolean): () => Promise<string> {
  const current = status();
  if (current !== STATUS_READY) {
    throw new BankrollError(current, STATUS_ERROR_MESSAGE[current]);
  }
  const host = window.bankroll as BankrollBridge;
  if (identity) {
    if (typeof host.session !== 'function') {
      // A host without session() can't run the verification funnel — never
      // silently hand back a possibly-unverified token.
      throw new BankrollError(STATUS_UPDATE_REQUIRED, STATUS_ERROR_MESSAGE[STATUS_UPDATE_REQUIRED]);
    }
    return () => host.session!({ identity: true });
  }
  if (typeof host.session === 'function') return () => host.session!();
  if (typeof host.identity === 'function') return () => host.identity!();
  throw new BankrollError(STATUS_UPDATE_REQUIRED, STATUS_ERROR_MESSAGE[STATUS_UPDATE_REQUIRED]);
}

export type SessionOptions = { identity?: boolean };

// Resolve the current session token — a signed JWT scoped to your origin (send
// it in the BANKROLL_TOKEN_HEADER and verify it server-side).
//
//   session()                   — the user's identity claim may be false (they
//                                 haven't verified). Use it for handle, region,
//                                 and free-to-play.
//   session({ identity: true }) — the host funnels the user through identity
//                                 verification if needed and resolves only once
//                                 the token attests a verified identity; if they
//                                 don't complete it, rejects `verification_declined`.
//
// Cached and single-flighted; a fresh token is reused, and an identity-required
// request reuses the cache only when the cached token is itself verified.
async function session(options?: SessionOptions): Promise<string> {
  const identity = options?.identity === true;
  const call = resolveTokenCall(identity);
  if (
    cachedToken !== null &&
    isTokenFresh(cachedToken) &&
    (!identity || tokenIsVerified(cachedToken))
  ) {
    return cachedToken;
  }
  // Reuse an in-flight fetch only when it will satisfy this request: an
  // identity-required fetch also satisfies a plain one, but not the reverse.
  if (inFlight !== null && (inFlightIdentity || !identity)) return inFlight;
  const pending = call().then(
    (token) => {
      cachedToken = token;
      if (inFlight === pending) inFlight = null;
      return token;
    },
    (error: unknown) => {
      if (inFlight === pending) inFlight = null; // cache left untouched on rejection
      throw mapBridgeError(error);
    },
  );
  inFlight = pending;
  inFlightIdentity = identity;
  return pending;
}

/**
 * @deprecated Renamed to {@link session}. Equivalent to `session()` with no
 * options — kept as a thin alias for back-compat.
 */
function identity(): Promise<string> {
  return session();
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

export type PayInput = {
  /** Whole US cents; must be a positive integer. */
  amountCents: number;
  /** Optional on-chain label; trimmed, max 80 characters. */
  memo?: string;
  /**
   * Names the logical payment: retries with the same key never charge twice —
   * a settled payment resolves with its signature, an in-flight one is
   * awaited. Reuse with different parameters rejects `idempotency_conflict`.
   * Max 255 characters; retained 24h, scoped to this app and user.
   */
  idempotencyKey?: string;
};

interface BridgePayload {
  amountCents: number;
  idempotencyKey: string;
  memo?: string;
}

async function pay(input: PayInput): Promise<string> {
  const bridge = requireBridge(PAY_METHOD);
  const { amountCents } = input;
  // Validate before the bridge, using the host's own wire message so a local
  // reject is indistinguishable from the host's.
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new BankrollError(CODE_INVALID_AMOUNT, WIRE_INVALID_AMOUNT);
  }
  // idempotencyKey is always sent so a retried charge can be recognised as the
  // same one.
  const payload: BridgePayload = {
    amountCents,
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
  };
  const memo = input.memo?.trim().slice(0, MEMO_MAX_LENGTH);
  if (memo) payload.memo = memo;
  try {
    return await bridge.pay(payload);
  } catch (error) {
    throw mapBridgeError(error);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const bankroll = {
  status,
  session,
  /** @deprecated Use {@link session}. */
  identity,
  pay,
};

// Canonical fetch decorator: attaches the session token on every request when
// hosted. Off-host the request goes out bare (the server 401s — a deliberate
// fail-open-to-unauthenticated). Any other status ('update_required') or a
// bridge rejection ('consent_declined', …) PROPAGATES — it is never masked as a
// bare request.
export function withBankrollToken(fetchImpl: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    if (status() === STATUS_UNAVAILABLE) return fetchImpl(input, init);
    const token = await session();
    const headers = new Headers(init?.headers);
    headers.set(BANKROLL_TOKEN_HEADER, token);
    // Known v0.1 limitation: headers carried inside a Request passed as `input`
    // (with no init) are not merged.
    return fetchImpl(input, { ...init, headers });
  };
  return wrapped;
}

// Build the shareable link that opens an app inside Bankroll. https-only; a
// non-https or unparseable url is a programming error, not a BankrollError.
export function playLink(appUrl: string): string {
  const parsed = new URL(appUrl);
  if (parsed.protocol !== HTTPS_PROTOCOL) {
    throw new Error(`playLink requires an https:// url, got ${parsed.protocol}`);
  }
  return PLAY_LINK_BASE + encodeURIComponent(parsed.href);
}

declare global {
  interface Window {
    bankroll?: {
      version: string;
      // The newer host method; older hosts expose only identity(). The SDK
      // feature-detects both.
      session?(options?: { identity?: boolean }): Promise<string>;
      /** @deprecated Older hosts expose this; session() supersedes it. */
      identity?(): Promise<string>;
      pay(input: { amountCents: number; memo?: string; idempotencyKey?: string }): Promise<string>;
    };
    // Legacy marker set by older Bankroll app builds — a presence-only signal
    // used to tell an out-of-date app apart from a standalone browser.
    __BANKROLL_CONFIG__?: unknown;
  }
}
