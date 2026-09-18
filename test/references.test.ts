// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';
import { jwtVerify } from 'jose';
import { parseMockReference } from '../src/mock';

import { BASE_UNITS_PER_CENT, ConfirmChargeError, HSUSD_MINT } from '../src/charges';
import { PayError } from '../src/payouts';
import { createManagedReference, createReference, findChargeByReference, findPayoutByReference, ManagedReferenceError } from '../src/references';

const REFERENCE = 'GgRva3ZaFuqDDVxr8CDsFcSf7ETNqQFJRhc4Y5nqsFhk';
const PAYER = 'PayerWa11etAddress1111111111111111111111111';
const PAYEE = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OLDEST = 'OldestSignature111111111111111111111111111111111111111111111111111111111111111111';
const NEWER = 'NewerSignature2222222222222222222222222222222222222222222222222222222222222222222';

const cents = (n: number) => (BigInt(n) * BASE_UNITS_PER_CENT).toString();

// The slice of a jsonParsed getTransaction result confirmCharge reads.
function paymentTx(amountCents = 500): object {
  const toBalance = (owner: string, amount: string, accountIndex: number) => ({
    accountIndex,
    mint: HSUSD_MINT,
    owner,
    uiTokenAmount: { amount, decimals: 9 },
  });
  return {
    slot: 34567,
    meta: {
      err: null,
      preTokenBalances: [toBalance(PAYER, cents(1000), 0), toBalance(PAYEE, '0', 1)],
      postTokenBalances: [
        toBalance(PAYER, cents(1000 - amountCents), 0),
        toBalance(PAYEE, cents(amountCents), 1),
      ],
    },
    transaction: { message: { instructions: [] } },
  };
}

// A transaction that touches the reference but moves nothing a charge would —
// what a third party planting the key looks like.
const notAPaymentTx = (): object => ({
  slot: 1,
  meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
  transaction: { message: { instructions: [] } },
});

type RpcReply = { status?: number; body?: unknown };

interface RpcServer {
  url: string;
  requests: any[];
  close: () => Promise<void>;
}

const rpcResult = (result: unknown): RpcReply => ({ body: { jsonrpc: '2.0', id: 1, result } });

