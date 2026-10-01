// An app's environments (Bankroll's notes/app-environments.md): test, paid in
// test cash, and live. A deployment learns which it is from one setting,
// BANKROLL_ENVIRONMENT=test, which Bankroll sets on an app's test deployments;
// anything else, the setting included, is live. The manifest carries the same
// fact as the `environment` claim, so the host charges a test app in test cash.

export const ENVIRONMENT_SETTING = 'BANKROLL_ENVIRONMENT';

export const APP_ENVIRONMENT = {
  test: 'test',
  live: 'live',
} as const;
export type AppEnvironment = (typeof APP_ENVIRONMENT)[keyof typeof APP_ENVIRONMENT];

/** Which environment this deployment is: test when BANKROLL_ENVIRONMENT=test, else live. */
export function appEnvironment(env: Record<string, string | undefined> = process.env): AppEnvironment {
  return env[ENVIRONMENT_SETTING] === APP_ENVIRONMENT.test ? APP_ENVIRONMENT.test : APP_ENVIRONMENT.live;
}
