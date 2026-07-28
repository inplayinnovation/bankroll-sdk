// Vercel Blob. Requires no setup beyond connecting a Blob store to the project:
// Vercel injects BLOB_READ_WRITE_TOKEN automatically, which is why deploying
// needs no code change.
//
// Reads in the money path pass useCache: false — the CDN can otherwise serve a
// blob up to 60s stale, which would make read-modify-write unsafe.
//
// @vercel/blob is an OPTIONAL peer dependency: this module is the only thing in
// the SDK that imports it, so an app on another backend never installs it.
import { BlobPreconditionFailedError, get, list, put } from '@vercel/blob';

import { PreconditionFailed, type StoreBackend, type StoredJson } from './index';

const ACCESS = 'private' as const;

export function vercelBlobBackend(): StoreBackend {
  return {
    async readJson<T>(pathname: string): Promise<StoredJson<T> | null> {
      const result = await get(pathname, { access: ACCESS, useCache: false });
      if (!result || result.stream === null) return null;
      const text = await new Response(result.stream).text();
      return { value: JSON.parse(text) as T, etag: result.blob.etag };
    },

    async writeJson(pathname: string, value: unknown, ifMatch?: string): Promise<void> {
      try {
        await put(pathname, JSON.stringify(value), {
          access: ACCESS,
          allowOverwrite: true,
          ...(ifMatch ? { ifMatch } : {}),
        });
      } catch (error) {
        // Translated at the boundary so no Blob-specific type escapes this file.
        if (error instanceof BlobPreconditionFailedError) {
          throw new PreconditionFailed(pathname, { cause: error });
        }

        // Blob reports a lost conditional write two different ways: an ETag
        // mismatch, once the winner's write is visible, and a plain BlobError —
        // "the conditional request cannot succeed due to a conflicting operation
        // against this resource" — when two are in flight at the same instant.
        // Measured at 12 concurrent read-modify-writes, half the losers get the
        // second one. Both mean the same thing: you lost, re-read and reapply.
        //
        // That error is the base class, so it can't be identified by type without
        // also swallowing a suspended store or an expired token, and matching on
        // its message would break the day the wording changes. Ask the store
        // instead: if the document no longer carries the etag this write was
        // conditioned on, somebody else wrote and this is a lost race. Anything
        // else is a real failure and must propagate — after a conditional write
        // that Blob rejected, nothing of ours has landed.
        if (ifMatch !== undefined) {
          const current = await get(pathname, { access: ACCESS, useCache: false });
          if (current && current.blob.etag !== ifMatch) {
            throw new PreconditionFailed(pathname, { cause: error });
          }
        }
        throw error;
      }
    },

    async list<T>(
      prefix: string,
      options: { limit?: number; cursor?: string } = {},
    ): Promise<{ items: T[]; cursor?: string }> {
      // Blob returns pathnames in ascending lexicographic order and paginates
      // with an opaque cursor, so one call is one page.
      const page = await list({
        prefix,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });

      const items = await Promise.all(
        page.blobs.map(async (blob) => {
          const result = await get(blob.pathname, { access: ACCESS, useCache: false });
          if (!result || result.stream === null) return null;
          return JSON.parse(await new Response(result.stream).text()) as T;
        }),
      );

      return {
        items: items.filter((item) => item !== null) as T[],
        ...(page.hasMore ? { cursor: page.cursor } : {}),
      };
    },

    async createIfAbsent(pathname: string, value: unknown): Promise<boolean> {
      try {
        // allowOverwrite defaults to false, so this call fails if it's taken.
        await put(pathname, JSON.stringify(value), { access: ACCESS });
        return true;
      } catch (error) {
        // The conflict is reported by the Blob service, not as a distinct error
        // type, so ask the only question that decides the outcome: is the path
        // taken now? Anything else is a real failure and has to propagate rather
        // than be reported as "already there".
        //
        // If our own write landed but its response was lost, this reads as taken
        // — which refuses a payment we already recorded. That's the safe
        // direction to be wrong in; the opposite would credit it twice.
        const existing = await get(pathname, { access: ACCESS, useCache: false });
        if (existing) return false;
        throw error;
      }
    },
  };
}
