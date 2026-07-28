// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DocumentNotFound,
  PreconditionFailed,
  TooContended,
  sortableId,
  updateJson,
  type StoreBackend,
} from '../src/store/index';
import { fsBackend, storeDirectory } from '../src/store/fs';

interface Doc {
  n: number;
}

describe('sortableId', () => {
  it('is stable for the same transaction', () => {
    expect(sortableId(100, 'sig')).toBe(sortableId(100, 'sig'));
  });

  // This is what makes an atomic create double as the replay guard, and what
  // makes a listing come back newest-first with no post-sort.
  it('sorts a newer slot before an older one', () => {
    expect(sortableId(200, 'sig').localeCompare(sortableId(100, 'sig'))).toBeLessThan(0);
  });

  it('pads so ordering survives a change in magnitude', () => {
    expect(sortableId(9, 'sig').localeCompare(sortableId(10, 'sig'))).toBeGreaterThan(0);
  });

  // The signature must not be a key prefix, or a caller could look documents up
  // by signature alone rather than by full id.
  it('puts the slot first and the signature after', () => {
    const [slot, signature] = sortableId(100, 'sig').split('-');
    expect(slot).toMatch(/^\d+$/);
    expect(signature).toBe('sig');
  });
});

describe('fsBackend', () => {
  let root: string;
  let store: StoreBackend;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bankroll-store-'));
    store = fsBackend(root);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('reads back what it wrote', async () => {
    await store.writeJson('a.json', { n: 1 });
    expect((await store.readJson<Doc>('a.json'))?.value).toEqual({ n: 1 });
  });

  it('is null for a document that does not exist', async () => {
    expect(await store.readJson('missing.json')).toBeNull();
  });

  // Recording "this signature is spent" has to be something two concurrent
  // requests cannot both succeed at.
  it('lets exactly one of many concurrent creates win', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.createIfAbsent('once.json', { n: 1 })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rejects a write whose etag is stale', async () => {
    await store.writeJson('a.json', { n: 1 });
    const stale = (await store.readJson<Doc>('a.json'))!.etag;
    await store.writeJson('a.json', { n: 2 });
    await expect(store.writeJson('a.json', { n: 3 }, stale)).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    expect((await store.readJson<Doc>('a.json'))?.value).toEqual({ n: 2 });
  });

  it('accepts a write whose etag still matches', async () => {
    await store.writeJson('a.json', { n: 1 });
    const { etag } = (await store.readJson<Doc>('a.json'))!;
    await store.writeJson('a.json', { n: 2 }, etag);
    expect((await store.readJson<Doc>('a.json'))?.value).toEqual({ n: 2 });
  });

  // A traversal would let a caller write anywhere on the developer's disk.
  it.each(['../escape.json', 'a/../../escape.json'])('refuses to escape the root: %s', async (p) => {
    await expect(store.readJson(p)).rejects.toThrow('refusing to store outside');
  });

  it('leaves no temp files behind', async () => {
    await store.writeJson('a.json', { n: 1 });
    await store.writeJson('a.json', { n: 2 });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('writes readable JSON a developer can open', async () => {
    await store.writeJson('a.json', { n: 1 });
    expect(JSON.parse(await readFile(join(root, 'a.json'), 'utf8'))).toEqual({ n: 1 });
  });

  describe('list', () => {
    beforeEach(async () => {
      for (const name of ['c', 'a', 'b']) {
        await store.writeJson(`p/${name}.json`, { n: name.charCodeAt(0) });
      }
    });

    it('is empty for a prefix with nothing under it', async () => {
      expect(await store.list('nothing/')).toEqual({ items: [] });
    });

    it('returns ascending key order regardless of write order', async () => {
      const { items } = await store.list<Doc>('p/');
      expect(items.map((i) => i.n)).toEqual(['a', 'b', 'c'].map((c) => c.charCodeAt(0)));
    });

    it('pages with a cursor and stops cleanly', async () => {
      const first = await store.list<Doc>('p/', { limit: 2 });
      expect(first.items).toHaveLength(2);
      const cursor = first.cursor;
      if (cursor === undefined) throw new Error('expected a cursor with more to read');

      const second = await store.list<Doc>('p/', { cursor, limit: 2 });
      expect(second.items).toHaveLength(1);
      // Exhausted — no cursor, so a caller knows to stop.
      expect(second.cursor).toBeUndefined();
    });

    it('ignores files that are not documents', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(root, 'p', 'note.txt'), 'not json');
      expect((await store.list('p/')).items).toHaveLength(3);
    });
  });
});

describe('storeDirectory', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = saved;
  });

  // Without the environment segment, a test run and the app being developed
  // share a directory — and clearing the store before each case would delete
  // live data, turning already-spent signatures back into spendable ones.
  it('separates environments', () => {
    process.env.NODE_ENV = 'test';
    expect(storeDirectory()).toBe(join('bankroll', 'test'));
    process.env.NODE_ENV = 'production';
    expect(storeDirectory()).toBe(join('bankroll', 'production'));
  });

  it('falls back rather than producing bankroll/undefined', () => {
    delete process.env.NODE_ENV;
    expect(storeDirectory()).toBe(join('bankroll', 'development'));
  });
});

describe('updateJson', () => {
  let root: string;
  let store: StoreBackend;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bankroll-cas-'));
    store = fsBackend(root);
    await store.writeJson('doc.json', { n: 0 });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('applies the change and returns the new value', async () => {
    const next = await updateJson<Doc>(store, 'doc.json', (c) => ({ n: c.n + 1 }));
    expect(next).toEqual({ n: 1 });
    expect((await store.readJson<Doc>('doc.json'))?.value).toEqual({ n: 1 });
  });

  it('throws DocumentNotFound rather than creating', async () => {
    await expect(updateJson(store, 'missing.json', (c) => c)).rejects.toBeInstanceOf(
      DocumentNotFound,
    );
  });

  // Aborting must not write — this is how a caller refuses an illegal
  // transition (consuming something already consumed).
  it('does not write when change throws', async () => {
    await expect(
      updateJson<Doc>(store, 'doc.json', () => {
        throw new Error('already consumed');
      }),
    ).rejects.toThrow('already consumed');
    expect((await store.readJson<Doc>('doc.json'))?.value).toEqual({ n: 0 });
  });

  // The point of the retry: concurrent callers must not clobber each other, so
  // every increment has to land.
  it('loses no concurrent increment', async () => {
    const CONCURRENCY = 8;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        updateJson<Doc>(store, 'doc.json', (c) => ({ n: c.n + 1 }), { attempts: 50 }),
      ),
    );
    expect((await store.readJson<Doc>('doc.json'))?.value).toEqual({ n: CONCURRENCY });
  });

  it('throws TooContended rather than silently giving up', async () => {
    // A backend that always reports a lost race: the swap can never settle.
    const contended: StoreBackend = {
      ...store,
      async writeJson(pathname) {
        throw new PreconditionFailed(pathname);
      },
    };
    await expect(
      updateJson<Doc>(contended, 'doc.json', (c) => c, { attempts: 3 }),
    ).rejects.toBeInstanceOf(TooContended);
  });

  it('propagates a real write failure instead of retrying it', async () => {
    const broken: StoreBackend = {
      ...store,
      async writeJson() {
        throw new Error('disk on fire');
      },
    };
    await expect(updateJson<Doc>(broken, 'doc.json', (c) => c)).rejects.toThrow('disk on fire');
  });
});