async function startRpcServer(replies: RpcReply[]): Promise<RpcServer> {
  const state = { hits: 0, requests: [] as any[] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      state.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const reply = replies[Math.min(state.hits, replies.length - 1)] ?? rpcResult(null);
      state.hits += 1;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('createReference', () => {
  it('mints a distinct base58 address each time', () => {
    const a = createReference();
    const b = createReference();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

describe('findChargeByReference', () => {
  let rpc: RpcServer | undefined;
  const savedEnv = process.env.SOLANA_RPC_URL;

  afterEach(async () => {
    if (rpc) await rpc.close();
    rpc = undefined;
    if (savedEnv === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = savedEnv;
  });

  async function serve(replies: RpcReply[]): Promise<RpcServer> {
    rpc = await startRpcServer(replies);
    process.env.SOLANA_RPC_URL = rpc.url;
    return rpc;
  }

  it('returns null when nothing has ever touched the reference', async () => {
    await serve([rpcResult([])]);
    await expect(findChargeByReference(REFERENCE)).resolves.toBeNull();
  });

  it('returns the charge, carrying the signature the caller never had', async () => {
    await serve([rpcResult([{ signature: OLDEST, err: null }]), rpcResult(paymentTx())]);

    const charge = await findChargeByReference(REFERENCE);

    expect(charge).toMatchObject({
      signature: OLDEST,
      payer: PAYER,
      payee: PAYEE,
      mint: HSUSD_MINT,
      amountCents: 500,
    });
  });

  // The RPC answers newest-first; the payment is normally the first
  // transaction ever to touch a reference nobody could guess.
  it('takes the oldest signature, not the newest', async () => {
    const server = await serve([
      rpcResult([
        { signature: NEWER, err: null },
        { signature: OLDEST, err: null },
      ]),
      rpcResult(paymentTx()),
    ]);

    const charge = await findChargeByReference(REFERENCE);

    expect(charge?.signature).toBe(OLDEST);
    expect(server.requests[1].params[0]).toBe(OLDEST);
  });

  // Landed and failed: nothing moved, so it is never the charge.
  it('skips a transaction that failed on-chain', async () => {
    await serve([
      rpcResult([
        { signature: NEWER, err: null },
        { signature: OLDEST, err: { InstructionError: [0, 'Custom'] } },
      ]),
      rpcResult(paymentTx()),
    ]);

    const charge = await findChargeByReference(REFERENCE);

    expect(charge?.signature).toBe(NEWER);
  });

  // Anyone can attach a landed reference to a transaction of their own.
  it("walks past someone else's transaction carrying the reference", async () => {
    await serve([
      rpcResult([
        { signature: NEWER, err: null },
        { signature: OLDEST, err: null },
      ]),
      rpcResult(notAPaymentTx()),
      rpcResult(paymentTx()),
    ]);

    const charge = await findChargeByReference(REFERENCE);

    expect(charge?.signature).toBe(NEWER);
  });

  // A failure to look is not a negative answer.
  it('propagates an RPC failure rather than reporting no charge', async () => {
    await serve([{ status: 500, body: {} }]);

    const error = await findChargeByReference(REFERENCE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfirmChargeError);
    expect((error as ConfirmChargeError).code).toBe('rpc_error');
  });

  it('passes limit, before and until through to the RPC', async () => {
    const server = await serve([rpcResult([])]);

    await findChargeByReference(REFERENCE, { limit: 10, before: NEWER, until: OLDEST });

    expect(server.requests[0].method).toBe('getSignaturesForAddress');
    expect(server.requests[0].params[0]).toBe(REFERENCE);
    expect(server.requests[0].params[1]).toMatchObject({
      limit: 10,
      before: NEWER,
      until: OLDEST,
    });
  });
});


describe('findPayoutByReference', () => {
  let rpc: RpcServer | undefined;
  const savedEnv = { rpc: process.env.SOLANA_RPC_URL, mock: process.env.BANKROLL_MOCK };

  afterEach(async () => {
    if (rpc) await rpc.close();
    rpc = undefined;
    if (savedEnv.rpc === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = savedEnv.rpc;
    if (savedEnv.mock === undefined) delete process.env.BANKROLL_MOCK;
    else process.env.BANKROLL_MOCK = savedEnv.mock;
  });

  async function serve(replies: RpcReply[]): Promise<RpcServer> {
    rpc = await startRpcServer(replies);
    process.env.SOLANA_RPC_URL = rpc.url;
    return rpc;
  }

  it('returns null while nothing has touched the reference', async () => {
    await serve([rpcResult([])]);
    await expect(findPayoutByReference(REFERENCE)).resolves.toBeNull();
  });

  // The RPC answers newest-first; the attempt you sent is the first
  // transaction ever to touch a reference nobody could guess — and a landed,
  // failed attempt is exactly what makes a fresh one safe, so it is reported.
  it('returns the oldest transaction, failed ones included, as the signature to confirm', async () => {
    const server = await serve([
      rpcResult([
        { signature: NEWER, slot: 2, err: null },
        { signature: OLDEST, slot: 1, err: { InstructionError: [0, 'Custom'] } },
      ]),
    ]);

    const found = await findPayoutByReference(REFERENCE);

    expect(found).toEqual({ signature: OLDEST, slot: 1, failed: true });
    // One read of the chain: a payout is judged by confirmPayout, not parsed here.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].method).toBe('getSignaturesForAddress');
  });

  it('reports a landed payout as not failed', async () => {
    await serve([rpcResult([{ signature: OLDEST, slot: 7, err: null }])]);

    await expect(findPayoutByReference(REFERENCE)).resolves.toEqual({
      signature: OLDEST,
      slot: 7,
      failed: false,
    });
  });

  // A failure to look is not a negative answer.
  it('propagates an RPC failure as a PayError rather than reporting no payout', async () => {
    await serve([{ status: 500, body: {} }]);

    const error = await findPayoutByReference(REFERENCE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayError);
    expect((error as PayError).code).toBe('rpc_error');
  });

  it('reads one full page, newest-first from the RPC, and takes the oldest', async () => {
    const server = await serve([rpcResult([])]);

    await findPayoutByReference(REFERENCE);

    expect(server.requests[0].method).toBe('getSignaturesForAddress');
    expect(server.requests[0].params[0]).toBe(REFERENCE);
    expect(server.requests[0].params[1]).toMatchObject({ commitment: 'confirmed', limit: 1000 });
  });

  it('answers null under the mock host without reaching an RPC', async () => {
    const server = await serve([rpcResult([{ signature: OLDEST, slot: 1, err: null }])]);
    process.env.BANKROLL_MOCK = '1';

    await expect(findPayoutByReference(REFERENCE)).resolves.toBeNull();
    expect(server.requests).toHaveLength(0);
  });
});
describe('createManagedReference', () => {
  const keys = generateKeyPairSync('ed25519');
  const jwk = keys.privateKey.export({ format: 'jwk' });
  const appSecret = bs58.encode(Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')]));
  const ORIGIN = 'https://game.example';
  const META = { entryId: 'entry-1', side: 'payin' };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv('BANKROLL_APP_KEY', appSecret);
    vi.stubEnv('BANKROLL_PUSH_KEY', undefined);
    vi.stubEnv('BANKROLL_API_URL', undefined);
    vi.stubEnv('BANKROLL_MOCK', undefined);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockImplementation(async () => Response.json({ reference: REFERENCE, expiresAt: '2026-09-18T18:07:00.000Z' }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks Bankroll under the app credential and hands back the reference', async () => {
    const created = await createManagedReference({ meta: META, expiresInSeconds: 600 }, { origin: ORIGIN });

    expect(created).toEqual({ reference: REFERENCE, expiresAt: '2026-09-18T18:07:00.000Z' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.joinbankroll.com/api/v1/references');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(init!.body as string)).toEqual({ meta: META, expiresInSeconds: 600 });
    const token = new Headers(init!.headers).get('authorization')!.slice('Bearer '.length);
    const { payload, protectedHeader } = await jwtVerify(token, keys.publicKey, { issuer: ORIGIN, audience: 'bankroll-api' });
    expect(protectedHeader.typ).toBe('bankroll-app-auth+jwt');
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it('leaves the window to Bankroll when none is named, and honours BANKROLL_API_URL', async () => {
    vi.stubEnv('BANKROLL_API_URL', 'http://localhost:3000');
    await createManagedReference({ meta: META }, { origin: ORIGIN });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:3000/api/v1/references');
    expect(JSON.parse(init!.body as string)).toEqual({ meta: META });
  });

  it.each([
    ['a meta that is not an object', { meta: [1, 2] as never }],
    ['a meta with a non-finite number', { meta: { n: Number.POSITIVE_INFINITY } }],
    ['a fractional window', { meta: META, expiresInSeconds: 1.5 }],
  ])('refuses %s before calling Bankroll', async (_label, input) => {
    await expect(createManagedReference(input, { origin: ORIGIN })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a bad origin and a missing credential before calling Bankroll', async () => {
    await expect(createManagedReference({ meta: META }, { origin: 'http://localhost:3000' })).rejects.toMatchObject({ code: 'invalid_argument' });
    vi.stubEnv('BANKROLL_APP_KEY', undefined);
    await expect(createManagedReference({ meta: META }, { origin: ORIGIN })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'app_not_verified'],
    [409, 'webhook_not_provisioned'],
    [400, 'invalid_argument'],
    [401, 'unauthenticated'],
  ])("maps Bankroll's %s %s refusal", async (status, code) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: code }, { status }));
    const error = await createManagedReference({ meta: META }, { origin: ORIGIN }).catch((e) => e);
    expect(error).toBeInstanceOf(ManagedReferenceError);
    expect(error).toMatchObject({ code, status });
  });

  it('says unavailable when Bankroll cannot be reached and invalid_response for anything it cannot read', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(createManagedReference({ meta: META }, { origin: ORIGIN })).rejects.toMatchObject({ code: 'unavailable' });
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'teapot' }, { status: 418 }));
    await expect(createManagedReference({ meta: META }, { origin: ORIGIN })).rejects.toMatchObject({ code: 'invalid_response' });
    fetchMock.mockResolvedValueOnce(Response.json({ reference: 42 }));
    await expect(createManagedReference({ meta: META }, { origin: ORIGIN })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('under the mock mints the reference locally, carrying the meta and the window, and calls no one', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    vi.useFakeTimers({ now: new Date('2026-09-18T18:00:00.000Z') });
    const created = await createManagedReference({ meta: META, expiresInSeconds: 60 }, { origin: ORIGIN });

    expect(created.expiresAt).toBe('2026-09-18T18:01:00.000Z');
    expect(parseMockReference(created.reference)).toEqual({ meta: META, expiresAt: '2026-09-18T18:01:00.000Z' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
