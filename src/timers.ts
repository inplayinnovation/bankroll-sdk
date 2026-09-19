// Timers: your server sets one with a meta and a number of minutes, and when
// it fires Bankroll delivers `timer.fired` with the meta to your webhook
// route, once. For what a server must do when nobody is asking it: a no-show
// deadline, a round's expiry. Bankroll fires timers once a minute, so a timer
// is set in whole minutes. Verified apps only, like managed references.
//
// With BANKROLL_MOCK=1 outside production nothing reaches Bankroll: the timer
// is set here and delivers `timer.fired` to the route itself when it fires.
import { AppRequestFailure, postAsApp, type AppRequestCode, type AppRequestOptions } from './app-request';
import type { Json } from './matchmaking';
import { record, snapshot } from './matchmaking-core';
import { armMockTimer, mockEnabled, mockTimer } from './mock';

const TIMERS_PATH = '/api/v1/timers';
const MS_PER_MINUTE = 60 * 1000;

export type TimerErrorCode = AppRequestCode;

export class TimerError extends Error {
  readonly code: TimerErrorCode;
  readonly status?: number;

  constructor(code: TimerErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TimerError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export type TimerOptions = AppRequestOptions;

export interface TimerInput {
  /** Your own routing data, echoed on the event: what to do when the timer fires. Plain JSON, up to 4 KiB. */
  meta: Record<string, Json>;
  /** Whole minutes from now, 1 to 43200 (thirty days). */
  firesInMinutes: number;
}

export interface Timer {
  id: string;
  /** When the timer fires, as Bankroll recorded it. */
  at: string;
}

const invalid = (message: string): never => {
  throw new TimerError('invalid_argument', message);
};

/**
 * Set a timer on Bankroll. Store nothing but what `meta` needs to find its
 * subject again: the event brings `meta` back.
 */
export async function createTimer(input: TimerInput, options: TimerOptions): Promise<Timer> {
  let meta: Json;
  try {
    meta = snapshot(input.meta);
  } catch {
    return invalid('meta must contain only plain, finite JSON values');
  }
  if (!record(meta)) return invalid('meta must be a plain JSON object');
  if (!Number.isInteger(input.firesInMinutes) || input.firesInMinutes <= 0) {
    return invalid('firesInMinutes must be a whole number of minutes, one or more');
  }

  if (mockEnabled()) {
    const at = new Date(Date.now() + input.firesInMinutes * MS_PER_MINUTE).toISOString();
    const id = mockTimer(meta, at);
    armMockTimer(id, at);
    return { id, at };
  }

  let result: Record<string, unknown>;
  try {
    result = await postAsApp(TIMERS_PATH, { meta, firesInMinutes: input.firesInMinutes }, options);
  } catch (error) {
    if (error instanceof AppRequestFailure) throw new TimerError(error.code, error.message, error.status);
    throw error;
  }
  if (typeof result.id !== 'string' || typeof result.at !== 'string') {
    throw new TimerError('invalid_response', 'Malformed reply from Bankroll');
  }
  return { id: result.id, at: result.at };
}
