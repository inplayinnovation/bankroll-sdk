// Local files — so an app runs with no cloud account attached.
//
// The two money guarantees hold here as well as they do on an object store, by
// different means:
//
//   createIfAbsent   wx is an atomic exclusive create at the OS level — two
//           callers racing the same signature, exactly one wins.
//   ifMatch the etag is a hash of the file's contents, and the read-compare-
//           write runs under a per-path lock. Development is a single Node
//           process, so that lock is the whole story.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { PreconditionFailed, type StoreBackend, type StoredJson } from './index';

const ENCODING = 'utf8' as const;
const EXCLUSIVE_CREATE = 'wx' as const;
const DEFAULT_ENVIRONMENT = 'development';
const ROOT_DIRECTORY = 'bankroll';

/**
 * Where a default-rooted store lives, relative to the project.
 *
 * The environment segment is load-bearing: without it a test run and the app you
 * are developing share one directory, and the obvious test fixture — clear the
 * store before each case — deletes live data. That is worse than losing dev
 * state, because removing a spent-signature record turns an already-spent
 * payment back into a spendable one.
 *
 * Both toolchains set NODE_ENV on their own (next dev → development, vitest →
 * test), so the isolation needs no configuration and can't be forgotten.
 *
 * Deliberately not a dotfile: the point of a filesystem store is that you can
 * open your data and read it, which a hidden directory defeats.
 */
export function storeDirectory(): string {
  return join(ROOT_DIRECTORY, process.env.NODE_ENV || DEFAULT_ENVIRONMENT);
}

const etagOf = (contents: string) => createHash('sha256').update(contents).digest('hex');

async function read(file: string): Promise<string | null> {
  try {
    return await readFile(file, ENCODING);
  } catch (error) {
    // Missing is a normal answer here; every other failure is real.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// One promise chain per absolute path, so a read-compare-write can't interleave
// with another for the same document. Module-scoped on purpose: two backends
// pointing at the same root must share the lock, or neither is safe.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * A filesystem-backed store rooted at `root`, defaulting to `storeDirectory()`
 * under the current working directory.
 *
 * The root is resolved once, when this is called — not at import, and not per
 * operation. Import time is too early: it freezes NODE_ENV and the working
 * directory before a process has finished deciding either. Per operation is too
 * late: a single read-modify-write could then read from one store and write to
 * another if the environment moved underneath it.
 */
export function fsBackend(root?: string): StoreBackend {
  const base = resolve(process.cwd(), root ?? storeDirectory());

  // Paths are built from wallet addresses and transaction signatures. Those are
  // base58 today, but a traversal here would let a caller write anywhere on the
  // developer's disk, so containment is checked rather than assumed.
  function fileFor(pathname: string): string {
    const file = resolve(base, pathname);
    if (file !== base && !file.startsWith(base + '/')) {
      throw new Error(`refusing to store outside ${base}: ${pathname}`);
    }
    return file;
  }

  return {
    async readJson<T>(pathname: string): Promise<StoredJson<T> | null> {
      const contents = await read(fileFor(pathname));
      if (contents === null) return null;
      return { value: JSON.parse(contents) as T, etag: etagOf(contents) };
    },

    async writeJson(pathname: string, value: unknown, ifMatch?: string): Promise<void> {
      const file = fileFor(pathname);
      const contents = JSON.stringify(value);
      await withLock(file, async () => {
        if (ifMatch !== undefined) {
          const current = await read(file);
          if (current !== null && etagOf(current) !== ifMatch) {
            throw new PreconditionFailed(pathname);
          }
        }
        await mkdir(dirname(file), { recursive: true });
        // Write beside the target and move it into place. writeFile truncates
        // first, so writing directly lets a concurrent reader see an empty or
        // half-written file; rename is atomic within a filesystem, so a reader
        // sees either the old document or the new one.
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents, ENCODING);
        await rename(temporary, file);
      });
    },

    async list<T>(
      prefix: string,
      options: { limit?: number; cursor?: string } = {},
    ): Promise<{ items: T[]; cursor?: string }> {
      const directory = fileFor(prefix);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        // Nothing stored yet is an empty collection, not a failure.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] };
        throw error;
      }

      // readdir order is unspecified, so sort to match an object store's
      // ascending-key ordering — the backends must page identically. The cursor
      // is the last filename returned; resuming means everything after it.
      const ordered = names.filter((name) => name.endsWith('.json')).sort();
      const cursor = options.cursor;
      const start = cursor ? ordered.findIndex((name) => name > cursor) : 0;
      const from = start === -1 ? ordered.length : start;
      const page =
        options.limit === undefined
          ? ordered.slice(from)
          : ordered.slice(from, from + options.limit);

      const items = await Promise.all(
        page.map(async (name) => {
          const contents = await read(join(directory, name));
          return contents === null ? null : (JSON.parse(contents) as T);
        }),
      );

      const last = page.at(-1);
      const more = last !== undefined && from + page.length < ordered.length;
      return {
        items: items.filter((item) => item !== null) as T[],
        ...(more ? { cursor: last } : {}),
      };
    },

    async createIfAbsent(pathname: string, value: unknown): Promise<boolean> {
      const file = fileFor(pathname);
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(file, JSON.stringify(value), {
          encoding: ENCODING,
          flag: EXCLUSIVE_CREATE,
        });
        return true;
      } catch (error) {
        // Already taken is the expected outcome of losing; anything else is real.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
  };
}
