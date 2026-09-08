// Push notifications: your server asks Bankroll to notify your users.
//
// Push requires a truthy capability in your Bankroll-signed manifest. With
// BANKROLL_APP_KEY, requests use shared app authentication and a JSON body.
// BANKROLL_PUSH_KEY alone preserves the legacy signed push-request format.
// Bankroll applies the same app audience and delivery policies to both.
import { SignJWT } from 'jose';

import { loadAppKey, signAppToken } from './app-auth';

// Where requests go. Override to target a staging deployment.
const API_URL_ENV = 'BANKROLL_API_URL';
const DEFAULT_API_URL = 'https://api.joinbankroll.com';
const PUSH_PATH = '/api/push';
const BROADCAST_PATH = '/api/push/broadcast';

const PUSH_TYP = 'bankroll-push+jwt';
const BROADCAST_TYP = 'bankroll-push-broadcast+jwt';
const PUSH_AUD = 'bankroll-push';
const REQUEST_TTL = '60s';

/** Your selected app public key, including the legacy BANKROLL_PUSH_KEY fallback. */
export function pushAddress(): string | null {
  return loadAppKey()?.address ?? null;
}

export type PushErrorCode =
  | 'unauthenticated'
  | 'app_not_verified'
  | 'unavailable'
  | 'invalid_request'
  | 'unauthorized'
  | 'push_not_enabled'
  | 'push_not_declared'
  | 'push_muted'
  | 'broadcast_not_configured'
  | 'unknown_user'
  | 'not_your_user'
  | 'invalid_title'
  | 'invalid_body'
  | 'invalid_path'
  | 'unknown';

/** A push Bankroll refused. `code` is the server's stable reason. */
export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

export interface NotifyUserInput {
  /** The recipient — `session.user.wallet` from your verified session. */
  to: string;
  /** Your app's canonical https origin — what your manifest's `sub` claims. */
  origin: string;
  /** Shown after your app's name. Keep it short; platforms truncate. */
  title: string;
  body: string;
  /** Where the tap lands, as a path on YOUR origin. Defaults to '/'. */
  path?: string;
}

/**
 * Send a push to one of your users. Resolves when Bankroll accepted it for
 * delivery; throws PushError with the server's reason otherwise. Requires
 * BANKROLL_APP_KEY (or legacy BANKROLL_PUSH_KEY) and a signed push capability.
 */
export async function notifyUser(input: NotifyUserInput): Promise<void> {
  const pushKey = loadAppKey();
  if (!pushKey) throw new Error('No app key — set BANKROLL_APP_KEY or BANKROLL_PUSH_KEY');

  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error('title must not be empty');
  if (!body) throw new Error('body must not be empty');

  const request: RequestInit = process.env.BANKROLL_APP_KEY !== undefined
    ? {
        body: JSON.stringify({
          to: input.to, title, body,
          ...(input.path !== undefined ? { path: input.path } : {}),
        }),
        headers: {
          authorization: `Bearer ${await signAppToken(input.origin, pushKey.key)}`,
          'content-type': 'application/json',
        },
      }
    : {
        body: await new SignJWT({
          body,
          ...(input.path !== undefined ? { path: input.path } : {}),
          sub: input.to,
          title,
        })
          .setProtectedHeader({ alg: 'EdDSA', typ: PUSH_TYP })
          .setIssuer(input.origin)
          .setAudience(PUSH_AUD)
          .setIssuedAt()
          .setExpirationTime(REQUEST_TTL)
          .sign(pushKey.key),
        headers: { 'content-type': 'application/jwt' },
      };

  const apiUrl = process.env[API_URL_ENV] || DEFAULT_API_URL;
  const response = await fetch(apiUrl + PUSH_PATH, { ...request, method: 'POST' });
  if (!response.ok) {
    const reason = (await response.json().catch(() => ({}))) as { error?: string };
    const code = (reason.error ?? 'unknown') as PushErrorCode;
    throw new PushError(code, `Bankroll refused the push: ${code}`);
  }
}

export interface NotifyAudienceInput {
  /** Your app's canonical https origin — what your manifest's `sub` claims. */
  origin: string;
  /** Shown after your app's name. Keep it short; platforms truncate. */
  title: string;
  body: string;
  /** Where the tap lands, as a path on YOUR origin. Defaults to '/'. */
  path?: string;
}

/**
 * Send a push to your app's recent-user audience — no recipient, Bankroll
 * picks the audience. Resolves when Bankroll accepted it for delivery; throws
 * PushError with the server's reason otherwise. Requires BANKROLL_APP_KEY
 * (or legacy BANKROLL_PUSH_KEY) and a signed push capability.
 */
export async function notifyAudience(input: NotifyAudienceInput): Promise<void> {
  const pushKey = loadAppKey();
  if (!pushKey) throw new Error('No app key — set BANKROLL_APP_KEY or BANKROLL_PUSH_KEY');

  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error('title must not be empty');
  if (!body) throw new Error('body must not be empty');

  const request: RequestInit = process.env.BANKROLL_APP_KEY !== undefined
    ? {
        body: JSON.stringify({
          title, body,
          ...(input.path !== undefined ? { path: input.path } : {}),
        }),
        headers: {
          authorization: `Bearer ${await signAppToken(input.origin, pushKey.key)}`,
          'content-type': 'application/json',
        },
      }
    : {
        body: await new SignJWT({
          body,
          ...(input.path !== undefined ? { path: input.path } : {}),
          title,
        })
          .setProtectedHeader({ alg: 'EdDSA', typ: BROADCAST_TYP })
          .setIssuer(input.origin)
          .setAudience(PUSH_AUD)
          .setIssuedAt()
          .setExpirationTime(REQUEST_TTL)
          .sign(pushKey.key),
        headers: { 'content-type': 'application/jwt' },
      };

  const apiUrl = process.env[API_URL_ENV] || DEFAULT_API_URL;
  const response = await fetch(apiUrl + BROADCAST_PATH, { ...request, method: 'POST' });
  if (!response.ok) {
    const reason = (await response.json().catch(() => ({}))) as { error?: string };
    const code = (reason.error ?? 'unknown') as PushErrorCode;
    throw new PushError(code, `Bankroll refused the broadcast: ${code}`);
  }
}
