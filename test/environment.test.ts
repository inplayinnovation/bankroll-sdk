import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_ENVIRONMENT, ENVIRONMENT_SETTING, appEnvironment } from '../src/environment';

// An app's environments (Bankroll's notes/app-environments.md): one setting,
// BANKROLL_ENVIRONMENT=test, makes a deployment a test environment. Anything
// else is live, so a deployment that never heard of the setting is live.
describe('appEnvironment', () => {
  it('is test for BANKROLL_ENVIRONMENT=test and live for anything else', () => {
    expect(appEnvironment({ [ENVIRONMENT_SETTING]: 'test' })).toBe(APP_ENVIRONMENT.test);
    expect(appEnvironment({ [ENVIRONMENT_SETTING]: 'live' })).toBe(APP_ENVIRONMENT.live);
    expect(appEnvironment({ [ENVIRONMENT_SETTING]: 'TEST' })).toBe(APP_ENVIRONMENT.live);
    expect(appEnvironment({ [ENVIRONMENT_SETTING]: '' })).toBe(APP_ENVIRONMENT.live);
    expect(appEnvironment({})).toBe(APP_ENVIRONMENT.live);
  });
});

// The cash mint follows the environment at module load, so the app's charges
// and payouts settle in test cash on a test deployment with no code change.
describe('HSUSD_MINT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is BCASH by default', async () => {
    vi.stubEnv(ENVIRONMENT_SETTING, undefined);
    vi.resetModules();
    const charges = await import('../src/charges');
    expect(charges.HSUSD_MINT).toBe(charges.BCASH_MINT);
    expect(charges.BCASH_MINT).toBe('4FVaHEubcqws8hKwJSiW8f8CmKGUyMsBxTKUytcGdRvd');
  });

  it('is test cash on a test deployment', async () => {
    vi.stubEnv(ENVIRONMENT_SETTING, 'test');
    vi.resetModules();
    const charges = await import('../src/charges');
    expect(charges.HSUSD_MINT).toBe(charges.TEST_CASH_MINT);
    expect(charges.TEST_CASH_MINT).toBe('BSHVy5kVBKrrPtD2kasMQKacqzUEMQE2DVGJckNEi2Jf');
    expect(charges.TEST_CASH_MINT).not.toBe(charges.BCASH_MINT);
  });
});
