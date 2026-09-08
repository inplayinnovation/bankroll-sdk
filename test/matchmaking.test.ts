// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';
import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatchmaking, MatchmakingError, type Json, type Ticket, type TicketInput } from '../src/matchmaking';

function credential() {
  const keys = generateKeyPairSync('ed25519');
  const jwk = keys.privateKey.export({ format: 'jwk' });
  return { ...keys, secret: bs58.encode(Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')])) };
}
const firstKey = credential(), secondKey = credential();
const origin = 'https://game.example';
const input: TicketInput<{ target: number }> = { id: 'entry-1', player: 'player-1', queue: { key: 'round', size: 2 }, payload: { target: 7 } };
const admission = { input, createdAt: 1_800_000_000_000, payload: input.payload };
const waiting: Ticket = { id: input.id, state: 'waiting', admission };
const cancelled: Ticket = { id: input.id, state: 'cancelled', admission: null, reason: 'requested', cancelledAt: 1_800_000_000_001 };
const matched: Ticket = { id: input.id, state: 'matched', admission,
  match: { id: 'match-1', queue: 'round', matchedAt: 1_800_000_000_001, payload: input.payload,
    tickets: [admission, { ...admission, input: { ...input, id: 'entry-2', player: 'player-2' } }] } };
const fetchMock = vi.fn<typeof fetch>();
const client = () => createMatchmaking({ origin });
const call = (index = 0) => fetchMock.mock.calls[index]!;
const bearer = (index = 0) => new Headers(call(index)[1]?.headers).get('authorization')!.slice('Bearer '.length);

beforeEach(() => {
  vi.stubEnv('BANKROLL_APP_KEY', firstKey.secret);
  vi.stubEnv('BANKROLL_PUSH_KEY', undefined);
  vi.stubEnv('BANKROLL_API_URL', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json(waiting));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('matchmaking app authentication and transport', () => {
  it('exposes only three methods and signs identity separately from all three JSON requests', async () => {
    const mm = createMatchmaking<{ target: number }>({ origin });
    expect(Object.keys(mm)).toEqual(['createTicket', 'listTickets', 'cancelTicket']);
    expect(await mm.createTicket(input)).toEqual(waiting);
    fetchMock.mockResolvedValueOnce(Response.json({ tickets: [matched, cancelled], nextCursor: 'opaque' }));
    expect(await mm.listTickets({ player: 'player-1', cursor: 'previous' })).toEqual({ tickets: [matched, cancelled], nextCursor: 'opaque' });
    fetchMock.mockResolvedValueOnce(Response.json(cancelled));
    expect(await mm.cancelTicket(input.id)).toEqual(cancelled);
    const bodies = [
      { operation: 'createTicket', input },
      { operation: 'listTickets', input: { player: 'player-1', cursor: 'previous' } },
      { operation: 'cancelTicket', input: { id: input.id } },
    ];
    for (let index = 0; index < bodies.length; index++) {
      const [url, init] = call(index);
      expect(url).toBe('https://api.joinbankroll.com/api/matchmaking');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(init?.body as string)).toEqual(bodies[index]);
      const { payload, protectedHeader } = await jwtVerify(bearer(index), firstKey.publicKey, { issuer: origin, audience: 'bankroll-api' });
      expect(protectedHeader).toEqual({ alg: 'EdDSA', typ: 'bankroll-app-auth+jwt' });
      expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss']);
      expect(Number.isInteger(payload.iat)).toBe(true);
      expect(payload.exp! - payload.iat!).toBe(60);
    }
  });

  it('lists the whole app by default and returns either permanent cancellation outcome', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ tickets: [], nextCursor: null }));
    await client().listTickets();
    expect(JSON.parse(call()[1]?.body as string)).toEqual({ operation: 'listTickets', input: {} });
    for (const result of [matched, cancelled, { ...cancelled, admission, reason: 'expired' }]) {
      fetchMock.mockResolvedValueOnce(Response.json(result));
      expect(await client().cancelTicket(input.id)).toEqual(result);
    }
  });

  it('rereads credentials for rotation, uses legacy fallback, and honors an explicit key', async () => {
    const mm = client();
    await mm.createTicket(input);
    vi.stubEnv('BANKROLL_APP_KEY', secondKey.secret);
    await mm.createTicket(input);
    await jwtVerify(bearer(1), secondKey.publicKey);
    vi.stubEnv('BANKROLL_APP_KEY', undefined);
    vi.stubEnv('BANKROLL_PUSH_KEY', firstKey.secret);
    await mm.createTicket(input);
    await jwtVerify(bearer(2), firstKey.publicKey);
    vi.stubEnv('BANKROLL_APP_KEY', 'malformed');
    await createMatchmaking({ origin, key: secondKey.secret }).createTicket(input);
    await jwtVerify(bearer(3), secondKey.publicKey);
  });

  it.each([undefined, '', 'invalid-key'])('fails before fetching when the selected credential is unusable (%#)', async (key) => {
    vi.stubEnv('BANKROLL_APP_KEY', key);
    await expect(client().createTicket(input)).rejects.toMatchObject({ code: 'unauthenticated', status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses staging environment configuration, with explicit URL taking precedence', async () => {
    vi.stubEnv('BANKROLL_API_URL', 'https://staging.example');
    await client().createTicket(input);
    await createMatchmaking({ origin, apiUrl: 'http://127.0.0.1:8797/' }).createTicket(input);
    expect(call()[0]).toBe('https://staging.example/api/matchmaking');
    expect(call(1)[0]).toBe('http://127.0.0.1:8797/api/matchmaking');
  });

  it.each(['http://game.example', 'https://game.example/', 'https://GAME.example', 'https://127.0.0.1', 'https://host.localhost', 'https://host.internal', 'https://host'])('rejects noncanonical or nonpublic issuer %s', (origin) => {
    expect(() => createMatchmaking({ origin })).toThrow(MatchmakingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['http://staging.example', 'https://user:pass@staging.example', 'https://staging.example/path', 'https://staging.example?query=1'])('rejects unsafe API URL %s', (apiUrl) => {
    expect(() => createMatchmaking({ origin, apiUrl })).toThrow(MatchmakingError);
  });
});

describe('immutable request serialization', () => {
  it('captures caller input before signing yields and keeps the snapshot after mutation', async () => {
    const proposed = structuredClone(input);
    const pending = client().createTicket(proposed);
    proposed.id = 'changed-id';
    proposed.payload.target = 999;
    await expect(pending).resolves.toEqual(waiting);
    expect(JSON.parse(call()[1]?.body as string).input).toEqual(input);
  });
  it.each([undefined, NaN, Infinity, 1n, () => 1, Symbol('unsupported'), new Date(), new Map(), [, 1],
    { value: undefined }, { toJSON: () => ({ changed: true }) }, Object.assign([1], { hidden: 2 }),
    { [Symbol('omitted')]: true }, Object.defineProperty({}, 'hidden', { value: 1 }),
    Object.defineProperty({}, 'computed', { enumerable: true, get() { throw new Error('must not invoke'); } })])(
    'rejects values JSON would lose or transform (%#)', async (payload) => {
      await expect(client().createTicket({ ...input, payload: payload as Json })).rejects.toMatchObject({ code: 'invalid_argument', status: null });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  it('rejects cycles but permits repeated references to ordinary JSON', async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(client().createTicket({ ...input, payload: cycle as Json })).rejects.toMatchObject({ code: 'invalid_argument' });
    const shared = { target: 3 };
    await client().createTicket({ ...input, payload: [shared, shared] });
    expect(JSON.parse(call()[1]?.body as string).input.payload).toEqual([shared, shared]);
  });
});

describe('refusals and ambiguous outcomes', () => {
  it.each([{ tickets: [], nextCursor: 1 }, { tickets: [{}], nextCursor: null }, { tickets: null, nextCursor: null }])(
    'rejects malformed discovery pages (%#)', async (page) => {
      fetchMock.mockResolvedValueOnce(Response.json(page));
      await expect(client().listTickets()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  it.each([['unauthenticated', 401], ['app_not_verified', 403], ['invalid_argument', 400],
    ['ticket_conflict', 409], ['queue_conflict', 409], ['unavailable', 503]] as const)(
    'preserves %s and HTTP status without retrying', async (code, status) => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: code }, { status }));
      await expect(client().createTicket(input)).rejects.toMatchObject({ name: 'MatchmakingError', code, status });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  it('never retries a lost cancellation reply; the caller can replay the unchanged ID', async () => {
    const mm = client();
    fetchMock.mockRejectedValueOnce(new Error('reply lost after commit'));
    await expect(mm.cancelTicket(input.id)).rejects.toMatchObject({ code: 'unavailable', status: null });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(Response.json(cancelled));
    expect(await mm.cancelTicket(input.id)).toEqual(cancelled);
    expect(call()[1]?.body).toBe(call(1)[1]?.body);
  });
  it('passes a bounded timeout and reports abort as unavailable without retrying', async () => {
    const signal = AbortSignal.abort(new DOMException('timeout', 'TimeoutError'));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    fetchMock.mockImplementationOnce(async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json(waiting); });
    await expect(client().createTicket(input)).rejects.toMatchObject({ code: 'unavailable' });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([() => new Response('broken JSON'), () => Response.json({ error: 'surprise' }, { status: 500 }),
    () => Response.json({}), () => Response.json(waiting), () => Response.json({ ...cancelled, id: 'wrong-id' }),
    () => new Response('{"id":"entry-1","state":"cancelled","admission":null,"reason":"requested","cancelledAt":1e400}')])(
    'rejects malformed, nonterminal or unknown cancellation replies as ambiguous (%#)', async (response) => {
      fetchMock.mockResolvedValueOnce(response());
      await expect(client().cancelTicket(input.id)).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
});
