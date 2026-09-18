import { loadAppKey, signAppToken } from './app-auth';
import { parseEndpoint } from './matchmaking-core';
import { finite, invalid, MatchmakingError, record, snapshot, type MatchmakingErrorCode } from './matchmaking-core';
import { mockMatchmaking } from './matchmaking-mock';
import { mockEnabled } from './mock';

export { MatchmakingError, type MatchmakingErrorCode } from './matchmaking-core';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Queue {
  key: string;
  size: 2;
  rating?: { initial: number; widenPerSecond: number; max?: number };
}
export interface TicketInput<Payload extends Json = Json> {
  /** Caller-chosen ID, unique across this app. Never reuse it for another entry. */
  id: string;
  player: string;
  queue: Queue;
  /** Proposed conditions. A joining entry adopts the waiting entry's payload. */
  payload: Payload;
  rating?: number;
  /** Optional app-selected matching cutoff, in epoch milliseconds. */
  expiresAt?: number;
}
export interface Admission<Payload extends Json = Json> {
  input: TicketInput<Payload>;
  createdAt: number;
  payload: Payload;
}
export interface Match<Payload extends Json = Json> {
  id: string;
  queue: string;
  matchedAt: number;
  payload: Payload;
  tickets: [Admission<Payload>, Admission<Payload>];
}
export type Ticket<Payload extends Json = Json> = { id: string } & (
  | { state: 'waiting'; admission: Admission<Payload> }
  | { state: 'matched'; admission: Admission<Payload>; match: Match<Payload> }
  | { state: 'cancelled'; admission: Admission<Payload> | null; reason: 'requested' | 'expired'; cancelledAt: number }
);
export interface TicketQuery { player?: string; id?: string; cursor?: string }
export interface TicketPage<Payload extends Json = Json> { tickets: Ticket<Payload>[]; nextCursor: string | null }
export type MatchmakingRequest<Payload extends Json = Json> =
  | { operation: 'createTicket'; input: TicketInput<Payload> }
  | { operation: 'listTickets'; input: TicketQuery }
  | { operation: 'cancelTicket'; input: { id: string } };
export interface Matchmaking<Payload extends Json = Json> {
  /** Identical retries return current state; changed fields conflict. Matches are final. */
  createTicket(input: TicketInput<Payload>): Promise<Ticket<Payload>>;
  /** App-wide discovery, including terminal tickets. Follow nextCursor to recover lost IDs. */
  listTickets(query?: TicketQuery): Promise<TicketPage<Payload>>;
  /** Atomic against pairing. Unknown IDs become permanent cancellation tombstones. */
  cancelTicket(id: string): Promise<Extract<Ticket<Payload>, { state: 'matched' | 'cancelled' }>>;
}
export interface MatchmakingOptions {
  /** Canonical public HTTPS origin attested by the app's signed manifest. */
  origin: string;
  /** Defaults to BANKROLL_API_URL, then https://api.joinbankroll.com. */
  apiUrl?: string;
  /** Base58 Ed25519 64-byte app secret; defaults to BANKROLL_APP_KEY, then BANKROLL_PUSH_KEY. */
  key?: string;
}
const SERVER_CODES = new Set<MatchmakingErrorCode>([
  'unauthenticated', 'app_not_verified', 'invalid_argument', 'ticket_conflict', 'queue_conflict', 'unavailable',
]);
function endpoint(value: string, issuer: boolean): string {
  const parsed = parseEndpoint(value, issuer);
  if (parsed === null) {
    throw new MatchmakingError('invalid_argument', issuer ? 'origin must be a canonical public HTTPS origin' : 'apiUrl must be an HTTPS origin or loopback HTTP origin');
  }
  return parsed;
}
function admission(value: unknown): value is Admission {
  if (!record(value) || !record(value.input) || !record(value.input.queue)) return false;
  return typeof value.input.id === 'string' && typeof value.input.player === 'string'
    && typeof value.input.queue.key === 'string' && value.input.queue.size === 2
    && 'payload' in value.input && 'payload' in value && finite(value.createdAt);
}
function ticket(value: unknown): value is Ticket {
  if (!record(value) || typeof value.id !== 'string') return false;
  if (value.state === 'cancelled') return (value.admission === null || (admission(value.admission) && value.admission.input.id === value.id))
    && (value.reason === 'requested' || value.reason === 'expired') && finite(value.cancelledAt);
  if (!admission(value.admission) || value.admission.input.id !== value.id) return false;
  if (value.state === 'waiting') return true;
  if (value.state !== 'matched' || !record(value.match)) return false;
  return typeof value.match.id === 'string' && typeof value.match.queue === 'string' && finite(value.match.matchedAt)
    && 'payload' in value.match && Array.isArray(value.match.tickets) && value.match.tickets.length === 2
    && value.match.tickets.every(admission);
}

