// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { bankroll, playLink } from '../src/index';

describe('SSR (no window)', () => {
  it('imports without touching window', () => {
    expect(typeof bankroll.status).toBe('function');
  });

  it('status() is unavailable', () => {
    expect(bankroll.status()).toBe('unavailable');
  });

  // A client module that calls init() at its top is also run by the server render.
  it('init() does nothing and does not fail', async () => {
    await expect(bankroll.init()).resolves.toBeUndefined();
    await expect(bankroll.session()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('playLink still works server-side', () => {
    expect(playLink('https://app.example')).toBe(
      `https://joinbankroll.com/play?url=${encodeURIComponent('https://app.example/')}`,
    );
  });
});
