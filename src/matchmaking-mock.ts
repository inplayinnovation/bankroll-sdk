// Matchmaking without Bankroll: the service's documented rules, in this
// process. What a coding agent's dev server and `npm run check` match on.
//
// One thing the service does not do: a ticket nobody has joined after
// MOCK_OPPONENT_DELAY_MS is paired with a stand-in opponent, MOCK_OPPONENT,
// on the ticket's own conditions — a lone tester sees waiting, then matched.
// Cancelling first still wins. State lives in this process and goes with it.
import { randomUUID } from 'node:crypto';

import type { Admission, Json, Match, Matchmaking, Queue, Ticket, TicketInput, TicketPage, TicketQuery } from './matchmaking';
import { finite, invalid, MatchmakingError, record, snapshot } from './matchmaking-core';
import { MOCK_OPPONENT } from './mock';

export const MOCK_OPPONENT_DELAY_MS = 3_000;
const MS_PER_SECOND = 1_000;
const MATCH_ID_PREFIX = 'mock-match-';
const OPPONENT_TICKET_PREFIX = 'mock-opponent-';

type Stored = Ticket & { order: number };

const tickets = new Map<string, Stored>();
const policies = new Map<string, Pick<Queue, 'size' | 'rating'>>();
let admitted = 0;

/** Forget every ticket and queue policy. For tests. */
export function resetMockMatchmaking(): void {
  tickets.clear();
  policies.clear();
  admitted = 0;
}

// JSON equality with object key order ignored, the way the service compares.
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkInput(raw: unknown): TicketInput {
  const value = snapshot(raw);
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.player !== 'string' || !value.player) return invalid();
  const queue = value.queue;
  if (!record(queue) || typeof queue.key !== 'string' || !queue.key || queue.size !== 2 || !('payload' in value)) return invalid();
  if ('rating' in queue) {
    const rating = queue.rating;
    if (!record(rating) || !finite(rating.initial) || rating.initial < 0 || !finite(rating.widenPerSecond) || rating.widenPerSecond <= 0) return invalid();
    if ('max' in rating && (!finite(rating.max) || rating.max < rating.initial)) return invalid();
  }
  if ('rating' in value && !finite(value.rating)) return invalid();
  if ('expiresAt' in value && !finite(value.expiresAt)) return invalid();
  if ('rating' in value && !('rating' in queue)) {
    throw new MatchmakingError('invalid_argument', 'A rated ticket requires a queue rating policy');
  }
  return value as unknown as TicketInput;
}

function policyOf(queue: Queue): Pick<Queue, 'size' | 'rating'> {
  return { size: queue.size, ...(queue.rating ? { rating: queue.rating } : {}) };
}

function expire(stored: Stored, now: number): Stored {
  if (stored.state !== 'waiting') return stored;
  const cutoff = stored.admission.input.expiresAt;
  if (cutoff === undefined || cutoff > now) return stored;
  const expired: Stored = { ...stored, state: 'cancelled', admission: stored.admission, reason: 'expired', cancelledAt: now };
  tickets.set(stored.id, expired);
  return expired;
}

function compatible(waiting: Admission, joining: TicketInput, now: number): boolean {
  if (waiting.input.player === joining.player) return false;
  const policy = waiting.input.queue.rating;
  const waitingRating = waiting.input.rating;
  const joiningRating = joining.rating;
  if (waitingRating === undefined && joiningRating === undefined) return true;
  if (waitingRating === undefined || joiningRating === undefined || !policy) return false;
  const waited = (now - waiting.createdAt) / MS_PER_SECOND;
  const tolerance = Math.min(policy.max ?? Number.POSITIVE_INFINITY, policy.initial + policy.widenPerSecond * waited);
  return Math.abs(joiningRating - waitingRating) <= tolerance;
}

function pair(waiting: Stored & { state: 'waiting' }, joining: Admission, now: number): Match {
  const match: Match = {
    id: `${MATCH_ID_PREFIX}${randomUUID()}`,
    queue: waiting.admission.input.queue.key,
    matchedAt: now,
    // The waiting ticket's conditions win.
    payload: waiting.admission.payload,
    tickets: [waiting.admission, joining],
  };
  tickets.set(waiting.id, { ...waiting, state: 'matched', match });
  return match;
}

