// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it } from 'vitest';

import { BASE_UNITS_PER_CENT, HSUSD_DECIMALS, HSUSD_MINT } from '../src/charges';
import {
  PayError,
  buildPayout,
  confirmPayout,
  keypairSigner,
  pay,
  sendPayout,
  type PaymentSigner,
} from '../src/payouts';

const TREASURY = Keypair.generate();
const TREASURY_SECRET = bs58.encode(TREASURY.secretKey);
const RECIPIENT = Keypair.generate().publicKey;
const MINT = new PublicKey(HSUSD_MINT);
const BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const LAST_VALID = 250_000_000;

// ---------------------------------------------------------------------------
// Mock RPC server: routes JSON-RPC methods to handlers and records requests.
// Connection validates response envelopes, so context is included where the
// real RPC would send it.
// ---------------------------------------------------------------------------

type MethodHandler = (
  params: unknown[],
  hit: number,
) => unknown | { __error: object } | { __destroy: true };

interface RpcServer {
  url: string;
  requests: Array<{ method: string; params: unknown[] }>;
  close: () => Promise<void>;
}

const CONTEXT = { slot: 34567 };
const confirmedStatus = {
  context: CONTEXT,
  value: [{ slot: 34567, confirmations: 5, err: null, confirmationStatus: 'confirmed' }],
};
const nullStatus = { context: CONTEXT, value: [null] };
const latestBlockhash = {
  context: CONTEXT,
  value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID },
};

async function startRpc(handlers: Record<string, MethodHandler>): Promise<RpcServer> {
  const state = { requests: [] as Array<{ method: string; params: unknown[] }> };
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      state.requests.push({ method: body.method, params: body.params });
      const hit = hits.get(body.method) ?? 0;
      hits.set(body.method, hit + 1);
      const handler = handlers[body.method];
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!handler) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: `no handler for ${body.method}` },
          }),
        );
        return;
      }
      const result = handler(body.params, hit);
      if (result !== null && typeof result === 'object' && '__destroy' in result) {
        req.socket.destroy(); // simulate a transport failure mid-request
        return;
      }
      if (result !== null && typeof result === 'object' && '__error' in result) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: result.__error }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests: state.requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function happyHandlers(overrides?: Record<string, MethodHandler>): Record<string, MethodHandler> {
  return {
    getLatestBlockhash: () => latestBlockhash,
    sendTransaction: (params) => {
      // Echo back the signature embedded in the submitted transaction.
      const wire = Buffer.from(params[0] as string, 'base64');
      return bs58.encode(wire.subarray(1, 65));
    },
    getSignatureStatuses: () => confirmedStatus,
    ...overrides,
  };
}

function sentWireTx(rpc: RpcServer): Buffer {
  const send = rpc.requests.find((r) => r.method === 'sendTransaction');
  if (!send) throw new Error('no sendTransaction request recorded');
  return Buffer.from(send.params[0] as string, 'base64');
}

