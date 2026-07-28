import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PUBLIC_MAINNET_RPC, rpcUrl, usingPublicRpc } from '../src/rpc';

describe('rpc', () => {
  const saved = process.env.SOLANA_RPC_URL;

  beforeEach(() => {
    delete process.env.SOLANA_RPC_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = saved;
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
