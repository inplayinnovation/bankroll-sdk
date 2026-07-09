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

  it('playLink still works server-side', () => {
    expect(playLink('https://app.example')).toBe(
      `https://joinbankroll.com/play?url=${encodeURIComponent('https://app.example/')}`,
    );
  });
});