/** Server-only client. Calls are never retried: an unavailable/invalid_response
 * result may hide a committed operation. Retry the same input or discover it.
 *
 * With BANKROLL_MOCK=1 outside production this is the in-process stand-in
 * from `@joinbankroll/sdk/mock` instead: the same rules, no Bankroll, no
 * key, and a stand-in opponent for a ticket nobody joins. */
export function createMatchmaking<Payload extends Json = Json>(options: MatchmakingOptions): Matchmaking<Payload> {
  if (mockEnabled()) return mockMatchmaking<Payload>();
  const origin = endpoint(options.origin, true);
  const apiUrl = endpoint(options.apiUrl ?? process.env.BANKROLL_API_URL ?? 'https://api.joinbankroll.com', false);
  const explicitKey = options.key;
  async function request(operation: MatchmakingRequest['operation'], input: unknown): Promise<unknown> {
    let body: string;
    let sent: Json;
    try { sent = snapshot(input); body = JSON.stringify({ operation, input: sent }); }
    catch { return invalid(); }
    let token: string;
    try {
      const credential = loadAppKey(explicitKey);
      if (!credential) throw new Error();
      token = await signAppToken(origin, credential.key);
    } catch { throw new MatchmakingError('unauthenticated', 'A valid app credential is required'); }
    const signal = AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/matchmaking`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body, cache: 'no-store', redirect: 'error', signal,
      });
    } catch { throw new MatchmakingError('unavailable', 'Matchmaking outcome is unknown; retry the same input or list tickets'); }
    let result: unknown;
    try { result = await response.json(); }
    catch {
      throw new MatchmakingError(signal.aborted ? 'unavailable' : 'invalid_response', 'Matchmaking reply could not be read; outcome is unknown', response.status);
    }
    if (!response.ok) {
      const code = record(result) ? result.error : undefined;
      if (typeof code === 'string' && SERVER_CODES.has(code as MatchmakingErrorCode)) {
        throw new MatchmakingError(code as MatchmakingErrorCode, `Bankroll refused matchmaking: ${code}`, response.status);
      }
      throw new MatchmakingError('invalid_response', 'Unrecognized matchmaking refusal; outcome is unknown', response.status);
    }
    try { snapshot(result); }
    catch { throw new MatchmakingError('invalid_response', 'Invalid JSON in matchmaking reply; outcome is unknown', response.status); }
    const valid = operation === 'listTickets'
      ? record(result) && Array.isArray(result.tickets) && result.tickets.every(ticket) && (result.nextCursor === null || typeof result.nextCursor === 'string')
      : ticket(result) && record(sent) && result.id === sent.id && (operation !== 'cancelTicket' || result.state !== 'waiting');
    if (!valid) throw new MatchmakingError('invalid_response', 'Malformed matchmaking reply; outcome is unknown', response.status);
    return result;
  }
  return {
    createTicket: (input) => request('createTicket', input) as Promise<Ticket<Payload>>,
    listTickets: (query = {}) => request('listTickets', query) as Promise<TicketPage<Payload>>,
    cancelTicket: (id) => request('cancelTicket', { id }) as ReturnType<Matchmaking<Payload>['cancelTicket']>,
  };
}
