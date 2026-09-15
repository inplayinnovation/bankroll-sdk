// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { BASE_UNITS_PER_CENT, ConfirmChargeError, HSUSD_MINT } from '../src/charges';
import { PayError } from '../src/payouts';
import { createReference, findChargeByReference, findPayoutByReference } from '../src/references';

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
