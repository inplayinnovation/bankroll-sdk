// Server-side confirmation of a settled payment. `pay()` resolves with the
// settled transfer's signature; this module fetches that transaction from the
// app's own Solana RPC and returns the payment's facts — who paid whom, how
// much, and the memo. Comparing those facts to the order, and storing the
// signature against replay, is deliberately left to the app: the SDK observes,
// the app decides.

export const HSUSD_MINT = '4FVaHEubcqws8hKwJSiW8f8CmKGUyMsBxTKUytcGdRvd';
export const HSUSD_DECIMALS = 9;
/** Payments are denominated in whole US cents; HSUSD has 9 decimals. */
export const BASE_UNITS_PER_CENT = 10n ** 7n;

const DEFAULT_TIMEOUT_MS = 15_000;
// A payment the user just watched settle can be missing from the queried
// node's transaction index for a few seconds — "confirmed" is a push from the
// node that confirmed it, while getTransaction reads the index of whichever
// node answers, which lags ingestion. "Not found" therefore means "not visible
// yet" until the deadline passes. Transient RPC failures (rate limits, blips)
// are retried on the same schedule.
const POLL_INTERVAL_MS = 1_500;
// Each RPC attempt gets at least this much time even when the deadline is
// nearly spent, so a tight timeout can't strangle the one request it makes.
const MIN_ATTEMPT_TIMEOUT_MS = 1_000;

export type ConfirmPaymentErrorCode =
  | 'not_found' // never became visible before the deadline
  | 'failed_on_chain' // the transaction landed but failed
  | 'not_a_payment' // no lone HSUSD payer→payee transfer in the transaction
  | 'rpc_error'; // the RPC endpoint kept failing or answered malformed until the deadline

export class ConfirmPaymentError extends Error {
  readonly code: ConfirmPaymentErrorCode;

  constructor(code: ConfirmPaymentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfirmPaymentError';
    this.code = code;
  }
}

export interface ConfirmedPayment {
  /** Wallet the HSUSD left. Compare to your verified session's `user.wallet`. */
  payer: string;
  /** Wallet the HSUSD arrived at. Compare to your `capabilities.payments` address. */
  payee: string;
  /** Amount received, in US cents. Fractional only if the transfer wasn't whole cents. */
  amountCents: number;
  /**
   * Memo attached to the transaction, or null. For payments made through
   * `pay()` this is the string the page passed (trimmed, ≤ 80 chars), but the
   * value is read from the chain — a transaction built outside `pay()` can
   * carry anything, so treat it as untrusted, unbounded input.
   */
  memo: string | null;
}

export interface ConfirmPaymentOptions {
  /** Overrides the SOLANA_RPC_URL environment variable. */
  rpcUrl?: string;
  /**
   * How long to keep polling while the transaction isn't visible yet or the
   * RPC fails transiently. Each RPC attempt is also individually bounded, so a
   * hung connection can't stall past the deadline. Default 15 000 ms.
   */
  timeoutMs?: number;
}

// The slice of the jsonParsed getTransaction response this module reads.
interface RpcTokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface RpcInstruction {
  program?: string;
  parsed?: unknown;
}

interface RpcTransaction {
  meta: {
    err: unknown;
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
    innerInstructions?: Array<{ instructions: RpcInstruction[] }>;
  } | null;
  transaction: {
    message: { instructions: RpcInstruction[] };
  };
}

async function fetchTransaction(
  rpcUrl: string,
  signature: string,
  attemptTimeoutMs: number,
): Promise<RpcTransaction | null> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(attemptTimeoutMs),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          signature,
          { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ],
      }),
    });
  } catch (cause) {
    throw new ConfirmPaymentError('rpc_error', `RPC request to ${rpcUrl} failed`, { cause });
  }
  if (!response.ok) {
    throw new ConfirmPaymentError('rpc_error', `RPC responded ${response.status}`);
  }
  let body: { error?: { code?: number; message?: string }; result?: RpcTransaction | null };
  try {
    body = await response.json();
  } catch (cause) {
    throw new ConfirmPaymentError('rpc_error', 'RPC responded with invalid JSON', { cause });
  }
  if (body.error) {
    throw new ConfirmPaymentError(
      'rpc_error',
      `RPC error ${body.error.code}: ${body.error.message}`,
    );
  }
  if (!('result' in body)) {
    throw new ConfirmPaymentError('rpc_error', 'RPC response has neither result nor error');
  }
  return body.result ?? null;
}

