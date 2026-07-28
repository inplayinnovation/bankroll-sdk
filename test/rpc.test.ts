import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PUBLIC_MAINNET_RPC, rpcUrl, usingPublicRpc } from '../src/rpc';

describe('rpc', () => {
  const saved = process.env.SOLANA_RPC_URL;

  beforeEach(() => {
    delete process.env.SOLANA_RPC_URL;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = saved;
    vi.restoreAllMocks();
  });

  it('falls back to the public endpoint when unset', () => {
    expect(rpcUrl()).toBe(PUBLIC_MAINNET_RPC);
    expect(usingPublicRpc()).toBe(true);
  });

  it('uses a configured endpoint', () => {
    process.env.SOLANA_RPC_URL = 'https://rpc.example/';
    expect(rpcUrl()).toBe('https://rpc.example/');
    expect(usingPublicRpc()).toBe(false);
  });

  // An empty value in a .env file is a misconfiguration, not an endpoint —
  // using it verbatim would fail every call with an opaque fetch error.
  it('treats an empty value as unset', () => {
    process.env.SOLANA_RPC_URL = '';
    expect(rpcUrl()).toBe(PUBLIC_MAINNET_RPC);
    expect(usingPublicRpc()).toBe(true);
  });

  // Reading at call time, not import time: a test or a script that loads .env
  // after import must still be seen.
  it('reads the environment on each call', () => {
    expect(rpcUrl()).toBe(PUBLIC_MAINNET_RPC);
    process.env.SOLANA_RPC_URL = 'https://later.example/';
    expect(rpcUrl()).toBe('https://later.example/');
  });

});

// The warning fires once per process, so each case needs the module fresh.
describe('rpc fallback warning', () => {
  const saved = process.env.SOLANA_RPC_URL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SOLANA_RPC_URL;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = saved;
    vi.restoreAllMocks();
  });

  // The fallback is deliberate but must not be silent: on the public endpoint a
  // rate-limited broadcast surfaces as an unknown payout outcome, which is the
  // one failure a caller cannot safely retry.
  it('warns when it falls back', async () => {
    const { rpcUrl: fresh } = await import('../src/rpc');
    fresh();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('SOLANA_RPC_URL is not set'));
  });

  // A line per payout would be noise nobody reads.
  it('warns at most once per process', async () => {
    const { rpcUrl: fresh } = await import('../src/rpc');
    fresh();
    fresh();
    fresh();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when an endpoint is configured', async () => {
    process.env.SOLANA_RPC_URL = 'https://rpc.example/';
    const { rpcUrl: fresh } = await import('../src/rpc');
    fresh();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
