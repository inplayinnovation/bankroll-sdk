// A PaymentSigner for a Bankroll server wallet: a Privy wallet Bankroll
// created for this app, owned by the creator, with this app's P-256 key as
// its only signer under a payout policy. The app signs each Privy request
// with that key; Bankroll's relay verifies the signature, adds Privy's app
// credentials — which never leave Bankroll — and passes Privy's answer back.
// Privy's enclave checks the policy, sponsors, signs and broadcasts.
//
// Nothing here can pre-sign: the bytes that land are re-signed at Privy with
// a fresh blockhash, so bookkeeping keeps a `reference` (buildPayout) and
// finds the landed payout with findPayoutByReference.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

const PRIVY_REPLAY_WINDOW_MS = 24 * 60 * 60_000;

import { PayError, type PaymentSigner } from './payouts';

const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PRIVY_API = 'https://api.privy.io';
const DEFAULT_API_URL = 'https://api.joinbankroll.com';
const DEFAULT_REQUEST_EXPIRY_MS = 5 * 60_000;
// Privy hands out authorization keys in this form; the bare base64 works too.
const KEY_PREFIX = 'wallet-auth:';

export interface DelegatedPrivySignerOptions {
  /** The server wallet's address, the app's payee. Default: BANKROLL_PAYEE. */
  payee?: string;
  /** The app's P-256 private key, base64 PKCS8 (`wallet-auth:` prefix optional). Default: BANKROLL_DELEGATED_KEY. */
  privateKey?: string;
  /** The server wallet's Privy wallet id. Default: BANKROLL_DELEGATED_WALLET_ID. */
  walletId?: string;
  /** Bankroll's Privy app id, part of every signed request. Default: BANKROLL_PRIVY_APP_ID. */
  privyAppId?: string;
  /** The Bankroll api hosting the relay. Default: BANKROLL_API_URL, then https://api.joinbankroll.com. */
  apiUrl?: string;
  /**
   * Forwarded to Privy as the idempotency key — name one logical payout and
   * Privy dedupes retries for 24h (the same key resolves with the original
   * signature instead of broadcasting again).
   */
  idempotencyKey?: string;
  /** How long a signed request stays valid, in ms. Default 5 minutes. */
  requestExpiryMs?: number;
}

export type DelegatedPrivySignerErrorCode =
  | 'policy_denied' // the server wallet's policy refused the transaction (over the cap, wrong mint, wrong program)
  | 'bad_key' // the relay rejected the signature: the key in BANKROLL_DELEGATED_KEY is not this wallet's signer
  | 'unknown_wallet' // the relay knows no server wallet with this id
  | 'relay_error'; // any other refusal; `status` and `body` carry the answer

/** Why the relay or Privy refused. Always the `cause` of the PayError thrown. */
export class DelegatedPrivySignerError extends Error {
  readonly code: DelegatedPrivySignerErrorCode;
  readonly status: number;
  readonly body: unknown;

