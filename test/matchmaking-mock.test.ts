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

  it('gives the joining ticket the waiting ticket\'s payload, as the service does, and keeps its own proposal in the input', async () => {
    await mm().createTicket(entry('a', 'alice'));
    const joined = await mm().createTicket(entry('b', 'bob', { payload: { target: 9 } }));
    expect(joined.state).toBe('matched');
    if (joined.state !== 'matched') return;
    // What bob asked for stays as sent; what bob plays is alice's round.
    expect(joined.admission.input.payload).toEqual({ target: 9 });
    expect(joined.admission.payload).toEqual({ target: 7 });
    expect(joined.match.tickets.map((t) => t.payload)).toEqual([{ target: 7 }, { target: 7 }]);
    // The stored ticket says the same on every later read, and a retry is still the same ticket.
    const stored = (await mm().listTickets({ id: 'b' })).tickets[0]!;
    expect(stored.state === 'matched' && stored.admission.payload).toEqual({ target: 7 });
    const retry = await mm().createTicket(entry('b', 'bob', { payload: { target: 9 } }));
    expect(retry.state === 'matched' && retry.admission.payload).toEqual({ target: 7 });
    const alice = (await mm().listTickets({ id: 'a' })).tickets[0]!;
    expect(alice.state === 'matched' && alice.match.tickets[1].payload).toEqual({ target: 7 });
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

  it('keeps a join path with its ticket, pairs tickets whose paths differ, and reads nothing in the path', async () => {
    const first = await mm().createTicket(entry('a', 'alice', { joinPath: '/duel?entry=5' }));
    expect(first.state === 'waiting' && first.admission.input.joinPath).toBe('/duel?entry=5');
    // A retry sends the same path: a changed or dropped one is a changed field.
    await expect(mm().createTicket(entry('a', 'alice', { joinPath: '/duel?entry=10' }))).rejects.toMatchObject({ code: 'ticket_conflict' });
    await expect(mm().createTicket(entry('a', 'alice'))).rejects.toMatchObject({ code: 'ticket_conflict' });
    const joined = await mm().createTicket(entry('b', 'bob', { joinPath: '/duel?entry=10' }));
    expect(joined.state === 'matched' && joined.match.tickets.map((t) => t.input.joinPath)).toEqual(['/duel?entry=5', '/duel?entry=10']);

    // Any text inside the size limit comes back as sent: no slash at the start, empty, another site, the longest.
    for (const [n, joinPath] of ['duel?entry=5', '', '//other.example/duel', `/${'x'.repeat(511)}`].entries()) {
      const ticket = await mm().createTicket(entry(`text-${n}`, 'carol', { joinPath }));
      expect(ticket.state === 'waiting' && ticket.admission.input.joinPath).toBe(joinPath);
    }
    // Only a value that is not text, or text past the limit, is refused.
    for (const joinPath of [7, null, `/${'x'.repeat(512)}`]) {
      await expect(mm().createTicket({ ...entry('n', 'carol'), joinPath } as never)).rejects.toMatchObject({ code: 'invalid_argument', status: null });
    }
    expect((await mm().listTickets({ id: 'n' })).tickets).toEqual([]);
  });

  it('keeps a display entry price with its ticket, pairs tickets whose prices differ, and takes only a positive whole number', async () => {
    const first = await mm().createTicket(entry('a', 'alice', { displayEntryCents: 500 }));
    expect(first.state === 'waiting' && first.admission.input.displayEntryCents).toBe(500);
    // A retry sends the same price: a changed or dropped one is a changed field.
    await expect(mm().createTicket(entry('a', 'alice', { displayEntryCents: 1_000 }))).rejects.toMatchObject({ code: 'ticket_conflict' });
    await expect(mm().createTicket(entry('a', 'alice'))).rejects.toMatchObject({ code: 'ticket_conflict' });
    // The price takes no part in pairing: each side keeps what it stated.
    const joined = await mm().createTicket(entry('b', 'bob', { displayEntryCents: 1_000 }));
    expect(joined.state === 'matched' && joined.match.tickets.map((t) => t.input.displayEntryCents)).toEqual([500, 1_000]);

    for (const displayEntryCents of [0, -100, 1.5, '500', null]) {
      await expect(mm().createTicket({ ...entry('n', 'carol'), displayEntryCents } as never)).rejects.toMatchObject({ code: 'invalid_argument', status: null });
    }
    expect((await mm().listTickets({ id: 'n' })).tickets).toEqual([]);
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
