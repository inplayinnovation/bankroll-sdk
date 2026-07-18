// Drop-in PaymentSigner for Privy server wallets. Signing and broadcast happen
// at Privy with sponsorship on by default, so the treasury holds no SOL and
// the key never leaves Privy. Lives on its own entry point with @privy-io/node
// as an OPTIONAL peer dependency — only apps importing '@joinbankroll/sdk/privy'
// need it installed.
import { PrivyClient } from '@privy-io/node';

import type { PaymentSigner } from './payouts';

const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export interface PrivySignerOptions {
  /** Privy wallet id of the treasury. Default: PRIVY_WALLET_ID. */
  walletId?: string;
  /** Privy app credentials. Defaults: PRIVY_APP_ID / PRIVY_APP_SECRET. */
  appId?: string;
  appSecret?: string;
  /**
   * Forwarded to Privy as `idempotency_key` — name one logical payout and
   * Privy dedupes retries for 24h (same key resolves with the original
   * signature instead of broadcasting again).
   */
  idempotencyKey?: string;
  /** Privy pays the network fee and token-account rent. Default true. */
  sponsor?: boolean;
}

// Wallet addresses are immutable, so each wallet id resolves once per process.
const addressCache = new Map<string, Promise<string>>();

function requireOption(value: string | undefined, name: string): string {
  // Misconfiguration is a programmer error — throw plain, like the rest of
  // the server entry.
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * A PaymentSigner backed by a Privy server wallet, for `pay()`'s
 * `options.signer`. Resolves the wallet's address from Privy (cached per
 * process), then signs and broadcasts each transaction at Privy.
 */
export async function privySigner(options?: PrivySignerOptions): Promise<PaymentSigner> {
  const appId = requireOption(options?.appId ?? process.env.PRIVY_APP_ID, 'PRIVY_APP_ID');
  const appSecret = requireOption(
    options?.appSecret ?? process.env.PRIVY_APP_SECRET,
    'PRIVY_APP_SECRET',
  );
  const walletId = requireOption(
    options?.walletId ?? process.env.PRIVY_WALLET_ID,
    'PRIVY_WALLET_ID',
  );
  const sponsor = options?.sponsor ?? true;
  const idempotencyKey = options?.idempotencyKey;

  const privy = new PrivyClient({ appId, appSecret });

  const cacheKey = `${appId}:${walletId}`;
  let addressPromise = addressCache.get(cacheKey);
  if (!addressPromise) {
    addressPromise = privy
      .wallets()
      .get(walletId)
      .then((wallet) => wallet.address);
    addressCache.set(cacheKey, addressPromise);
    // A failed lookup must not poison the cache.
    addressPromise.catch(() => addressCache.delete(cacheKey));
  }
  const address = await addressPromise;

  return {
    address,
    async sendTransaction(txBase64: string): Promise<string> {
      const { hash } = await privy
        .wallets()
        .solana()
        .signAndSendTransaction(walletId, {
          caip2: SOLANA_MAINNET_CAIP2,
          transaction: txBase64,
          sponsor,
          ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
        });
      return hash;
    },
  };
}
