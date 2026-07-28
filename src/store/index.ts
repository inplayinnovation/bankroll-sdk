// Durable state for a Built-for-Bankroll app — no database to provision.
//
// One interface, backends behind it (./fs for local development, ./vercel for a
// deployment). Nothing written against this knows which is live, which is what
// lets the same code deploy unchanged.
//
// Money code needs exactly two guarantees, and both are in the interface:
//
//   createIfAbsent   an atomic create that fails if the path is taken. Recording
//           "this payment signature is spent" has to be something two concurrent
//           requests cannot both succeed at.
//   writeJson with ifMatch   compare-and-swap, so a document can't be clobbered
//           by a concurrent writer.
//
// Note what is absent: a balance. A Bankroll app does not hold anyone's money —
// the host is the wallet. The app sells things and remembers what was sold.

export interface StoredJson<T> {
  value: T;
  etag: string;
}

/** Thrown by writeJson when the stored etag no longer matches — someone else wrote first. */
export class PreconditionFailed extends Error {
  constructor(pathname: string, options?: { cause?: unknown }) {
    super(`${pathname} changed since it was read`, options);
    this.name = 'PreconditionFailed';
  }
}

/** Thrown by updateJson when there is nothing at `pathname` to update. */
export class DocumentNotFound extends Error {
  constructor(pathname: string) {
    super(`no document at ${pathname}`);
    this.name = 'DocumentNotFound';
  }
}

/** Thrown by updateJson when a compare-and-swap could not settle. */
export class TooContended extends Error {
  constructor(pathname: string, attempts: number) {
    super(`${pathname} is too contended to update (${attempts} attempts)`);
    this.name = 'TooContended';
  }
}

export interface StoreBackend {
  /** Read a JSON document, or null if it doesn't exist. Never served stale. */
  readJson<T>(pathname: string): Promise<StoredJson<T> | null>;

  /**
   * Write a JSON document. With `ifMatch`, the write only lands if the stored
   * etag still matches, and throws PreconditionFailed otherwise.
   */
  writeJson(pathname: string, value: unknown, ifMatch?: string): Promise<void>;

  /**
   * Create a document only if `pathname` is free. Returns false when it was
   * already taken — losing that race is an expected outcome, not an error, so
   * real failures (network, permissions) still throw.
   */
  createIfAbsent(pathname: string, value: unknown): Promise<boolean>;

  /**
   * A page of documents under a prefix, in ascending key order.
   *
   * Ordering is by key, so a caller that wants time order puts a sortable value
   * at the front of the key rather than sorting after the fact — which is what
   * keeps this cheap at any size: it reads only the page, never the whole
   * prefix. `cursor` resumes where the last page stopped; the returned `cursor`
   * is absent once the prefix is exhausted.
   *
   * Contents still cost a read per document — neither backend returns them in a
   * listing. That is inherent to asking for a collection, not a fix waiting to
   * happen: the alternative is an index document, a second thing to keep in
   * step, which is exactly what this store is shaped to avoid.
   */
  list<T>(
    prefix: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ items: T[]; cursor?: string }>;
}

// Slots are u64 on-chain but the SDK surfaces them as a JS number, so
// MAX_SAFE_INTEGER is the ceiling and its digit count is the width.
const SLOT_CEILING = Number.MAX_SAFE_INTEGER;
const SLOT_WIDTH = String(SLOT_CEILING).length;

const DEFAULT_CAS_ATTEMPTS = 5;

/**
 * A document id built from the transaction that created it — stable across
 * retries, and ordered newest-first.
 *
 * Both parts come from the transaction, so the id is identical on every attempt
 * — which is what lets an atomic create double as the replay guard. And because
 * a listing can only order by key, the slot goes first: an object store sorts
 * keys lexicographically, so inverting the slot (largest first) makes a listing
 * come back newest-first with no post-sort.
 *
 * Put the signature *after* the slot so it is never a key prefix: a caller can
 * then only look a document up by its full id. Recovering one from a bare
 * signature is a route-layer concern — confirmCharge yields the slot, and this
 * rebuilds the id.
 */
export function sortableId(slot: number, signature: string): string {
  return `${String(SLOT_CEILING - slot).padStart(SLOT_WIDTH, '0')}-${signature}`;
}

/**
 * Read-modify-write a document under compare-and-swap.
 *
 * `change` sees the current value and returns the next one, or throws to abort
 * without writing. Retries on a lost race, so a concurrent caller cannot clobber
 * a transition — which is what makes "do this exactly once" hold without a
 * second document to guard it.
 *
 * Throws DocumentNotFound if there is nothing there, and TooContended if the
 * swap never settled. Both are worth distinguishing: the first is a caller
 * error, the second is load.
 */
export async function updateJson<T>(
  backend: StoreBackend,
  pathname: string,
  change: (current: T) => T,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_CAS_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stored = await backend.readJson<T>(pathname);
    if (!stored) throw new DocumentNotFound(pathname);
    const next = change(stored.value);
    try {
      await backend.writeJson(pathname, next, stored.etag);
      return next;
    } catch (error) {
      // Someone else wrote — re-read and decide again against theirs.
      if (error instanceof PreconditionFailed) continue;
      throw error;
    }
  }
  throw new TooContended(pathname, attempts);
}
