import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import bs58 from 'bs58';
import { SignJWT } from 'jose';

interface AppKey {
  address: string;
  key: KeyObject;
}

// Cache the selected secret, so changing either environment key takes effect.
let cached: { secretKey: string; appKey: AppKey } | null = null;

/** An explicit key, then BANKROLL_APP_KEY, then the legacy BANKROLL_PUSH_KEY. */
export function loadAppKey(secretKey?: string): AppKey | null {
  const selected = secretKey !== undefined
    ? secretKey
    : process.env.BANKROLL_APP_KEY ?? process.env.BANKROLL_PUSH_KEY;
  if (selected === undefined) return null;
  if (cached?.secretKey === selected) return cached.appKey;
  try {
    const decoded = bs58.decode(selected);
    if (decoded.length !== 64) throw new Error();
    // Import only the seed so Node derives the public key independently.
    const key = createPrivateKey({
      format: 'der',
      type: 'pkcs8',
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        decoded.subarray(0, 32),
      ]),
    });
    const publicKey = createPublicKey(key).export({ format: 'jwk' });
    const publicBytes = Buffer.from(publicKey.x!, 'base64url');
    if (!publicBytes.equals(decoded.subarray(32))) throw new Error();
    const appKey = { address: bs58.encode(publicBytes), key };
    cached = { secretKey: selected, appKey };
    return appKey;
  } catch {
    throw new Error('Invalid app key: expected a base58 64-byte Ed25519 secret key with a matching public key');
  }
}

/** Your app public key, or null when neither app nor legacy push key is set. */
export function appAddress(): string | null {
  return loadAppKey()?.address ?? null;
}

/** A short-lived identity credential, reusable across Bankroll API endpoints. */
export function signAppToken(origin: string, key: KeyObject): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', typ: 'bankroll-app-auth+jwt' })
    .setIssuer(origin)
    .setAudience('bankroll-api')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(key);
}
