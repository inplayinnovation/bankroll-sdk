// One JSON request to Bankroll's app APIs under the app's own credential:
// what createManagedReference and createTimer share. Callers turn a
// failure into their own error type; the codes are Bankroll's.
import { loadAppKey, signAppToken } from './app-auth';
import type { Json } from './matchmaking';
import { parseEndpoint, record } from './matchmaking-core';

const API_URL_ENV = 'BANKROLL_API_URL';
const DEFAULT_API_URL = 'https://api.joinbankroll.com';
const REQUEST_TIMEOUT_MS = 15_000;

export type AppRequestCode =
  | 'unauthenticated' // no usable app key, or Bankroll refused the credential
  | 'app_not_verified' // the origin serves no Bankroll-signed manifest
  | 'webhook_not_provisioned' // verified before webhooks existed; a re-sign fixes it
  | 'invalid_argument'
  | 'unavailable' // Bankroll could not be reached; nothing was created
  | 'invalid_response';

const SERVER_CODES = new Set<AppRequestCode>([
  'unauthenticated',
  'app_not_verified',
  'webhook_not_provisioned',
  'invalid_argument',
  'unavailable',
]);

export class AppRequestFailure extends Error {
  constructor(
    readonly code: AppRequestCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AppRequestFailure';
  }
}

export interface AppRequestOptions {
  /** Canonical public HTTPS origin attested by the app's signed manifest. */
  origin: string;
  /** Defaults to BANKROLL_API_URL, then https://api.joinbankroll.com. */
  apiUrl?: string;
  /** Base58 Ed25519 64-byte app secret; defaults to BANKROLL_APP_KEY, then BANKROLL_PUSH_KEY. */
  key?: string;
}

/** POST `body` to `path` as the app; the parsed JSON reply, or an AppRequestFailure. */
export async function postAsApp(path: string, body: Json, options: AppRequestOptions): Promise<Record<string, unknown>> {
  const origin = parseEndpoint(options.origin, true);
  if (origin === null) throw new AppRequestFailure('invalid_argument', 'origin must be a canonical public HTTPS origin');
  const apiUrl = parseEndpoint(options.apiUrl ?? process.env[API_URL_ENV] ?? DEFAULT_API_URL, false);
  if (apiUrl === null) throw new AppRequestFailure('invalid_argument', 'apiUrl must be an HTTPS origin or loopback HTTP origin');
  let token: string;
  try {
    const credential = loadAppKey(options.key);
    if (!credential) throw new Error();
    token = await signAppToken(origin, credential.key);
  } catch {
    throw new AppRequestFailure('unauthenticated', 'A valid app credential is required');
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch {
    throw new AppRequestFailure('unavailable', 'Bankroll could not be reached; nothing was created');
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new AppRequestFailure(
      signal.aborted ? 'unavailable' : 'invalid_response',
      'The reply from Bankroll could not be read',
      response.status,
    );
  }
  if (!response.ok) {
    const code = record(result) ? result.error : undefined;
    if (typeof code === 'string' && SERVER_CODES.has(code as AppRequestCode)) {
      throw new AppRequestFailure(code as AppRequestCode, `Bankroll refused the request: ${code}`, response.status);
    }
    throw new AppRequestFailure('invalid_response', 'Unrecognized refusal from Bankroll', response.status);
  }
  if (!record(result)) throw new AppRequestFailure('invalid_response', 'Malformed reply from Bankroll', response.status);
  return result;
}
