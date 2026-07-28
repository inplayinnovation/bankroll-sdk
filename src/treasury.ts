// The treasury: the app's one secret.
//
// BANKROLL_TREASURY_KEY is a base58 Solana secret key. An app runs fine without
// one — it just can't take or send money, and says so in its manifest — so
// every accessor here answers "not configured" rather than throwing, except
// requireTreasury(), which is what a money path calls.
import { keypairSigner, type PaymentSigner } from './payouts';

// Keyed on the secret itself rather than a bare boolean: the signer is
// deterministic in its key, so this stays correct if the environment changes
// between calls (a test, a script that loads .env late) while still avoiding a
// base58 decode on every request.
let cached: { secretKey: string; signer: PaymentSigner } | null = null;

/** The treasury signer, or null when BANKROLL_TREASURY_KEY is unset. */
export function treasurySigner(): PaymentSigner | null {
  const secretKey = process.env.BANKROLL_TREASURY_KEY;
  if (!secretKey) return null;
  if (cached?.secretKey !== secretKey) {
    cached = { secretKey, signer: keypairSigner(secretKey) };
  }
  return cached.signer;
}

/**
 * The treasury's public address, or null when unconfigured. Derived from the
 * secret key, so the payment address a manifest advertises can never drift from
 * the wallet that actually signs.
 */
export function treasuryAddress(): string | null {
  return treasurySigner()?.address ?? null;
}

/** Fails with the setup instruction rather than a cryptic decode error. */
export function requireTreasury(): PaymentSigner {
  const signer = treasurySigner();
  if (!signer) throw new Error('No treasury — set BANKROLL_TREASURY_KEY');
  return signer;
}
