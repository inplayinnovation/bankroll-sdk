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

// Warned at most once per process: this is a standing condition, not a
// per-request event, and a line per payout would be noise nobody reads.
let warned = false;

/**
 * The endpoint actually in use, public default included.
 *
 * Falling back is deliberate — an app should take its first payment without
 * configuring an RPC — but it is not silent. The public endpoint rate-limits
 * under concurrency, and a 429 while broadcasting a payout surfaces as
 * PayError('rpc_error') with an unknown outcome, which is the one failure a
 * caller cannot safely retry. Anything taking real money wants its own endpoint.
 */
export const rpcUrl = (): string => {
  const configured = process.env.SOLANA_RPC_URL;
  if (configured) return configured;
  if (!warned) {
    warned = true;
    console.warn(
      '[bankroll] SOLANA_RPC_URL is not set — using the public Solana endpoint, ' +
        'which is rate-limited and not meant for production traffic.',
    );
  }
  return PUBLIC_MAINNET_RPC;
};

/**
 * Whether the default is in play. Worth surfacing to a developer — the public
 * endpoint is the first thing to suspect when calls start failing under load.
 */
export const usingPublicRpc = (): boolean => !process.env.SOLANA_RPC_URL;
