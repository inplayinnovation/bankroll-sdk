// The pieces of the matchmaking client that its stand-in shares: the error
// class, and the JSON snapshot that decides what counts as plain input.
import type { Json } from './matchmaking';

export type MatchmakingErrorCode = 'unauthenticated' | 'app_not_verified' | 'invalid_argument'
  | 'ticket_conflict' | 'queue_conflict' | 'unavailable' | 'invalid_response';
export class MatchmakingError extends Error {
  constructor(readonly code: MatchmakingErrorCode, message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'MatchmakingError';
  }
}
export const invalid = (): never => { throw new MatchmakingError('invalid_argument', 'Matchmaking input must contain only plain, finite JSON values'); };
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Copy synchronously before signing yields. Reject everything JSON would omit,
// transform, or invoke (including sparse arrays, accessors and toJSON methods).
export function snapshot(value: unknown, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) return invalid();
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (array && keys.length !== value.length + 1) return invalid();
  ancestors.add(value);
  try {
    const entries: [string, Json][] = [];
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return invalid();
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) return invalid();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return invalid();
      entries.push([key, snapshot(descriptor.value, ancestors)]);
    }
    return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  } finally { ancestors.delete(value); }
}

/**
 * An HTTPS origin, or null. As an issuer (the app's own origin) it must be
 * canonical and public; as an API endpoint a loopback HTTP origin is fine
 * for a local Bankroll.
 */
export function parseEndpoint(value: string, issuer: boolean): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !issuer)) return null;
    if (issuer && (url.origin !== value || !host.includes('.') || host.startsWith('[')
      || /^\d+\.\d+\.\d+\.\d+$/.test(host) || ['.localhost', '.local', '.internal', '.home.arpa'].some((suffix) => host.endsWith(suffix)))) return null;
    return url.origin;
  } catch {
    return null;
  }
}
