// Server-side verification of the bankroll session token: an RS256 JWT minted
// by the bankroll api, sent by the host app as a passive per-request header, and
// verified here against bankroll's public JWKS. This entry is fully standalone —
// it depends only on `jose` and never imports the client half of the SDK.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export {
  BASE_UNITS_PER_CENT,
  ConfirmChargeError,
  HSUSD_DECIMALS,
  HSUSD_MINT,
  confirmCharge,
  type ConfirmChargeErrorCode,
  type ConfirmChargeOptions,
  type ConfirmedCharge,
} from './charges';

export {
  PayError,
  buildPayout,
  confirmPayout,
  keypairSigner,
  pay,
  sendPayout,
  type BuiltPayout,
  type ConfirmPayoutOptions,
  type PayErrorCode,
  type PayInput,
  type PaymentSigner,
  type PayoutOptions,
} from './payouts';

const ALG = 'RS256';
const ISSUER = 'https://joinbankroll.com';
const DEFAULT_JWKS_URL = 'https://joinbankroll.com/.well-known/jwks.json';

export interface BankrollSession {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  /** The user's region for THIS session (current location, not their residence). */
  geo?: string;
  user: {
    /** The user's wallet address (the JWT `sub`) — their stable id and payout target. */
    wallet: string;
    /** The user's Bankroll handle — always present (the host guarantees it per app token). */
    username: string;
    /**
     * Identity verification state, always present:
     *   false     — not verified (pending, never verified, or rejected)
     *   { age }   — verified ({} if the user's DOB isn't on file)
     * Truthy ⟺ the user has verified exactly one real identity. Gate real-money
     * actions on truthiness.
     */
    identity: { age?: number } | false;
  };
}

// jose handles JWKS caching, kid selection across multi-kid sets, and
// cooldown-limited refetch on an unknown kid; we only memoize one key source
// per JWKS URL so those internals are shared across calls.
const keySources = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getKeySource(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = keySources.get(jwksUrl);
  if (cached) return cached;
  const keySource = createRemoteJWKSet(new URL(jwksUrl));
  keySources.set(jwksUrl, keySource);
  return keySource;
}

// The verification claim may arrive as `identity` or as `kyc` (the wire name);
// accept both. A truthy object ({ age }) is verified; anything else — false,
// omitted, or malformed — collapses to `false` (not verified).
function mapIdentity(raw: unknown): { age?: number } | false {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const age = (raw as Record<string, unknown>).age;
    return typeof age === 'number' ? { age } : {};
  }
  return false;
}

export async function verifyToken(
  token: string | null | undefined,
  options: { audience: string; jwksUrl?: string },
): Promise<BankrollSession | null> {
  // Misconfiguration is a programmer error, not a bad token — throw, don't fail closed.
  if (!options.audience) throw new Error('audience is required');

  // A missing/blank header is the common unauthenticated case: no token, no
  // network hit, just null so callers can guard in one line.
  if (token == null || token.trim() === '') return null;

  const jwksUrl = options.jwksUrl ?? DEFAULT_JWKS_URL;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getKeySource(jwksUrl), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: options.audience,
    }));
  } catch {
    // FAIL CLOSED: any verification failure (bad signature, wrong issuer/audience,
    // expired, unknown kid, structural garbage) → null. This is the one
    // deliberate exception-swallow in this module; a bad token must never throw.
    return null;
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  const { username, iat, exp } = payload;
  // The host guarantees a username on every app token (the mint throws
  // otherwise), so a token without one is malformed — fail closed.
  if (typeof username !== 'string' || username.length === 0) return null;
  if (typeof iat !== 'number' || typeof exp !== 'number') return null;

  const result: BankrollSession = {
    iss: ISSUER,
    aud: options.audience,
    iat,
    exp,
    user: {
      wallet: sub,
      username,
      identity: mapIdentity(payload.identity !== undefined ? payload.identity : payload.kyc),
    },
  };
  if (typeof payload.geo === 'string') result.geo = payload.geo;

  return result;
}
