// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BASE_UNITS_PER_CENT,
  ConfirmChargeError,
  HSUSD_MINT,
  confirmCharge,
} from '../src/charges';

const SIGNATURE = '5VERYrealLookingBase58TransactionSignatureUsedInTests1111111111111111111111111111';
const PAYER = 'PayerWa11etAddress1111111111111111111111111';
const PAYEE = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const cents = (n: number) => (BigInt(n) * BASE_UNITS_PER_CENT).toString();

interface TokenBalanceInput {
  owner?: string;
  amount: string;
  mint?: string;
}

interface TxInput {
  err?: unknown;
  pre?: TokenBalanceInput[];
  post?: TokenBalanceInput[];
  memo?: string;
  meta?: null;
}

// The slice of a jsonParsed getTransaction result confirmCharge reads, shaped
// like the real RPC response.
function paymentTx(input: TxInput = {}): object {
  const toBalance = (balance: TokenBalanceInput, accountIndex: number) => ({
    accountIndex,
    mint: balance.mint ?? HSUSD_MINT,
    ...(balance.owner ? { owner: balance.owner } : {}),
    uiTokenAmount: { amount: balance.amount, decimals: 9 },
  });
  const pre = input.pre ?? [
    { owner: PAYER, amount: cents(1000) },
    { owner: PAYEE, amount: '0' },
  ];
  const post = input.post ?? [
    { owner: PAYER, amount: cents(500) },
    { owner: PAYEE, amount: cents(500) },
  ];
  return {
    slot: 34567,
    blockTime: 1752800000,
    meta:
      input.meta === null
        ? null
        : {
            err: input.err ?? null,
            preTokenBalances: pre.map(toBalance),
            postTokenBalances: post.map(toBalance),
          },
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [],
        instructions: [
          {
            program: 'spl-token',
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            parsed: { type: 'transferChecked', info: {} },
          },
          ...(input.memo !== undefined
            ? [
                {
                  program: 'spl-memo',
                  programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
                  parsed: input.memo,
                },
              ]
            : []),
        ],
      },
    },
  };
}

type RpcReply = { status?: number; body?: unknown; rawBody?: string };

// A real local RPC server; each request consumes the next reply in the queue
// (the last reply repeats).
interface RpcServer {
  url: string;
  hits: number;
  requests: unknown[];
  close: () => Promise<void>;
}

const rpcResult = (result: unknown): RpcReply => ({ body: { jsonrpc: '2.0', id: 1, result } });

