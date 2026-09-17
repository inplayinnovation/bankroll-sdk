// Next.js server helpers: the three things every Built-for-Bankroll app needs
// on the server and none of which are app-specific — knowing which origin it is
// served from, verifying the session token on a request, and serving the
// manifest that makes it a Bankroll app.
//
// Server-only. `next/headers` throws in a client bundle, so a mistake here
// fails loudly rather than shipping the wrong thing to a browser.
import { headers } from 'next/headers';

import { appAddress } from './app-auth';
import { BANKROLL_TOKEN_HEADER } from './constants';
import { MANIFEST_TYP, manifestClaims, type AppTokens } from './manifest';
import { mockEnabled, mockSession } from './mock';
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

/**
 * The verified session, or null when the token is missing or invalid.
 *
 * With BANKROLL_MOCK=1 outside production, a token from `@joinbankroll/sdk/mock`
 * is accepted too, so the app's routes run under a test's fake host. A
 * production build never reads the flag.
 */
export async function getSession(request: Request): Promise<BankrollSession | null> {
  const token = request.headers.get(BANKROLL_TOKEN_HEADER);
  if (mockEnabled()) {
    const mocked = mockSession(token);
    if (mocked) return mocked;
  }
  return verifyToken(token, {
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
  /** App signing public key. Defaults to BANKROLL_APP_KEY or legacy BANKROLL_PUSH_KEY. */
  appKey?: () => string | null;
  /**
   * Where your users get help. Bankroll offers it in the app's own menu, and
   * opening it hands the URL to the operating system — so a help page, a
   * `mailto:`, a `tel:`, or a chat invite all work, and whichever app claims
   * that link opens it.
   *
   * It may point anywhere; support desks usually live on somebody else's
   * domain. Declaring nothing simply means no menu item.
   *
   * Changing it later re-asks every existing user for consent, because a grant
   * is bound to the exact manifest it was made against — so set it to something
   * durable, like a page you control that redirects, rather than a link you
   * expect to rotate.
   */
  supportUrl?: () => string | null;
  /**
   * A Subresource Integrity hash of the icon served at
   * /.well-known/bankroll-icon.png — `sha256-<base64>` of the exact bytes.
   * Declare it when you replace the icon: a changed digest is a manifest
   * change, which is what carries the new icon to users who already connected.
   * Omitted from the payload when it resolves to null — omit it whenever you
   * serve no icon.
   */
  iconDigest?: () => string | null;
  /**
   * Consent to push notifications. A legacy public key remains accepted;
   * new apps can return true and authenticate with the top-level appKey.
   * Bankroll must sign the manifest before push is enabled.
   */
  push?: () => boolean | string | null;
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

export type { AppToken, AppTokens } from './manifest';

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
export function manifestRoute(app: ManifestApp): (request?: Request) => Promise<Response> {
  return async function GET(request?: Request): Promise<Response> {
    // A Bankroll-signed manifest is served VERBATIM — the signature covers
    // exact bytes, so nothing below may touch it. Any claim change means
    // Bankroll re-signing and replacing this value. The one exception is
    // ?signing=1 — the manifest:sign fetch — which gets the BUILT manifest, so
    // a claims change is signable while the old blob still serves.
    const signing = request ? new URL(request.url).searchParams.has('signing') : false;
    const signed = process.env.BANKROLL_SIGNED_MANIFEST;
    if (signed && !signing) {
      return new Response(signed, { headers: { 'content-type': CONTENT_TYPE } });
    }

    // An unsecured JWT (alg: none, empty signature) — the origin it is served
    // from is the proof, not a signature.
    const header = { alg: 'none', typ: MANIFEST_TYP };
    const payload = manifestClaims({
      origin: await getOrigin(),
      name: app.name(),
      launch: app.launch,
      payments: app.payments(),
      appKey: (app.appKey ?? appAddress)(),
      push: app.push?.(),
      supportUrl: app.supportUrl?.(),
      iconDigest: app.iconDigest?.(),
      appTokens: app.appTokens?.(),
    });

    return new Response(`${base64url(header)}.${base64url(payload)}.`, {
      headers: { 'content-type': CONTENT_TYPE },
    });
  };
}
