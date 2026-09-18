// Bankroll's webhooks to your app. Today one route: /api/bankroll/webhook,
// where Bankroll reports on the managed references your server minted with
// createManagedReference() — `reference.confirmed` when the first successful
// transaction carrying one lands, `reference.expired` when the window ends
// with none. Bankroll reports the signature only and never judges: read the
// transaction (checkCharge for a pay-in, confirmPayout for a payout) and
// decide. Deliveries are signed; a signature that does not verify never
// reaches a handler.
//
// Framework-free: referenceWebhook() returns a plain (Request) => Response
// handler, which is a Next.js route handler as it stands.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Json } from './matchmaking';
import { record } from './matchmaking-core';
import { isMockReference, mockEnabled, noteMockConfirmed, parseMockReference } from './mock';

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

export interface ReferenceWebhookHandlers {
  onConfirmed(event: ReferenceConfirmed): Promise<void> | void;
  onExpired(event: ReferenceExpired): Promise<void> | void;
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

function parseEvent(body: string): ReferenceEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!record(value) || typeof value.reference !== 'string') return null;
  // Under the mock the deliveries carry no meta: the reference does.
  const meta: Json | undefined = 'meta' in value ? (value.meta as Json) : undefined;
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
 *   export const POST = referenceWebhook({ onConfirmed, onExpired });
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
export function referenceWebhook(handlers: ReferenceWebhookHandlers): (request: Request) => Promise<Response> {
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
    if (event.type === REFERENCE_CONFIRMED) {
      if (mockEnabled()) noteMockConfirmed(event.reference);
      await handlers.onConfirmed(event);
    } else {
      await handlers.onExpired(event);
    }
    return Response.json({ received: true });
  };
}