async function startRpcServer(replies: RpcReply[]): Promise<RpcServer> {
  const state = { hits: 0, requests: [] as unknown[] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      state.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const reply = replies[Math.min(state.hits, replies.length - 1)] ?? rpcResult(null);
      state.hits += 1;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(reply.rawBody ?? JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    get hits() {
      return state.hits;
    },
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: ConfirmChargeError['code'],
): Promise<ConfirmChargeError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ConfirmChargeError(${code}), but the call resolved`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConfirmChargeError);
  expect((error as ConfirmChargeError).code).toBe(code);
  return error as ConfirmChargeError;
}

describe('confirmCharge', () => {
  let rpc: RpcServer | undefined;
  const savedEnv = process.env.SOLANA_RPC_URL;

  afterEach(async () => {
    if (rpc) await rpc.close();
    rpc = undefined;
    if (savedEnv === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = savedEnv;
  });

  // confirmCharge reads SOLANA_RPC_URL — point it at the local server.
  async function serve(replies: RpcReply[]): Promise<RpcServer> {
    rpc = await startRpcServer(replies);
    process.env.SOLANA_RPC_URL = rpc.url;
    return rpc;
  }

  it('returns the facts of a settled payment', async () => {
    const server = await serve([rpcResult(paymentTx({ memo: 'order:1234' }))]);

    const payment = await confirmCharge(SIGNATURE);

    expect(payment).toEqual({
      payer: PAYER,
      payee: PAYEE,
      amountCents: 500,
      memo: 'order:1234',
      slot: 34567,
    });
  });

  it('sends a well-formed getTransaction request', async () => {
    const server = await serve([rpcResult(paymentTx())]);

    await confirmCharge(SIGNATURE);

    expect(server.requests[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'getTransaction',
      params: [
        SIGNATURE,
        { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ],
    });
  });

  it('returns a null memo when the payment has none', async () => {
    const server = await serve([rpcResult(paymentTx())]);
    const payment = await confirmCharge(SIGNATURE);
    expect(payment.memo).toBeNull();
  });

  it('reports the slot the transaction landed in', async () => {
    // A chain-assigned ordering key — a caller stores a purchase under it so a
    // listing is time-ordered without giving up signature-keyed idempotency.
    const server = await serve([rpcResult(paymentTx())]);
    const payment = await confirmCharge(SIGNATURE);
    expect(payment.slot).toBe(34567);
  });

  it('finds a memo emitted from a CPI inner instruction (smart-contract wallets)', async () => {
    const tx = paymentTx() as {
      meta: Record<string, unknown>;
    };
    tx.meta.innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            program: 'spl-memo',
            programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            parsed: 'order:inner',
          },
        ],
      },
    ];
    const server = await serve([rpcResult(tx)]);

    const payment = await confirmCharge(SIGNATURE);

    expect(payment.memo).toBe('order:inner');
  });

  it('keeps whole-cent amounts exact beyond the float precision of atomic units', async () => {
    const hugeCents = 2n ** 53n - 1n; // odd, so the atomic amount is not float-representable
    const server = await serve([
      rpcResult(
        paymentTx({
          pre: [
            { owner: PAYER, amount: (hugeCents * BASE_UNITS_PER_CENT).toString() },
            { owner: PAYEE, amount: '0' },
          ],
          post: [
            { owner: PAYER, amount: '0' },
            { owner: PAYEE, amount: (hugeCents * BASE_UNITS_PER_CENT).toString() },
          ],
        }),
      ),
    ]);

    const payment = await confirmCharge(SIGNATURE);

    expect(payment.amountCents).toBe(Number(hugeCents));
  });

  it('sums balance deltas across multiple token accounts of the same owner', async () => {
    const server = await serve([
      rpcResult(
        paymentTx({
          pre: [
            { owner: PAYER, amount: cents(300) },
            { owner: PAYER, amount: cents(300) },
            { owner: PAYEE, amount: '0' },
          ],
          post: [
            { owner: PAYER, amount: '0' },
            { owner: PAYER, amount: cents(100) },
            { owner: PAYEE, amount: cents(500) },
          ],
        }),
      ),
    ]);

    const payment = await confirmCharge(SIGNATURE);

    expect(payment.payer).toBe(PAYER);
    expect(payment.amountCents).toBe(500);
  });

  it('reports dust as fractional cents so an exact-cents comparison fails', async () => {
    const server = await serve([
      rpcResult(
        paymentTx({
          pre: [
            { owner: PAYER, amount: '5000000001' },
            { owner: PAYEE, amount: '0' },
          ],
          post: [
            { owner: PAYER, amount: '0' },
            { owner: PAYEE, amount: '5000000001' },
          ],
        }),
      ),
    ]);

    const payment = await confirmCharge(SIGNATURE);

    expect(payment.amountCents).not.toBe(500);
    expect(payment.amountCents).toBeCloseTo(500.0000001, 10);
  });

  describe('visibility polling', () => {
    it('retries while the transaction is not yet visible to the queried node', async () => {
      const server = await serve([rpcResult(null), rpcResult(paymentTx())]);

      const payment = await confirmCharge(SIGNATURE);

      expect(payment.amountCents).toBe(500);
      expect(server.hits).toBe(2);
    });

    it('throws not_found once the deadline passes', async () => {
      const server = await serve([rpcResult(null)]);

      const error = await expectCode(
        confirmCharge(SIGNATURE, { timeoutMs: 50 }),
        'not_found',
      );

      expect(error.message).toContain(SIGNATURE);
      expect(server.hits).toBeGreaterThanOrEqual(2);
    });
  });

  describe('rejections', () => {
    it('throws failed_on_chain when the transaction landed but failed', async () => {
      const server = await serve([
        rpcResult(paymentTx({ err: { InstructionError: [0, { Custom: 1 }] } })),
      ]);
      await expectCode(confirmCharge(SIGNATURE), 'failed_on_chain');
    });

    it('throws not_a_payment when no HSUSD moved', async () => {
      const server = await serve([rpcResult(paymentTx({ pre: [], post: [] }))]);
      await expectCode(confirmCharge(SIGNATURE), 'not_a_payment');
    });

    it('throws not_a_payment when only another mint moved', async () => {
      const server = await serve([
        rpcResult(
          paymentTx({
            pre: [
              { owner: PAYER, amount: cents(500), mint: OTHER_MINT },
              { owner: PAYEE, amount: '0', mint: OTHER_MINT },
            ],
            post: [
              { owner: PAYER, amount: '0', mint: OTHER_MINT },
              { owner: PAYEE, amount: cents(500), mint: OTHER_MINT },
            ],
          }),
        ),
      ]);
      await expectCode(confirmCharge(SIGNATURE), 'not_a_payment');
    });

    it('throws not_a_payment when more than one wallet was credited', async () => {
      const server = await serve([
        rpcResult(
          paymentTx({
            pre: [
              { owner: PAYER, amount: cents(1000) },
              { owner: PAYEE, amount: '0' },
              { owner: 'ThirdWa11et111111111111111111111111111111111', amount: '0' },
            ],
            post: [
              { owner: PAYER, amount: cents(400) },
              { owner: PAYEE, amount: cents(500) },
              { owner: 'ThirdWa11et111111111111111111111111111111111', amount: cents(100) },
            ],
          }),
        ),
      ]);
      await expectCode(confirmCharge(SIGNATURE), 'not_a_payment');
    });

    it('throws not_a_payment for a self-transfer (deltas net to zero)', async () => {
      const server = await serve([
        rpcResult(
          paymentTx({
            pre: [
              { owner: PAYER, amount: cents(500) },
              { owner: PAYER, amount: '0' },
            ],
            post: [
              { owner: PAYER, amount: '0' },
              { owner: PAYER, amount: cents(500) },
            ],
          }),
        ),
      ]);
      await expectCode(confirmCharge(SIGNATURE), 'not_a_payment');
    });

    it('throws not_a_payment when the transaction has no balance metadata', async () => {
      const server = await serve([rpcResult(paymentTx({ meta: null }))]);
      await expectCode(confirmCharge(SIGNATURE), 'not_a_payment');
    });

    it('ignores balance entries without an owner', async () => {
      const server = await serve([
        rpcResult(
          paymentTx({
            pre: [
              { owner: PAYER, amount: cents(500) },
              { owner: PAYEE, amount: '0' },
              { amount: cents(999) },
            ],
            post: [
              { owner: PAYER, amount: '0' },
              { owner: PAYEE, amount: cents(500) },
              { amount: '0' },
            ],
          }),
        ),
      ]);
      const payment = await confirmCharge(SIGNATURE);
      expect(payment.amountCents).toBe(500);
    });
  });

  describe('rpc failures', () => {
    it('throws rpc_error on a non-200 response once the deadline passes', async () => {
      const server = await serve([{ status: 500, body: 'oops' }]);
      await expectCode(
        confirmCharge(SIGNATURE, { timeoutMs: 0 }),
        'rpc_error',
      );
    });

    it('retries a transient failure and confirms within the deadline', async () => {
      const server = await serve([{ status: 429, body: 'rate limited' }, rpcResult(paymentTx())]);

      const payment = await confirmCharge(SIGNATURE);

      expect(payment.amountCents).toBe(500);
      expect(server.hits).toBe(2);
    });

    it('throws rpc_error on a JSON-RPC error body', async () => {
      const server = await serve([
        { body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'node is behind' } } },
      ]);
      const error = await expectCode(
        confirmCharge(SIGNATURE, { timeoutMs: 0 }),
        'rpc_error',
      );
      expect(error.message).toContain('node is behind');
    });

    it('throws rpc_error on an invalid JSON body', async () => {
      const server = await serve([{ rawBody: 'not json' }]);
      await expectCode(
        confirmCharge(SIGNATURE, { timeoutMs: 0 }),
        'rpc_error',
      );
    });

    it('throws rpc_error on a 200 body with neither result nor error', async () => {
      const server = await serve([{ body: { jsonrpc: '2.0', id: 1 } }]);
      await expectCode(
        confirmCharge(SIGNATURE, { timeoutMs: 0 }),
        'rpc_error',
      );
    });

    it('throws rpc_error when the endpoint is unreachable', async () => {
      process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1/';
      await expectCode(confirmCharge(SIGNATURE, { timeoutMs: 0 }), 'rpc_error');
    });
  });

  describe('configuration', () => {
    it('throws a plain configuration error when SOLANA_RPC_URL is unset', async () => {
      delete process.env.SOLANA_RPC_URL;
      await expect(confirmCharge(SIGNATURE)).rejects.toThrow('SOLANA_RPC_URL');
    });
  });
});