  constructor(code: DelegatedPrivySignerErrorCode, status: number, body: unknown) {
    super(`server wallet payout refused (${code}, HTTP ${status}): ${JSON.stringify(body)}`);
    this.name = 'DelegatedPrivySignerError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePrivateKey(raw: string): KeyObject {
  const base64 = raw.startsWith(KEY_PREFIX) ? raw.slice(KEY_PREFIX.length) : raw;
  try {
    return createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (cause) {
    throw new Error('BANKROLL_DELEGATED_KEY is not a base64 PKCS8 P-256 private key', { cause });
  }
}

// RFC 8785 canonical JSON — what Privy hashes before verifying a signature:
// keys sorted, no whitespace, JSON primitives as ECMAScript serializes them.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function refusalCode(status: number, body: unknown): DelegatedPrivySignerErrorCode {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  if (code === 'policy_violation') return 'policy_denied';
  if (code === 'bad_key' || status === 401) return 'bad_key';
  if (code === 'unknown_wallet' || status === 404) return 'unknown_wallet';
  return 'relay_error';
}

/**
 * A PaymentSigner backed by the app's server wallet, for `pay()`'s
 * `options.signer`. Explicit: nothing else in the SDK picks it up from the
 * env, and `treasurySigner()` stays the keypair. Nothing is looked up either —
 * the address, key, wallet id and app id are all configured at provisioning.
 */
export function delegatedPrivySigner(options?: DelegatedPrivySignerOptions): PaymentSigner {
  const address = requireOption(options?.payee ?? process.env.BANKROLL_PAYEE, 'BANKROLL_PAYEE');
  const key = parsePrivateKey(
    requireOption(options?.privateKey ?? process.env.BANKROLL_DELEGATED_KEY, 'BANKROLL_DELEGATED_KEY'),
  );
  const walletId = requireOption(
    options?.walletId ?? process.env.BANKROLL_DELEGATED_WALLET_ID,
    'BANKROLL_DELEGATED_WALLET_ID',
  );
  const privyAppId = requireOption(
    options?.privyAppId ?? process.env.BANKROLL_PRIVY_APP_ID,
    'BANKROLL_PRIVY_APP_ID',
  );
  const apiUrl = (options?.apiUrl ?? process.env.BANKROLL_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const idempotencyKey = options?.idempotencyKey;
  // Privy replays a same-key, same-body send for 24 hours instead of executing it again.
  const replayWindowMs = idempotencyKey !== undefined ? PRIVY_REPLAY_WINDOW_MS : undefined;
  const requestExpiryMs = options?.requestExpiryMs ?? DEFAULT_REQUEST_EXPIRY_MS;

  return {
    address,
    ...(replayWindowMs === undefined ? {} : { replayWindowMs }),
    async sendTransaction(txBase64: string): Promise<string> {
      // The exact request Privy will verify: this body, these headers, at
      // Privy's own URL. The relay rebuilds it from what it receives.
      const body = {
        method: 'signAndSendTransaction',
        caip2: SOLANA_MAINNET_CAIP2,
        sponsor: true,
        params: { transaction: txBase64, encoding: 'base64' },
      };
      const headers: Record<string, string> = {
        'privy-app-id': privyAppId,
        'privy-request-expiry': String(Date.now() + requestExpiryMs),
        ...(idempotencyKey !== undefined ? { 'privy-idempotency-key': idempotencyKey } : {}),
      };
      const payload = canonicalize({
        version: 1,
        method: 'POST',
        url: `${PRIVY_API}/v1/wallets/${walletId}/rpc`,
        body,
        headers,
      });
      const signature = sign('sha256', Buffer.from(payload), key).toString('base64');

      let response: Response;
      try {
        response = await fetch(`${apiUrl}/api/v1/server-wallets/${walletId}/rpc`, {
          method: 'POST',
          headers: {
            ...headers,
            'privy-authorization-signature': signature,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        // The request may or may not have reached the relay: the outcome is
        // unknown, and only the reference can answer it.
        throw new PayError('rpc_error', 'the relay could not be reached — outcome unknown', { cause });
      }

      const text = await response.text();
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        answer = { error: text };
      }

      if (response.status >= 500) {
        throw new PayError('rpc_error', `the relay answered HTTP ${response.status} — outcome unknown`, {
          cause: new DelegatedPrivySignerError('relay_error', response.status, answer),
        });
      }
      if (!response.ok) {
        // A refusal, from the relay or from Privy: nothing was sent.
        const refusal = new DelegatedPrivySignerError(refusalCode(response.status, answer), response.status, answer);
        throw new PayError('send_failed', refusal.message, { cause: refusal });
      }
      const hash = (answer as { data?: { hash?: unknown } }).data?.hash;
      if (typeof hash !== 'string') {
        throw new PayError('rpc_error', 'the relay answered without a signature — outcome unknown', {
          cause: new DelegatedPrivySignerError('relay_error', response.status, answer),
        });
      }
      return hash;
    },
  };
}