// A waiting ticket nobody joined: after the delay, the stand-in joins it.
function standIn(stored: Stored, now: number): Stored {
  if (stored.state !== 'waiting' || now - stored.admission.createdAt < MOCK_OPPONENT_DELAY_MS) return stored;
  const input = stored.admission.input;
  const opponent: TicketInput = {
    id: `${OPPONENT_TICKET_PREFIX}${stored.id}`,
    player: MOCK_OPPONENT,
    queue: input.queue,
    payload: stored.admission.payload,
    ...(input.rating === undefined ? {} : { rating: input.rating }),
  };
  const admission: Admission = { input: opponent, createdAt: now, payload: stored.admission.payload };
  const match = pair(stored, admission, now);
  tickets.set(opponent.id, { id: opponent.id, state: 'matched', admission, match, order: admitted++ });
  return tickets.get(stored.id)!;
}

function current(id: string, now: number): Stored | undefined {
  const stored = tickets.get(id);
  return stored && standIn(expire(stored, now), now);
}

function createTicket(raw: unknown): Ticket {
  const input = checkInput(raw);
  const now = Date.now();
  const existing = current(input.id, now);
  if (existing) {
    if (existing.state === 'cancelled' && existing.admission === null) return existing;
    if (canonical(existing.admission!.input as unknown as Json) !== canonical(input as unknown as Json)) {
      throw new MatchmakingError('ticket_conflict', 'A ticket with this ID was admitted with different fields');
    }
    return existing;
  }
  const policy = policies.get(input.queue.key);
  if (policy && canonical(policy as unknown as Json) !== canonical(policyOf(input.queue) as unknown as Json)) {
    throw new MatchmakingError('queue_conflict', 'This queue was fixed with a different policy by its first entry');
  }
  if (!policy) policies.set(input.queue.key, policyOf(input.queue));
  const admission: Admission = { input, createdAt: now, payload: input.payload };
  if (input.expiresAt !== undefined && input.expiresAt <= now) {
    const cancelled: Stored = { id: input.id, state: 'cancelled', admission, reason: 'expired', cancelledAt: now, order: admitted++ };
    tickets.set(input.id, cancelled);
    return cancelled;
  }
  const candidates = [...tickets.values()]
    .map((stored) => expire(stored, now))
    .filter((stored): stored is Stored & { state: 'waiting' } =>
      stored.state === 'waiting' && stored.admission.input.queue.key === input.queue.key && compatible(stored.admission, input, now))
    .sort((a, b) => a.admission.createdAt - b.admission.createdAt || a.order - b.order);
  const waiting = candidates[0];
  const stored: Stored = waiting
    ? { id: input.id, state: 'matched', admission, match: pair(waiting, admission, now), order: admitted++ }
    : { id: input.id, state: 'waiting', admission, order: admitted++ };
  tickets.set(input.id, stored);
  return stored;
}

function listTickets(raw: unknown): TicketPage {
  const query = snapshot(raw ?? {});
  if (!record(query)) return invalid();
  const { player, id } = query as TicketQuery;
  const now = Date.now();
  const all = [...tickets.keys()].map((key) => current(key, now)!);
  const found = all
    .filter((stored) => (id === undefined || stored.id === id) && (player === undefined || stored.admission?.input.player === player))
    .sort((a, b) => a.order - b.order);
  return { tickets: found.map(strip), nextCursor: null };
}

function cancelTicket(raw: unknown): Extract<Ticket, { state: 'matched' | 'cancelled' }> {
  const value = snapshot(raw);
  if (!record(value) || typeof value.id !== 'string' || !value.id) return invalid();
  const now = Date.now();
  const stored = tickets.get(value.id);
  const settled = stored && expire(stored, now);
  if (!settled) {
    const tombstone: Stored = { id: value.id, state: 'cancelled', admission: null, reason: 'requested', cancelledAt: now, order: admitted++ };
    tickets.set(value.id, tombstone);
    return strip(tombstone) as Extract<Ticket, { state: 'cancelled' }>;
  }
  if (settled.state === 'waiting') {
    const cancelled: Stored = { ...settled, state: 'cancelled', admission: settled.admission, reason: 'requested', cancelledAt: now };
    tickets.set(settled.id, cancelled);
    return strip(cancelled) as Extract<Ticket, { state: 'cancelled' }>;
  }
  return strip(settled) as Extract<Ticket, { state: 'matched' | 'cancelled' }>;
}

function strip(stored: Stored): Ticket {
  const { order: _order, ...ticket } = stored;
  return ticket;
}

export function mockMatchmaking<Payload extends Json = Json>(): Matchmaking<Payload> {
  return {
    createTicket: async (input) => strip(createTicket(input) as Stored) as Ticket<Payload>,
    listTickets: async (query = {}) => listTickets(query) as TicketPage<Payload>,
    cancelTicket: async (id) => cancelTicket({ id }) as Awaited<ReturnType<Matchmaking<Payload>['cancelTicket']>>,
  };
}
