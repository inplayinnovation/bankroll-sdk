// @joinbankroll/sdk — the client half. Talks to the native Build-on-Bankroll
// host injected as window.bankroll by the Bankroll app, plus a canonical
// fetch decorator and helpers. Server-side token verification lives in ./server.
//
// The host is the trust boundary: it resolves the origin, enforces consent, and
// is the only thing that signs. This module never touches a wallet — it only
// brokers the two capabilities (session, charge) and normalises the host's
// machine-readable rejection reasons into typed BankrollError codes.
import { BANKROLL_TOKEN_HEADER } from './constants';

export { BANKROLL_TOKEN_HEADER };

// The lowest window.bankroll.version this SDK can talk to. Below it (or a
// non-numeric version) the host is too old and the caller should prompt to
// update the Bankroll app.
const MIN_HOST_VERSION = 1;

// The lowest host version that honours the charge fields an app uses to guard
// a payment — `reference` and `expiresInSeconds`. Below it either would be
// ignored, leaving the app believing in a protection it doesn't have, so
// passing one to an older host is refused outright.
const GUARDED_CHARGE_MIN_HOST_VERSION = 3;

// Refresh the session token this long before its exp so a request never goes out
// with one that expires mid-flight. Server TTL is 15 min.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Cap on a site-supplied charge memo — matches the host's own cap so we truncate
// before the bridge does rather than sending something it will silently trim.
const MEMO_MAX_LENGTH = 80;

const SECONDS_TO_MS = 1000;

const PLAY_LINK_BASE = 'https://joinbankroll.com/play?url=';
const HTTPS_PROTOCOL = 'https:';

// The bridge method charge() calls — the wire name stays `pay` (versioned
// protocol against shipped native apps); only the SDK surface renamed.
const PAY_METHOD = 'pay';

// Prerelease bridge methods — absent on hosts older than client version 2, so
// the same method-presence pre-flight that guards pay covers them.
const BALANCES_METHOD = 'balances';
const DEPOSIT_METHOD = 'deposit';

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
//   'ready'           — a current host; session()/charge() will work.
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
const CODE_CHARGE_EXPIRED = 'charge_expired';
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
  | typeof CODE_CHARGE_EXPIRED
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
const WIRE_CHARGE_EXPIRED = 'charge_expired';
const WIRE_NOT_REGISTERED_MARKER = ' is not registered for ';
const WIRE_MANIFEST_MARKER = 'Bankroll manifest';

