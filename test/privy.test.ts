// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Privy SDK: capture constructor config and wallet/solana calls.
const state = vi.hoisted(() => ({
  constructorInputs: [] as unknown[],
  getCalls: [] as string[],
  sendCalls: [] as Array<{ walletId: string; input: Record<string, unknown> }>,
  walletAddress: 'TreasuryAddress1111111111111111111111111111',
  getShouldFail: false,
}));

vi.mock('@privy-io/node', () => ({
  PrivyClient: class {
    constructor(config: unknown) {
      state.constructorInputs.push(config);
    }
    wallets() {
      return {
        get: async (walletId: string) => {
          state.getCalls.push(walletId);
          if (state.getShouldFail) throw new Error('privy is down');
          return { id: walletId, address: state.walletAddress, chain_type: 'solana' };
        },
        solana: () => ({
          signAndSendTransaction: async (walletId: string, input: Record<string, unknown>) => {
            state.sendCalls.push({ walletId, input });
            return { hash: 'PrivyReturnedSignature11111111111111111111111111111111111111111111' };
          },
        }),
      };
    }
  },
}));

import { privySigner } from '../src/privy';

const ENV_KEYS = ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_WALLET_ID'] as const;

describe('privySigner', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    state.constructorInputs.length = 0;
    state.getCalls.length = 0;
    state.sendCalls.length = 0;
    state.getShouldFail = false;
    process.env.PRIVY_APP_ID = 'app-id';
    process.env.PRIVY_APP_SECRET = 'app-secret';
    // Distinct wallet id per test so the module-level address cache never
    // carries state across tests.
    process.env.PRIVY_WALLET_ID = `wallet-${crypto.randomUUID()}`;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it('resolves the wallet address from Privy and exposes it', async () => {
    const signer = await privySigner();
    expect(signer.address).toBe(state.walletAddress);
    expect(state.getCalls).toEqual([process.env.PRIVY_WALLET_ID]);
    expect(state.constructorInputs[0]).toEqual({ appId: 'app-id', appSecret: 'app-secret' });
  });

  it('caches the address lookup across signer constructions', async () => {
    await privySigner();
    await privySigner({ idempotencyKey: 'payout-2' });
    expect(state.getCalls).toHaveLength(1);
  });

  it('does not cache a failed address lookup', async () => {
    state.getShouldFail = true;
    await expect(privySigner()).rejects.toThrow('privy is down');
    state.getShouldFail = false;
    const signer = await privySigner();
    expect(signer.address).toBe(state.walletAddress);
  });

  it('signs and sends with mainnet caip2, sponsorship, and the idempotency key', async () => {
    const signer = await privySigner({ idempotencyKey: 'payout-order-7' });

    const signature = await signer.sendTransaction('dGVzdC10eA==');

    expect(signature).toBe(
      'PrivyReturnedSignature11111111111111111111111111111111111111111111',
    );
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]!.walletId).toBe(process.env.PRIVY_WALLET_ID);
    expect(state.sendCalls[0]!.input).toEqual({
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      transaction: 'dGVzdC10eA==',
      sponsor: true,
      idempotency_key: 'payout-order-7',
    });
  });

  it('omits idempotency_key when none is given and honors sponsor: false', async () => {
    const signer = await privySigner({ sponsor: false });
    await signer.sendTransaction('dGVzdC10eA==');
    expect(state.sendCalls[0]!.input).toEqual({
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      transaction: 'dGVzdC10eA==',
      sponsor: false,
    });
  });

  it('prefers explicit options over environment variables', async () => {
    const signer = await privySigner({
      appId: 'other-app',
      appSecret: 'other-secret',
      walletId: `explicit-${crypto.randomUUID()}`,
    });
    expect(signer.address).toBe(state.walletAddress);
    expect(state.constructorInputs[0]).toEqual({ appId: 'other-app', appSecret: 'other-secret' });
  });

  for (const key of ENV_KEYS) {
    it(`throws a plain configuration error when ${key} is missing`, async () => {
      delete process.env[key];
      await expect(privySigner()).rejects.toThrow(key);
    });
  }
});
