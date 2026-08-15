// Push notifications: your server asks Bankroll to notify one of your users.
//
// Push is a PERMISSIONED capability. Your manifest must declare your push
// public key in `capabilities.push`, and the manifest must be signed by
// Bankroll — ask the Bankroll team. Every request is a short-lived JWT signed
// with your key; Bankroll verifies it against the key your signed manifest
// attests, checks the target is one of your users, and delivers with your
// app's name on the title. You can only reach users who have opened your app.
import { createPrivateKey, type KeyObject } from 'node:crypto';

import bs58 from 'bs58';
import { SignJWT } from 'jose';

// BANKROLL_PUSH_KEY: a base58 Solana-style secret key (64 bytes), the same
// format as BANKROLL_TREASURY_KEY — any freshly generated ed25519 keypair
// works. A separate key on purpose: pushing and paying are different powers.
const PUSH_KEY_ENV = 'BANKROLL_PUSH_KEY';
// Where requests go. Override to target a staging deployment.
const API_URL_ENV = 'BANKROLL_API_URL';
const DEFAULT_API_URL = 'https://api.joinbankroll.com';
const PUSH_PATH = '/api/push';

const PUSH_TYP = 'bankroll-push+jwt';
const PUSH_AUD = 'bankroll-push';
const REQUEST_TTL = '60s';

const SECRET_KEY_BYTES = 64;
const SEED_BYTES = 32;

interface PushKey {
  address: string;
  key: KeyObject;
}

// Keyed on the secret itself, like the treasury cache: correct if the
// environment changes between calls, no re-derive per request.
let cached: { secretKey: string; pushKey: PushKey } | null = null;

function loadPushKey(): PushKey | null {
  const secretKey = process.env[PUSH_KEY_ENV];
  if (!secretKey) return null;
  if (cached?.secretKey !== secretKey) {
    const decoded = bs58.decode(secretKey);
    if (decoded.length !== SECRET_KEY_BYTES) {
      throw new Error(`${PUSH_KEY_ENV} is not a base58 64-byte secret key`);
    }
    const seed = decoded.subarray(0, SEED_BYTES);
    const publicKey = decoded.subarray(SEED_BYTES);
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        crv: 'Ed25519',
        d: Buffer.from(seed).toString('base64url'),
        kty: 'OKP',
        x: Buffer.from(publicKey).toString('base64url'),
      },
    });
    cached = { pushKey: { address: bs58.encode(publicKey), key }, secretKey };
  }
  return cached.pushKey;
}

/**
 * Your push public key, or null when BANKROLL_PUSH_KEY is unset. Derived from
 * the secret, so the key your manifest declares can never drift from the one
 * that signs — pass this to `manifestRoute`'s `push`.
 */
export function pushAddress(): string | null {
  return loadPushKey()?.address ?? null;
}

export type PushErrorCode =
  | 'unauthorized'
  | 'push_not_enabled'
  | 'push_not_declared'
  | 'push_muted'
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

export interface PushInput {
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
 * BANKROLL_PUSH_KEY and a Bankroll-signed manifest declaring its public key.
 */
export async function sendPush(input: PushInput): Promise<void> {
  const pushKey = loadPushKey();
  if (!pushKey) throw new Error(`No push key — set ${PUSH_KEY_ENV}`);

  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error('title must not be empty');
  if (!body) throw new Error('body must not be empty');

  const jwt = await new SignJWT({
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
    .sign(pushKey.key);

  const apiUrl = process.env[API_URL_ENV] || DEFAULT_API_URL;
  const response = await fetch(apiUrl + PUSH_PATH, {
    body: jwt,
    headers: { 'content-type': 'application/jwt' },
    method: 'POST',
  });
  if (!response.ok) {
    const reason = (await response.json().catch(() => ({}))) as { error?: string };
    const code = (reason.error ?? 'unknown') as PushErrorCode;
    throw new PushError(code, `Bankroll refused the push: ${code}`);
  }
}