function mapReasonToCode(message: string): BankrollErrorCode {
  if (message === WIRE_CONSENT_DECLINED) return CODE_CONSENT_DECLINED;
  if (message === WIRE_VERIFICATION_DECLINED) return CODE_VERIFICATION_DECLINED;
  if (message === WIRE_INSUFFICIENT_FUNDS) return CODE_INSUFFICIENT_FUNDS;
  if (message === WIRE_INVALID_AMOUNT) return CODE_INVALID_AMOUNT;
  if (message === WIRE_IDEMPOTENCY_CONFLICT) return CODE_IDEMPOTENCY_CONFLICT;
  if (message === WIRE_PAYMENT_DENIED) return CODE_PAYMENT_DENIED;
  if (message === WIRE_CHARGE_EXPIRED) return CODE_CHARGE_EXPIRED;
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

// Pre-flight for charge()/deposit()/balances(): the host must be ready AND
// expose the method. An old host can present window.bankroll without a given
// method, so calling it would be a synchronous TypeError — feature-detect and
// surface it as 'update_required' instead.
function requireBridge(
  method: typeof BALANCES_METHOD | typeof DEPOSIT_METHOD | typeof PAY_METHOD
): BankrollBridge {
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
// Charge
// ---------------------------------------------------------------------------

export type ChargeInput = {
  /** Whole US cents; must be a positive integer. */
  amountCents: number;
  /** Optional on-chain label; trimmed, max 80 characters. */
  memo?: string;
  /**
   * Names the logical charge: retries with the same key never charge twice —
   * a settled charge resolves with its signature, an in-flight one is
   * awaited. Reuse with different parameters rejects `idempotency_conflict`.
   * Max 255 characters; retained 24h, scoped to this app and user.
   */
  idempotencyKey?: string;
  /**
   * How long the user has to approve, in whole seconds. **Every charge already
   * expires** — this only changes the window, which defaults to 90 seconds.
   * The clock starts when the approval sheet appears, not when you call, so it
   * is the user's deciding time and the host's own setup doesn't eat into it.
   *
   * Past it the charge rejects `charge_expired` with nothing signed, nothing
   * moved, and the `idempotencyKey` unconsumed, so retrying at a fresh price
   * is clean.
   *
   * The bound is what makes a [reference]{@link ChargeInput.reference}
   * conclusive: a charge that hasn't landed within the window plus the
   * lifetime of its own blockhash never will, so an unresolved reference stops
   * meaning "not yet" and starts meaning "not paid". Allow about five minutes
   * from the call at the default window.
   *
   * A duration rather than a deadline: a deadline would be read against the
   * device's clock, and the person who gains by defeating an expiry is the one
   * holding the device.
   *
   * Requires a Bankroll app at client version 3+.
   */
  expiresInSeconds?: number;
  /**
   * An address the transfer carries as an inert read-only account, so your
   * server can find this charge on-chain later — with
   * `findChargeByReference()` from `@joinbankroll/sdk/server` — by an id it
   * minted before the payment existed. Generate it with `createReference()`
   * when you create the order, store it alongside the order, and pass the same
   * one on every attempt to pay for it.
   *
   * This is what makes a charge recoverable when the page never gets to hand
   * you the signature. Requires a Bankroll app at client version 3+; older
   * hosts reject with `update_required` rather than settling a charge you
   * could never look up.
   */
  reference?: string;
  /**
   * Mint to charge in. Defaults to HSUSD; name one of your own `appTokens`
   * mints to charge that token instead. The host settles a token charge only
   * when your manifest declares that mint, and your server must still branch on
   * the `mint` confirmCharge() reports before releasing value.
   */
  token?: string;
};

interface BridgePayload {
  amountCents: number;
  expiresInSeconds?: number;
  idempotencyKey: string;
  memo?: string;
  reference?: string;
  token?: string;
}

// Charge the user's Bankroll balance; resolves with the settled transfer's
// signature, which your server confirms with confirmCharge() before releasing
// value.
async function charge(input: ChargeInput): Promise<string> {
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
  if (input.token !== undefined) payload.token = input.token;
  // Both of these are protections the caller asked for, and an older host
  // would ignore either one silently — settling a charge that can never be
  // found, or honouring a price however long the user took. Refuse loudly
  // instead; a caller that would rather degrade than block can catch this and
  // retry without them.
  if (input.expiresInSeconds !== undefined || input.reference !== undefined) {
    if (leadingInt(bridge.version) < GUARDED_CHARGE_MIN_HOST_VERSION) {
      throw new BankrollError(
        STATUS_UPDATE_REQUIRED,
        STATUS_ERROR_MESSAGE[STATUS_UPDATE_REQUIRED],
      );
    }
  }
  if (input.expiresInSeconds !== undefined) payload.expiresInSeconds = input.expiresInSeconds;
  if (input.reference !== undefined) payload.reference = input.reference;
  try {
    return await bridge.pay(payload);
  } catch (error) {
    throw mapBridgeError(error);
  }
}

// ---------------------------------------------------------------------------
// Deposit + balances (prerelease)
// ---------------------------------------------------------------------------

export type DepositInput = {
  /**
   * Deposit method to preselect (e.g. 'card'). The host validates it and
   * falls back to its default when unknown or ineligible; what a purchase
   * settles as is resolved host-side from this app's origin, never from this
   * input.
   */
  method?: string;
};

export type AppTokenBalance = {
  /** Balance in whole tokens (app tokens are 9-decimal, one token = $1). */
  amount: number;
  /** The manifest's display name for the token. */
  name: string;
};

export type Balances = {
  /** The user's cash (HSUSD), in whole US cents. */
  cashCents: number;
  /** Credits registered to this app, in whole US cents. */
  creditsCents: number;
  /**
   * Balances of every token this app's manifest declares, keyed by mint
   * address — the same shape as the manifest's appTokens.
   */
  tokens: Record<string, AppTokenBalance>;
};

/**
 * Present the host's deposit modal, optionally preselecting a method. Resolves
 * once presented — the deposit itself runs in native UI and settles later.
 *
 * @remarks Prerelease — undocumented; the contract may change. Requires a host
 * at client version 2+; older hosts reject with 'update_required'.
 */
async function deposit(input?: DepositInput): Promise<void> {
  const bridge = requireBridge(DEPOSIT_METHOD);
  try {
    return await bridge.deposit!(input);
  } catch (error) {
    throw mapBridgeError(error);
  }
}

/**
 * This app's view of value: the user's cash, the app's credits, and its
 * manifest-declared token balances.
 *
 * @remarks Prerelease — undocumented; the contract may change. Requires a host
 * at client version 2+; older hosts reject with 'update_required'.
 */
async function balances(): Promise<Balances> {
  const bridge = requireBridge(BALANCES_METHOD);
  try {
    return await bridge.balances!();
  } catch (error) {
    throw mapBridgeError(error);
  }
}

// ---------------------------------------------------------------------------
// Haptics
// ---------------------------------------------------------------------------

const HAPTICS_METHOD = 'haptics';

export type HapticType =
  | 'error'
  | 'heavy'
  | 'light'
  | 'medium'
  | 'selection'
  | 'success'
  | 'warning';

export type HapticsInput = {
  /**
   * The vibration to play: an impact ('light' | 'medium' | 'heavy'), a
   * notification ('success' | 'warning' | 'error'), or 'selection'. Omitted —
   * or unknown to the host — plays the host's default, a heavy impact.
   */
  type?: HapticType;
};

/**
 * Fire the phone's haptic engine (Bankroll host at client version 4+).
 *
 * Decoration only — so unlike every other capability this NEVER rejects: in a
 * plain browser, under a host too old to have it, or on any bridge failure it
 * resolves having done nothing. Call it freely at the moments that deserve
 * weight; never gate anything on it.
 */
async function haptics(input?: HapticsInput): Promise<void> {
  if (status() !== STATUS_READY) return;
  const host = window.bankroll;
  if (!host || typeof host[HAPTICS_METHOD] !== 'function') return;
  try {
    await host.haptics!(input);
  } catch {
    // A vibration that didn't happen is not an error worth surfacing.
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
  charge,
  balances,
  deposit,
  haptics,
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

export interface PlayLinkOptions {
  /**
   * The Bankroll user sharing this link — `session.user.wallet` from a verified
   * session. If the person who opens it is new to Bankroll, they are attributed
   * as that user's referral.
   *
   * Bankroll's referral program is person to person, so this must be a real
   * Bankroll user's wallet: your app's own treasury has no account behind it and
   * is attributed to nobody. Whether it pays out is decided by what the new user
   * does next, not by this link. See
   * https://docs.joinbankroll.com/build/share-links
   */
  referrer?: string;
}

// Build the shareable link that opens an app inside Bankroll. https-only; a
// non-https or unparseable url is a programming error, not a BankrollError.
export function playLink(appUrl: string, options?: PlayLinkOptions): string {
  const parsed = new URL(appUrl);
  if (parsed.protocol !== HTTPS_PROTOCOL) {
    throw new Error(`playLink requires an https:// url, got ${parsed.protocol}`);
  }
  const link = PLAY_LINK_BASE + encodeURIComponent(parsed.href);
  // Not validated here: a wallet's shape is the host's business, and this is a
  // link builder — an unrecognized referrer costs the attribution, never the
  // link. Trimmed so a stray newline out of a template doesn't do that.
  const referrer = options?.referrer?.trim();
  return referrer ? `${link}&ref=${encodeURIComponent(referrer)}` : link;
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
      pay(input: {
        amountCents: number;
        // Host version 3+: refuses the charge if approval takes longer.
        expiresInSeconds?: number;
        memo?: string;
        idempotencyKey?: string;
        // Host version 3+: carried onto the transfer as a read-only account.
        reference?: string;
        token?: string;
      }): Promise<string>;
      // Prerelease host methods (host version >= 2); feature-detected.
      balances?(): Promise<{
        cashCents: number;
        creditsCents: number;
        tokens: Record<string, { amount: number; name: string }>;
      }>;
      deposit?(input?: { method?: string }): Promise<void>;
      // Host version 4+: fire the haptic engine; feature-detected.
      haptics?(input?: { type?: string }): Promise<void>;
    };
    // Legacy marker set by older Bankroll app builds — a presence-only signal
    // used to tell an out-of-date app apart from a standalone browser.
    __BANKROLL_CONFIG__?: unknown;
  }
}
