// Which Solana endpoint the server half talks to.
//
// Everything here reads the environment on each call rather than at import.
// Importing a package must never mutate or snapshot the environment: a module
// imported for its side effect is invisible at the call site, and a snapshot
// taken at import time is wrong for anything that configures the environment
// later (a test, a script that loads .env itself).

/**
 * Solana's public endpoint — enough to develop against and to run a quiet app,
 * but rate-limited and not meant for production traffic. Setting your own
 * SOLANA_RPC_URL is the upgrade, not a requirement to get started.
 */
export const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/** The endpoint actually in use, public default included. */
export const rpcUrl = (): string => process.env.SOLANA_RPC_URL || PUBLIC_MAINNET_RPC;

/**
 * Whether the default is in play. Worth surfacing to a developer — the public
 * endpoint is the first thing to suspect when calls start failing under load.
 */
export const usingPublicRpc = (): boolean => !process.env.SOLANA_RPC_URL;