describe('pay', () => {
  let rpc: RpcServer | undefined;
  const savedRpcEnv = process.env.SOLANA_RPC_URL;
  const savedKeyEnv = process.env.BANKROLL_TREASURY_KEY;

  afterEach(async () => {
    if (rpc) await rpc.close();
    rpc = undefined;
    if (savedRpcEnv === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = savedRpcEnv;
    if (savedKeyEnv === undefined) delete process.env.BANKROLL_TREASURY_KEY;
    else process.env.BANKROLL_TREASURY_KEY = savedKeyEnv;
  });

  async function serve(handlers: Record<string, MethodHandler>): Promise<RpcServer> {
    rpc = await startRpc(handlers);
    process.env.SOLANA_RPC_URL = rpc.url;
    process.env.BANKROLL_TREASURY_KEY = TREASURY_SECRET;
    return rpc;
  }

  // -------------------------------------------------------------------------
  // The built transaction
  // -------------------------------------------------------------------------

  describe('built transaction', () => {
    async function builtTransaction(memo?: string): Promise<Transaction> {
      const server = await serve(happyHandlers());
      await pay({ to: RECIPIENT.toBase58(), amountCents: 2500, ...(memo ? { memo } : {}) });
      return Transaction.from(sentWireTx(server));
    }

    it('broadcasts a signed transaction whose signature verifies', async () => {
      const tx = await builtTransaction();
      expect(tx.verifySignatures()).toBe(true);
      expect(tx.feePayer?.toBase58()).toBe(TREASURY.publicKey.toBase58());
      expect(tx.recentBlockhash).toBe(BLOCKHASH);
    });

    it('composes exactly ATA-create, transferChecked, and the caller memo', async () => {
      const tx = await builtTransaction('order:42');
      const treasuryAta = getAssociatedTokenAddressSync(MINT, TREASURY.publicKey);
      const recipientAta = getAssociatedTokenAddressSync(MINT, RECIPIENT);
      const expectedCreate = createAssociatedTokenAccountIdempotentInstruction(
        TREASURY.publicKey,
        recipientAta,
        RECIPIENT,
        MINT,
      );
      const expectedTransfer = createTransferCheckedInstruction(
        treasuryAta,
        MINT,
        recipientAta,
        TREASURY.publicKey,
        2500n * BASE_UNITS_PER_CENT,
        HSUSD_DECIMALS,
      );

      expect(tx.instructions).toHaveLength(3);
      const [create, transfer, memoIx] = tx.instructions;

      expect(create!.programId.equals(expectedCreate.programId)).toBe(true);
      expect(Buffer.compare(create!.data, expectedCreate.data)).toBe(0);
      expect(create!.keys.map((k) => k.pubkey.toBase58())).toEqual(
        expectedCreate.keys.map((k) => k.pubkey.toBase58()),
      );

      expect(transfer!.programId.equals(expectedTransfer.programId)).toBe(true);
      expect(Buffer.compare(transfer!.data, expectedTransfer.data)).toBe(0);
      expect(transfer!.keys.map((k) => k.pubkey.toBase58())).toEqual(
        expectedTransfer.keys.map((k) => k.pubkey.toBase58()),
      );

      expect(memoIx!.programId.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      expect(memoIx!.data.toString('utf8')).toBe('order:42');
    });

    it('omits the memo instruction when no memo is given', async () => {
      const tx = await builtTransaction();
      expect(tx.instructions).toHaveLength(2);
    });

    // Standard Solana, documented as the caller's contract: identical inputs
    // on the same blockhash are byte-identical — ONE signature, one transfer.
    // Distinct payouts that can fire together must differ (per-order memo).
    it('collapses identical concurrent payouts into one deterministic signature', async () => {
      await serve(happyHandlers());
      const [a, b] = await Promise.all([
        pay({ to: RECIPIENT.toBase58(), amountCents: 500 }),
        pay({ to: RECIPIENT.toBase58(), amountCents: 500 }),
      ]);
      expect(a.signature).toBe(b.signature);
    });
  });

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  it('resolves with the base58 signature once confirmed', async () => {
    await serve(happyHandlers());
    const { signature } = await pay({ to: RECIPIENT.toBase58(), amountCents: 2500 });
    expect(bs58.decode(signature)).toHaveLength(64);
  });

  it('uses a custom PaymentSigner and its address as fee payer and authority', async () => {
    const server = await serve(happyHandlers());
    const vendor = Keypair.generate();
    let received: string | undefined;
    const signer: PaymentSigner = {
      address: vendor.publicKey.toBase58(),
      async sendTransaction(txBase64) {
        received = txBase64;
        // Sign like a vendor would, then just report the signature (no
        // broadcast needed against the mock).
        const wire = Buffer.from(txBase64, 'base64');
        const signature = nacl.sign.detached(wire.subarray(65), vendor.secretKey);
        return bs58.encode(signature);
      },
    };

    const { signature } = await pay({ to: RECIPIENT.toBase58(), amountCents: 300 }, { signer });

    expect(received).toBeDefined();
    const tx = Transaction.from(Buffer.from(received!, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(vendor.publicKey.toBase58());
    expect(bs58.decode(signature)).toHaveLength(64);
    // The mock never saw a broadcast from the SDK — the signer owned it.
    expect(server.requests.filter((r) => r.method === 'sendTransaction')).toHaveLength(0);
  });

  describe('failure paths', () => {
    it('throws send_failed when the RPC rejects the broadcast (nothing sent)', async () => {
      await serve(
        happyHandlers({
          sendTransaction: () => ({
            __error: {
              code: -32002,
              message: 'Transaction simulation failed: insufficient funds',
            },
          }),
        }),
      );
      const error = await pay({ to: RECIPIENT.toBase58(), amountCents: 100 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PayError);
      expect((error as PayError).code).toBe('send_failed');
      expect((error as PayError).signature).toBeUndefined();
    });

    it('ignores a processed-level err and resolves when the cluster confirms success', async () => {
      // A minority fork can report err at 'processed' for a tx that succeeds
      // on the canonical fork — err must only count at cluster commitment.
      await serve(
        happyHandlers({
          getSignatureStatuses: (_params, hit) =>
            hit === 0
              ? {
                  context: CONTEXT,
                  value: [
                    {
                      slot: 34567,
                      confirmations: 0,
                      err: { InstructionError: [1, { Custom: 1 }] },
                      confirmationStatus: 'processed',
                    },
                  ],
                }
              : confirmedStatus,
        }),
      );
      const { signature } = await pay({ to: RECIPIENT.toBase58(), amountCents: 100 });
      expect(signature).toBeDefined();
    });

    it('throws rpc_error with signature AND lastValidBlockHeight when the broadcast transport fails', async () => {
      await serve(
        happyHandlers({
          sendTransaction: () => ({ __destroy: true }),
        }),
      );
      const error = await pay({ to: RECIPIENT.toBase58(), amountCents: 100 }).catch(
        (e: unknown) => e,
      );
      expect((error as PayError).code).toBe('rpc_error');
      expect((error as PayError).signature).toBeDefined();
      expect((error as PayError).lastValidBlockHeight).toBe(LAST_VALID);
    });

    it('throws failed_on_chain when the landed transaction errored', async () => {
      await serve(
        happyHandlers({
          getSignatureStatuses: () => ({
            context: CONTEXT,
            value: [
              {
                slot: 34567,
                confirmations: 5,
                err: { InstructionError: [1, { Custom: 1 }] },
                confirmationStatus: 'confirmed',
              },
            ],
          }),
        }),
      );
      const error = await pay({ to: RECIPIENT.toBase58(), amountCents: 100 }).catch(
        (e: unknown) => e,
      );
      expect((error as PayError).code).toBe('failed_on_chain');
      expect((error as PayError).signature).toBeDefined();
    });

    it('throws expired once the finalized height passes lastValidBlockHeight', async () => {
      await serve(
        happyHandlers({
          getSignatureStatuses: () => nullStatus,
          getBlockHeight: () => LAST_VALID + 1,
        }),
      );
      const error = await pay({ to: RECIPIENT.toBase58(), amountCents: 100 }).catch(
        (e: unknown) => e,
      );
      expect((error as PayError).code).toBe('expired');
      expect((error as PayError).signature).toBeDefined();
      expect((error as PayError).lastValidBlockHeight).toBe(LAST_VALID);
    });

    it('never applies the expiry fence for a custom signer', async () => {
      const server = await serve(
        happyHandlers({
          getSignatureStatuses: (_params, hit) => (hit < 2 ? nullStatus : confirmedStatus),
          getBlockHeight: () => LAST_VALID + 1,
        }),
      );
      const vendor = Keypair.generate();
      const signer: PaymentSigner = {
        address: vendor.publicKey.toBase58(),
        sendTransaction: async (txBase64) =>
          bs58.encode(
            nacl.sign.detached(Buffer.from(txBase64, 'base64').subarray(65), vendor.secretKey),
          ),
      };
      const { signature } = await pay({ to: RECIPIENT.toBase58(), amountCents: 100 }, { signer });
      expect(signature).toBeDefined();
      // A custom signer may have re-blockhashed, so no getBlockHeight fence ran.
      expect(server.requests.filter((r) => r.method === 'getBlockHeight')).toHaveLength(0);
    });
  });

  describe('validation and configuration', () => {
    it('rejects a non-integer or non-positive amount', async () => {
      await serve(happyHandlers());
      await expect(pay({ to: RECIPIENT.toBase58(), amountCents: 0 })).rejects.toThrow(
        'positive integer',
      );
      await expect(pay({ to: RECIPIENT.toBase58(), amountCents: 12.5 })).rejects.toThrow(
        'positive integer',
      );
    });

    it('rejects an invalid recipient before any RPC call', async () => {
      const server = await serve(happyHandlers());
      await expect(pay({ to: 'not-a-wallet-0OIl', amountCents: 100 })).rejects.toThrow(
        'recipient wallet',
      );
      expect(server.requests).toHaveLength(0);
    });

    it('requires BANKROLL_TREASURY_KEY when no signer is given', async () => {
      await serve(happyHandlers());
      delete process.env.BANKROLL_TREASURY_KEY;
      await expect(pay({ to: RECIPIENT.toBase58(), amountCents: 100 })).rejects.toThrow(
        'BANKROLL_TREASURY_KEY',
      );
    });

    it('rejects a PDA treasury with a clear message', async () => {
      await serve(happyHandlers());
      const pdaTreasury = getAssociatedTokenAddressSync(MINT, RECIPIENT); // any off-curve address
      const signer: PaymentSigner = {
        address: pdaTreasury.toBase58(),
        sendTransaction: async () => 'never',
      };
      await expect(
        pay({ to: RECIPIENT.toBase58(), amountCents: 100 }, { signer }),
      ).rejects.toThrow('keypair-backed treasury');
    });

    it('rejects a secret key whose embedded public key does not match its seed', () => {
      const corrupt = Uint8Array.from(TREASURY.secretKey);
      corrupt[40] = corrupt[40]! ^ 0xff;
      expect(() => keypairSigner(bs58.encode(corrupt))).toThrow('not a valid');
    });

    it('rejects a transaction that exceeds the packet size before sending', async () => {
      const server = await serve(happyHandlers());
      const error = await pay({
        to: RECIPIENT.toBase58(),
        amountCents: 100,
        memo: 'x'.repeat(1300),
      }).catch((e: unknown) => e);
      expect(String(error)).toContain('too large');
      expect(server.requests.filter((r) => r.method === 'sendTransaction')).toHaveLength(0);
    });
  });

  describe('keypairSigner', () => {
    it('derives the address embedded in the secret key', () => {
      const signer = keypairSigner(TREASURY_SECRET);
      expect(signer.address).toBe(TREASURY.publicKey.toBase58());
    });
  });

  // -------------------------------------------------------------------------
  // The lifecycle: buildPayout → sendPayout → confirmPayout
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('buildPayout returns the unsigned transaction and its expiry without broadcasting', async () => {
      const server = await serve(happyHandlers());

      const built = await buildPayout({ to: RECIPIENT.toBase58(), amountCents: 750, memo: 'o:1' });

      expect(built.lastValidBlockHeight).toBe(LAST_VALID);
      expect(built.blockhash).toBe(BLOCKHASH);
      const tx = Transaction.from(Buffer.from(built.transaction, 'base64'));
      expect(tx.feePayer?.toBase58()).toBe(TREASURY.publicKey.toBase58());
      expect(tx.instructions).toHaveLength(3);
      // Nothing sent, nothing confirmed — build is a pure read + assemble.
      expect(server.requests.map((r) => r.method)).toEqual(['getLatestBlockhash']);
    });

    it('sendPayout hands the signer EXACTLY the built bytes (byte-identical replay)', async () => {
      await serve(happyHandlers());
      const built = await buildPayout({ to: RECIPIENT.toBase58(), amountCents: 750 });

      let received: string | undefined;
      const vendor = Keypair.generate();
      const signer: PaymentSigner = {
        address: TREASURY.publicKey.toBase58(),
        sendTransaction: async (txBase64) => {
          received = txBase64;
          return bs58.encode(
            nacl.sign.detached(Buffer.from(txBase64, 'base64').subarray(65), vendor.secretKey),
          );
        },
      };
      await sendPayout(built.transaction, { signer });

      expect(received).toBe(built.transaction);
    });

    it('sendPayout resolves on broadcast without waiting for confirmation', async () => {
      const server = await serve(happyHandlers());
      const built = await buildPayout({ to: RECIPIENT.toBase58(), amountCents: 750 });

      const { signature } = await sendPayout(built.transaction);

      expect(bs58.decode(signature)).toHaveLength(64);
      expect(server.requests.filter((r) => r.method === 'getSignatureStatuses')).toHaveLength(0);
    });

    it('confirmPayout resolves once the cluster confirms', async () => {
      await serve(happyHandlers());
      const built = await buildPayout({ to: RECIPIENT.toBase58(), amountCents: 750 });
      const { signature } = await sendPayout(built.transaction);

      await expect(
        confirmPayout(signature, { lastValidBlockHeight: built.lastValidBlockHeight }),
      ).resolves.toBeUndefined();
    });

    it('confirmPayout is the reconciliation primitive: a stored dead signature resolves to expired', async () => {
      await serve(
        happyHandlers({
          getSignatureStatuses: () => nullStatus,
          getBlockHeight: () => LAST_VALID + 1,
        }),
      );

      const error = await confirmPayout('StoredSignature1111111111111111111111111111111111111111111111111', {
        lastValidBlockHeight: LAST_VALID,
      }).catch((e: unknown) => e);

      expect((error as PayError).code).toBe('expired');
      expect((error as PayError).lastValidBlockHeight).toBe(LAST_VALID);
    });

    it('confirmPayout never applies the expiry fence without a lastValidBlockHeight', async () => {
      const server = await serve(
        happyHandlers({
          getSignatureStatuses: (_params, hit) => (hit < 2 ? nullStatus : confirmedStatus),
          getBlockHeight: () => LAST_VALID + 1,
        }),
      );

      await confirmPayout('SomeSignature111111111111111111111111111111111111111111111111111');

      expect(server.requests.filter((r) => r.method === 'getBlockHeight')).toHaveLength(0);
    });
  });
});
