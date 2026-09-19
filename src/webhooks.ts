// Bankroll's webhooks to your app, on one route: /api/bankroll/webhook.
// Bankroll reports on the managed references your server minted with
// createManagedReference() — `reference.confirmed` when the first successful
// transaction carrying one lands, `reference.expired` when the window ends
// with none — and on the timers it set with createTimer(): `timer.fired`
// when the time comes. Bankroll reports facts and never
// judges: read a transaction (checkCharge for a pay-in) and decide.
// Deliveries are signed; a signature that does not verify never reaches a
// handler.
//
// Framework-free: bankrollWebhook() returns a plain (Request) => Response
// handler, which is a Next.js route handler as it stands.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Json } from './matchmaking';
import { record } from './matchmaking-core';
import { isMockReference, isMockTimer, mockEnabled, noteMockConfirmed, parseMockReference, parseMockTimer } from './mock';

/** Where Bankroll delivers reference events: the route referenceWebhook() serves. */
export const WEBHOOK_PATH = '/api/bankroll/webhook';
const SECRET_ENV = 'BANKROLL_WEBHOOK_SECRET';
const SECRET_PREFIX = 'whsec_';
const SIGNATURE_SCHEME = 'v1';
// The timestamp is signed so a captured delivery cannot be replayed later.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const BODY_LIMIT_BYTES = 64 * 1024;

export const REFERENCE_CONFIRMED = 'reference.confirmed';
export const REFERENCE_EXPIRED = 'reference.expired';
export const TIMER_FIRED = 'timer.fired';

export interface ReferenceConfirmed {
  type: typeof REFERENCE_CONFIRMED;
  reference: string;
  /** The meta the reference was created with, verbatim. */
  meta: Json;
  /** The first successful transaction carrying the reference. Read it before you act. */
  signature: string;
  slot: number;
}

export interface ReferenceExpired {
  type: typeof REFERENCE_EXPIRED;
  reference: string;
  meta: Json;
  expiredAt: string;
}

export type ReferenceEvent = ReferenceConfirmed | ReferenceExpired;

export interface TimerFired {
  type: typeof TIMER_FIRED;
  id: string;
  /** The meta the timer was set with, verbatim. */
  meta: Json;
  /** The time the timer was set for. */
  at: string;
}

export type AppEvent = ReferenceEvent | TimerFired;

export interface BankrollWebhookHandlers {
  onConfirmed(event: ReferenceConfirmed): Promise<void> | void;
  onExpired(event: ReferenceExpired): Promise<void> | void;
  /** A timer fired. Optional: an app that sets no timers has nothing to hear. */
  onFired?(event: TimerFired): Promise<void> | void;
  /** The endpoint secret Bankroll handed you at signing; defaults to BANKROLL_WEBHOOK_SECRET. */
  secret?: string;
}

type Verdict = 'signed' | 'unsigned' | 'invalid';

// HMAC-SHA256 of `${id}.${timestamp}.${body}` under the endpoint secret,
// base64 in the signature header as space-separated `v1,<sig>` entries (more
// than one while a secret rotates).
function verifySignature(headers: Headers, body: string, secret: string | undefined): Verdict {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures) return 'unsigned';
  if (!secret) {
    throw new Error(
      `${SECRET_ENV} is not set. It is the secret Bankroll signs webhooks with, ` +
        'handed to you with the signed manifest.',
    );
  }
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > TIMESTAMP_TOLERANCE_SECONDS) {
    return 'invalid';
  }
  const key = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  for (const entry of signatures.split(' ')) {
    const [scheme, value] = entry.split(',');
    if (scheme !== SIGNATURE_SCHEME || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return 'signed';
  }
  return 'invalid';
}

function parseEvent(body: string): AppEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!record(value)) return null;
  // Under the mock the deliveries carry no meta: the reference or the id does.
  const meta: Json | undefined = 'meta' in value ? (value.meta as Json) : undefined;
  if (value.type === TIMER_FIRED) {
    if (typeof value.id !== 'string' || typeof value.at !== 'string') return null;
    const resolved = meta ?? (mockEnabled() && isMockTimer(value.id) ? parseMockTimer(value.id)?.meta : undefined);
    if (resolved === undefined) return null;
    return { type: TIMER_FIRED, id: value.id, meta: resolved, at: value.at };
  }
  if (typeof value.reference !== 'string') return null;
  const mocked = mockEnabled() && isMockReference(value.reference) ? parseMockReference(value.reference) : null;
  const resolved = meta ?? mocked?.meta;
  if (resolved === undefined) return null;
  if (value.type === REFERENCE_CONFIRMED) {
    if (typeof value.signature !== 'string' || typeof value.slot !== 'number') return null;
    return { type: REFERENCE_CONFIRMED, reference: value.reference, meta: resolved, signature: value.signature, slot: value.slot };
  }
  if (value.type === REFERENCE_EXPIRED) {
    if (typeof value.expiredAt !== 'string') return null;
    return { type: REFERENCE_EXPIRED, reference: value.reference, meta: resolved, expiredAt: value.expiredAt };
  }
  return null;
}

/**
 * The route handler for POST /api/bankroll/webhook:
 *
 *   export const POST = bankrollWebhook({ onConfirmed, onExpired, onFired });
 *
 * A delivery whose signature does not verify is refused with 401 and never
 * reaches a handler. A handler that throws makes the route answer 500, which
 * is what tells Bankroll to deliver again later, so let a failure propagate
 * rather than swallowing it. Handle each event idempotently: Bankroll retries
 * until it gets a 2xx, and one reference can be told about twice across a
 * retry.
 *
 * With BANKROLL_MOCK=1 outside production an unsigned delivery is accepted
 * too, so the mock host and the mock payout signer can drive the route.
 */
export function bankrollWebhook(handlers: BankrollWebhookHandlers): (request: Request) => Promise<Response> {
  return async function POST(request: Request): Promise<Response> {
    const body = await request.text();
    if (Buffer.byteLength(body) > BODY_LIMIT_BYTES) {
      return Response.json({ error: 'body_too_large' }, { status: 413 });
    }
    const verdict = verifySignature(request.headers, body, handlers.secret ?? process.env[SECRET_ENV]);
    if (verdict !== 'signed' && !(verdict === 'unsigned' && mockEnabled())) {
      return Response.json({ error: 'invalid_signature' }, { status: 401 });
    }
    const event = parseEvent(body);
    if (!event) return Response.json({ error: 'invalid_event' }, { status: 400 });
    if (event.type === TIMER_FIRED) {
      await handlers.onFired?.(event);
    } else if (event.type === REFERENCE_CONFIRMED) {
      await handlers.onConfirmed(event);
      // Only a handled confirmation silences the mock's expiry: a handler
      // that threw gets the expiry the way it would get Bankroll's retry.
      if (mockEnabled()) noteMockConfirmed(event.reference);
    } else {
      await handlers.onExpired(event);
    }
    return Response.json({ received: true });
  };
}

/** The 0.28 name; the route now carries timers too. */
export const referenceWebhook = bankrollWebhook;
export type ReferenceWebhookHandlers = BankrollWebhookHandlers;
