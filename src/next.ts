// Next.js server helpers: the three things every Built-for-Bankroll app needs
// on the server and none of which are app-specific — knowing which origin it is
// served from, verifying the session token on a request, and serving the
// manifest that makes it a Bankroll app.
//
// Server-only. `next/headers` throws in a client bundle, so a mistake here
// fails loudly rather than shipping the wrong thing to a browser.
import { headers } from 'next/headers';

import { BANKROLL_TOKEN_HEADER } from './constants';
import { verifyToken, type BankrollSession } from './server';

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * The origin this app is served from, taken from the request's own host — so
 * preview deployments, custom domains, and tunnels all identify themselves
 * correctly with nothing to configure.
 *
 * Throws outside a request. There is no deployment-env fallback on purpose: the
 * answer is only knowable from a request, and guessing it would mint session
 * audiences and manifest `sub` claims for an origin the app isn't being served
 * from.
 *
 * Every route that reaches this must therefore opt out of prerendering with
 * `export const dynamic = 'force-dynamic'`. The SDK cannot declare that for
 * you — Next only reads it from the route file itself.
 */
export async function getOrigin(): Promise<string> {
  const host = (await headers()).get('host');
  if (!host) {
    throw new Error(
      "getOrigin() found no host header, so it is being called outside a request. " +
        "Add `export const dynamic = 'force-dynamic'` to this route: it is built from " +
        'the request, so it cannot be prerendered.',
    );
  }
  // A tunnel and a deployment are both https; only a local dev server isn't.
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Unauthorized extends Error {
  constructor() {
    super('a valid Bankroll session is required');
    this.name = 'Unauthorized';
  }
}

/** The verified session, or null when the token is missing or invalid. */
export async function getSession(request: Request): Promise<BankrollSession | null> {
  return verifyToken(request.headers.get(BANKROLL_TOKEN_HEADER), {
    // The token is minted for this exact origin, so a token issued for some
    // other app can't be replayed here.
    audience: await getOrigin(),
  });
}

export async function requireSession(request: Request): Promise<BankrollSession> {
  const session = await getSession(request);
  if (!session) throw new Unauthorized();
  return session;
}

/**
 * Real money moves only for a verified identity. `identity` is truthy exactly
 * when the user has verified one real identity — gate every paid action on it.
 */
export function requireIdentity(session: BankrollSession): void {
  if (!session.user.identity) {
    throw new Error('identity verification is required for this action');
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestApp {
  /** The app's name, as Bankroll shows it when someone connects. */
  name: () => string;
  /**
   * Where the host boots a connected app. The origin usually serves a landing
   * page rather than the app itself, so without this the host opens the lander.
   */
  launch: string;
  /**
   * The address charges settle to — the treasury. Declared only once it exists,
   * so an app that hasn't finished setup advertises what it can actually honor.
   */
  payments: () => string | null;
  /**
   * The tokens this app issues, keyed by mint address.
   *
   * Declaring a mint is what permits a charge to settle in it: the host lets an
   * app charge HSUSD or the mints it declares, and nothing else, so a hijacked
   * page can never reach a user's unrelated holdings.
   *
   * An app may issue several, and each carries its own display strings — which
   * is why this is a map rather than a single mint. Both `name` and
   * `description` are optional, but a present one must be a non-empty string.
   */
  appTokens?: () => AppTokens;
}

export interface AppToken {
  name?: string;
  description?: string;
}

export type AppTokens = Record<string, AppToken>;

/**
 * Drop entries the host would reject rather than serving a manifest it refuses
 * to parse — an empty string is invalid for either field, and one bad entry
 * takes the whole manifest down with it.
 */
function usableTokens(tokens: AppTokens): AppTokens {
  const usable: AppTokens = {};
  for (const [mint, token] of Object.entries(tokens)) {
    if (!mint) continue;
    usable[mint] = {
      ...(token?.name ? { name: token.name } : {}),
      ...(token?.description ? { description: token.description } : {}),
    };
  }
  return usable;
}

const MANIFEST_VERSION = 1;
const AUDIENCE = 'bankroll-app-host';
const CONTENT_TYPE = 'application/jwt';

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The route handler for /.well-known/bankroll.jwt. Serving this from your
 * origin is what makes an app a Bankroll app — there is nothing to register and
 * no key to sign it with: the host fetches it and binds it to the origin by
 * checking `sub`.
 *
 * Your app ICON is not in the manifest: serve a square PNG at the fixed path
 * /.well-known/bankroll-icon.png. Until you do, Bankroll shows a monogram.
 */
export function manifestRoute(app: ManifestApp): () => Promise<Response> {
  return async function GET(): Promise<Response> {
    const name = app.name();
    const payments = app.payments();
    const appTokens = usableTokens(app.appTokens?.() ?? {});

    // An unsecured JWT (alg: none, empty signature) — the origin it is served
    // from is the proof, not a signature.
    const header = { alg: 'none', typ: 'bankroll-app-manifest+jwt' };
    const payload = {
      // Omitted entirely when the app issues no tokens: an absent claim means
      // only HSUSD may settle its charges, which is not the same as an empty one.
      ...(Object.keys(appTokens).length > 0 ? { appTokens } : {}),
      aud: AUDIENCE,
      capabilities: payments ? { session: true, payments } : { session: true },
      launch: app.launch,
      manifestVersion: MANIFEST_VERSION,
      name,
      sub: await getOrigin(),
    };

    return new Response(`${base64url(header)}.${base64url(payload)}.`, {
      headers: { 'content-type': CONTENT_TYPE },
    });
  };
}