// Net HSUSD movement per owning wallet, summed across all of an owner's token
// accounts. Balance deltas are net of everything in the transaction — including
// transfers executed inside program calls (smart-contract wallets), which
// instruction-walking would miss.
function hsusdDeltasByOwner(meta: NonNullable<RpcTransaction['meta']>): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const add = (balances: RpcTokenBalance[] | undefined, sign: bigint) => {
    for (const balance of balances ?? []) {
      if (balance.mint !== HSUSD_MINT || !balance.owner) continue;
      const delta = sign * BigInt(balance.uiTokenAmount.amount);
      deltas.set(balance.owner, (deltas.get(balance.owner) ?? 0n) + delta);
    }
  };
  add(meta.preTokenBalances, -1n);
  add(meta.postTokenBalances, 1n);
  return deltas;
}

// The memo can sit in a CPI inner instruction when a smart-contract wallet
// executed the payment, so scan those too — same reason balance deltas are
// used for the transfer itself.
function extractMemo(parsed: RpcTransaction): string | null {
  const instructions = [
    ...parsed.transaction.message.instructions,
    ...(parsed.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  for (const instruction of instructions) {
    if (instruction.program === 'spl-memo' && typeof instruction.parsed === 'string') {
      return instruction.parsed;
    }
  }
  return null;
}

/**
 * Fetches the settled payment `tx` (the signature `pay()` resolved with) from
 * your Solana RPC and returns its facts. Throws ConfirmPaymentError — a return
 * value means the transfer settled on-chain.
 *
 * The facts are yours to check before releasing value: `payee` must be your
 * payment address, `amountCents` must match the order, `payer` must match the
 * session's wallet — and store the signature (it's unique per payment) so the
 * same payment can't be redeemed twice.
 */
export async function confirmPayment(
  tx: string,
  options?: ConfirmPaymentOptions,
): Promise<ConfirmedPayment> {
  const rpcUrl = options?.rpcUrl ?? process.env.SOLANA_RPC_URL;
  // Misconfiguration is a programmer error, not a failed payment — throw plain.
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required (env var or options.rpcUrl)');

  const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let parsed: RpcTransaction | null = null;
  let lastRpcError: ConfirmPaymentError | null = null;
  while (!parsed) {
    const attemptTimeoutMs = Math.max(deadline - Date.now(), MIN_ATTEMPT_TIMEOUT_MS);
    try {
      parsed = await fetchTransaction(rpcUrl, tx, attemptTimeoutMs);
      lastRpcError = null;
    } catch (error) {
      if (!(error instanceof ConfirmPaymentError)) throw error;
      lastRpcError = error;
    }
    if (parsed) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw (
        lastRpcError ??
        new ConfirmPaymentError('not_found', `transaction ${tx} not found before the deadline`)
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  if (parsed.meta?.err) {
    throw new ConfirmPaymentError('failed_on_chain', `transaction ${tx} failed on-chain`);
  }
  if (!parsed.meta) {
    throw new ConfirmPaymentError('not_a_payment', `transaction ${tx} has no balance metadata`);
  }

  const deltas = hsusdDeltasByOwner(parsed.meta);
  const credits = [...deltas].filter(([, delta]) => delta > 0n);
  const debits = [...deltas].filter(([, delta]) => delta < 0n);
  const credit = credits[0];
  const debit = debits[0];
  if (credits.length !== 1 || debits.length !== 1 || !credit || !debit) {
    throw new ConfirmPaymentError(
      'not_a_payment',
      `transaction ${tx} is not a single HSUSD payer→payee transfer ` +
        `(${debits.length} debited, ${credits.length} credited)`,
    );
  }

  // Divide in bigint when the amount is whole cents so it stays exact well
  // past Number's 2^53 limit on atomic units; only dust needs the float path.
  const units = credit[1];
  return {
    payer: debit[0],
    payee: credit[0],
    amountCents:
      units % BASE_UNITS_PER_CENT === 0n
        ? Number(units / BASE_UNITS_PER_CENT)
        : Number(units) / Number(BASE_UNITS_PER_CENT),
    memo: extractMemo(parsed),
  };
}
