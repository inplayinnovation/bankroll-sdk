// Server-side verification of the bankroll identity token: an RS256 JWT minted
// by the bankroll api, sent by the host app as a passive per-request header, and
// verified here against bankroll's public JWKS. This module is fully standalone —
// it depends only on `jose` and never imports the client half of the SDK.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ALG = 'RS256';
const ISSUER = 'https://joinbankroll.com';
const DEFAULT_JWKS_URL = 'https://joinbankroll.com/.well-known/jwks.json';

export interface VerifiedToken {
  sub: string;
  username?: string;
  geo?: string;
  /**
   * Identity/KYC verification state — three distinct cases:
   *   ABSENT  — never verified (claim omitted)
   *   false   — verification failed (rejected)
   *   object  — APPROVED ({} = approved but no DOB on file, { age } = approved with age)
   * Check with `typeof identity === 'object'`; gating on mere presence wrongly
   * passes rejected users (whose value is `false`, which is also "present").
   */
  identity?: { age?: number } | false;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
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

// The verification claim may arrive as `identity` or as `kyc` (the name the
// public token docs use); the SDK accepts both and always exposes `identity`.
function mapIdentity(raw: unknown): { age?: number } | false | undefined {
  if (raw === false) return false;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const age = (raw as Record<string, unknown>).age;
    return typeof age === 'number' ? { age } : {};
  }
  return undefined;
}

export async function verifyToken(
  token: string | null | undefined,
  options: { audience: string; jwksUrl?: string },
): Promise<VerifiedToken | null> {
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
  const { iat, exp } = payload;
  if (typeof iat !== 'number' || typeof exp !== 'number') return null;

  const result: VerifiedToken = {
    sub,
    aud: options.audience,
    iss: ISSUER,
    iat,
    exp,
  };
  if (typeof payload.username === 'string') result.username = payload.username;
  if (typeof payload.geo === 'string') result.geo = payload.geo;

  const identity = mapIdentity(payload.identity !== undefined ? payload.identity : payload.kyc);
  if (identity !== undefined) result.identity = identity;

  return result;
}
