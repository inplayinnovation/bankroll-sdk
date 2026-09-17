// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMatchmaking, MatchmakingError, type TicketInput } from '../src/matchmaking';
import { MOCK_OPPONENT_DELAY_MS, resetMockMatchmaking } from '../src/matchmaking-mock';
import { MOCK_OPPONENT } from '../src/mock';

const fetchMock = vi.fn<typeof fetch>();
const START = 1_800_000_000_000;

const entry = (id: string, player: string, extra: Partial<TicketInput<{ target: number }>> = {}): TicketInput<{ target: number }> => ({
  id, player, queue: { key: 'round', size: 2 }, payload: { target: 7 }, ...extra,
});

// The mock never validates the origin: in a sandbox the app is served from
// localhost, which the real client would refuse.
const mm = () => createMatchmaking<{ target: number }>({ origin: 'http://localhost:3000' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubEnv('BANKROLL_MOCK', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BANKROLL_APP_KEY', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetMockMatchmaking();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('mock matchmaking', () => {
  it('stands in only under the mock; otherwise the real client validates the origin', () => {
    vi.stubEnv('BANKROLL_MOCK', undefined);
    expect(() => createMatchmaking({ origin: 'http://localhost:3000' })).toThrow(MatchmakingError);
  });

  it('admits, then pairs the next different player on the waiting ticket\'s conditions, without the network', async () => {
    const first = await mm().createTicket(entry('a', 'alice'));
    expect(first).toEqual({ id: 'a', state: 'waiting', admission: { input: entry('a', 'alice'), createdAt: START, payload: { target: 7 } } });

    vi.setSystemTime(START + 500);
    const second = await mm().createTicket(entry('b', 'bob', { payload: { target: 9 } }));
    expect(second.state).toBe('matched');
    if (second.state !== 'matched') return;
    expect(second.match.payload).toEqual({ target: 7 });
    expect(second.match.queue).toBe('round');
    expect(second.match.tickets.map((t) => t.input.player)).toEqual(['alice', 'bob']);
    // Both see the same, final match; a retry returns state, never a new pairing.
    const again = await mm().createTicket(entry('a', 'alice'));
    expect(again.state === 'matched' && again.match.id).toBe(second.match.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never pairs a player with themselves, and matches the oldest compatible ticket first', async () => {
    await mm().createTicket(entry('a1', 'alice'));
    vi.setSystemTime(START + 10);
    await mm().createTicket(entry('a2', 'alice'));
    vi.setSystemTime(START + 20);
    const bob = await mm().createTicket(entry('b', 'bob'));
    expect(bob.state === 'matched' && bob.match.tickets[0].input.id).toBe('a1');
    expect((await mm().listTickets({ id: 'a2' })).tickets[0]?.state).toBe('waiting');
  });

  it('keeps rated and unrated apart and widens the waiting ticket\'s band over time', async () => {
    const rated = (id: string, player: string, rating: number) =>
      entry(id, player, { queue: { key: 'ranked', size: 2, rating: { initial: 10, widenPerSecond: 5, max: 30 } }, rating });
    await mm().createTicket(rated('w', 'alice', 1000));
    await expect(mm().createTicket(entry('u', 'bob', { queue: { key: 'ranked', size: 2 } }))).rejects.toMatchObject({ code: 'queue_conflict' });
    expect((await mm().createTicket(rated('far', 'bob', 1025))).state).toBe('waiting');
    vi.setSystemTime(START + 4_000);
    const near = await mm().createTicket(rated('near', 'carol', 1020));
    expect(near.state === 'matched' && near.match.tickets[0].input.id).toBe('w');
    await expect(mm().createTicket(entry('r', 'dave', { rating: 5 }))).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('answers identical retries with state and changed fields with ticket_conflict', async () => {
    await mm().createTicket(entry('a', 'alice'));
    expect((await mm().createTicket({ ...entry('a', 'alice'), payload: { target: 7 } })).state).toBe('waiting');
    await expect(mm().createTicket(entry('a', 'alice', { payload: { target: 8 } }))).rejects.toMatchObject({ code: 'ticket_conflict' });
  });

  it('cancels atomically, tombstones unknown ids, and expires on read', async () => {
    const tomb = await mm().cancelTicket('never');
    expect(tomb).toEqual({ id: 'never', state: 'cancelled', admission: null, reason: 'requested', cancelledAt: START });
    expect(await mm().createTicket(entry('never', 'alice'))).toEqual(tomb);

    await mm().createTicket(entry('x', 'alice', { expiresAt: START + 1_000 }));
    vi.setSystemTime(START + 1_000);
    const expired = await mm().listTickets({ player: 'alice' });
    expect(expired.tickets.map((t) => [t.id, t.state, t.state === 'cancelled' && t.reason])).toEqual([['x', 'cancelled', 'expired']]);
    expect(await mm().cancelTicket('x')).toMatchObject({ state: 'cancelled', reason: 'expired' });

    await mm().createTicket(entry('y', 'bob'));
    expect(await mm().cancelTicket('y')).toMatchObject({ id: 'y', state: 'cancelled', reason: 'requested', cancelledAt: START + 1_000 });
    const joined = await mm().createTicket(entry('z', 'carol'));
    expect(joined.state).toBe('waiting');
  });

  it('pairs a lone ticket with the stand-in opponent after the delay, on the ticket\'s own conditions', async () => {
    await mm().createTicket(entry('solo', 'alice', { payload: { target: 3 } }));
    vi.setSystemTime(START + MOCK_OPPONENT_DELAY_MS - 1);
    expect((await mm().createTicket(entry('solo', 'alice', { payload: { target: 3 } }))).state).toBe('waiting');
    vi.setSystemTime(START + MOCK_OPPONENT_DELAY_MS);
    const matched = await mm().createTicket(entry('solo', 'alice', { payload: { target: 3 } }));
    expect(matched.state).toBe('matched');
    if (matched.state !== 'matched') return;
    expect(matched.match.payload).toEqual({ target: 3 });
    expect(matched.match.tickets[1].input.player).toBe(MOCK_OPPONENT);
    // The opponent's ticket is discoverable like any other.
    const theirs = await mm().listTickets({ player: MOCK_OPPONENT });
    expect(theirs.tickets).toHaveLength(1);
    expect(theirs.tickets[0]!.state === 'matched' && theirs.tickets[0]!.match.id).toBe(matched.match.id);
    // Cancelling first still wins.
    await mm().createTicket(entry('quit', 'bob'));
    vi.setSystemTime(START + 2 * MOCK_OPPONENT_DELAY_MS);
    expect((await mm().cancelTicket('quit')).state).toBe('cancelled');
  });

  it('refuses input that is not plain JSON', async () => {
    await expect(mm().createTicket({ ...entry('n', 'alice'), payload: { when: new Date() } } as never)).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(mm().createTicket({ ...entry('n', 'alice'), queue: { key: 'round', size: 3 } } as never)).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});
