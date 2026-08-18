// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BANKROLL_TOKEN_HEADER } from '../src/constants';
import {
  Unauthorized,
  getOrigin,
  getSession,
  manifestRoute,
  requireIdentity,
  requireSession,
  type ManifestApp,
} from '../src/next';

// next/headers is the only Next surface this module touches, so a stub for it
// is the whole framework dependency in these tests.
const state = vi.hoisted(() => ({ host: null as string | null }));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(state.host ? { host: state.host } : {}),
}));

const part = (jwt: string, index: number): string => {
  const value = jwt.split('.')[index];
  if (value === undefined) throw new Error(`manifest has no part ${index}: ${jwt}`);
  return value;
};

const decodeJson = (jwt: string, index: number) =>
  JSON.parse(Buffer.from(part(jwt, index), 'base64url').toString());

const decodeManifest = (jwt: string) => decodeJson(jwt, 1);

const APP: ManifestApp = {
  launch: '/app',
  name: () => 'Acme',
  payments: () => null,
};

describe('getOrigin', () => {
  beforeEach(() => {
    state.host = 'app.example';
  });

  it('is https for a deployed host', async () => {
    await expect(getOrigin()).resolves.toBe('https://app.example');
  });

  it.each(['localhost:3000', '127.0.0.1:3000'])('is http for %s', async (host) => {
    state.host = host;
    await expect(getOrigin()).resolves.toBe(`http://${host}`);
  });

  it('is https for a tunnel', async () => {
    state.host = 'brave-cat-42.trycloudflare.com';
    await expect(getOrigin()).resolves.toBe('https://brave-cat-42.trycloudflare.com');
  });

  // Guessing would mint session audiences and manifest `sub` claims for an
  // origin the app is not being served from, so this fails loudly instead.
  it('throws outside a request rather than guessing', async () => {
    state.host = null;
    await expect(getOrigin()).rejects.toThrow('outside a request');
  });

  // The only way to reach the throw in a real app is a prerendered route, so
  // the error has to name the fix rather than leave it to be worked out.
  it('names force-dynamic as the fix', async () => {
    state.host = null;
    await expect(getOrigin()).rejects.toThrow("dynamic = 'force-dynamic'");
  });
});

describe('sessions', () => {
  beforeEach(() => {
    state.host = 'app.example';
  });

  it('is null without a token, without reaching the network', async () => {
    await expect(getSession(new Request('https://app.example/api/me'))).resolves.toBeNull();
  });

  it('is null for a blank token', async () => {
    const request = new Request('https://app.example/api/me', {
      headers: { [BANKROLL_TOKEN_HEADER]: '   ' },
    });
    await expect(getSession(request)).resolves.toBeNull();
  });

  it('requireSession throws Unauthorized rather than returning null', async () => {
    await expect(requireSession(new Request('https://app.example/api/me'))).rejects.toBeInstanceOf(
      Unauthorized,
    );
  });

  it('requireIdentity gates on a verified identity', () => {
    const session = (identity: { age?: number } | false) =>
      ({ user: { identity } }) as Parameters<typeof requireIdentity>[0];

    expect(() => requireIdentity(session({}))).not.toThrow();
    expect(() => requireIdentity(session({ age: 21 }))).not.toThrow();
    expect(() => requireIdentity(session(false))).toThrow('identity verification is required');
  });
});

describe('manifestRoute', () => {
  beforeEach(() => {
    state.host = 'app.example';
  });

  it('serves an unsecured JWT bound to the request origin', async () => {
    const response = await manifestRoute(APP)();
    expect(response.headers.get('content-type')).toBe('application/jwt');

    const jwt = await response.text();
    expect(decodeJson(jwt, 0)).toEqual({
      alg: 'none',
      typ: 'bankroll-app-manifest+jwt',
    });
    // The origin it is served from is the proof, not a signature.
    expect(jwt.split('.')[2]).toBe('');

    expect(decodeManifest(jwt)).toMatchObject({
      aud: 'bankroll-app-host',
      launch: '/app',
      manifestVersion: 1,
      name: 'Acme',
      sub: 'https://app.example',
    });
  });

  it('follows the origin it is actually served from', async () => {
    state.host = 'brave-cat-42.trycloudflare.com';
    const manifest = decodeManifest(await (await manifestRoute(APP)()).text());
    expect(manifest.sub).toBe('https://brave-cat-42.trycloudflare.com');
  });

  // An app without a treasury advertises what it can actually honor.
  it('declares payments only once a treasury exists', async () => {
    const without = decodeManifest(await (await manifestRoute(APP)()).text());
    expect(without.capabilities).toEqual({ session: true });

    const withTreasury = decodeManifest(
      await (await manifestRoute({ ...APP, payments: () => 'Trea5ury' })()).text(),
    );
    expect(withTreasury.capabilities).toEqual({ payments: 'Trea5ury', session: true });
  });

  it('omits appTokens entirely when the app issues no token', async () => {
    expect(decodeManifest(await (await manifestRoute(APP)()).text())).not.toHaveProperty(
      'appTokens',
    );
  });

  it('declares push only once a push key exists', async () => {
    const without = decodeManifest(await (await manifestRoute(APP)()).text());
    expect(without.capabilities).not.toHaveProperty('push');

    const withKey = decodeManifest(
      await (await manifestRoute({ ...APP, push: () => 'Pu5hKey' })()).text(),
    );
    expect(withKey.capabilities).toEqual({ push: 'Pu5hKey', session: true });
  });

  // The signature covers exact bytes; the route may not touch them.
  it('serves a Bankroll-signed manifest verbatim', async () => {
    process.env.BANKROLL_SIGNED_MANIFEST = 'signed.head.body';
    try {
      const response = await manifestRoute(APP)();
      expect(await response.text()).toBe('signed.head.body');
      expect(response.headers.get('content-type')).toBe('application/jwt');
    } finally {
      delete process.env.BANKROLL_SIGNED_MANIFEST;
    }
  });

  // The manifest:sign fetch must see a claims change even while the previously
  // signed blob is still being served — otherwise a signed manifest could
  // never be updated.
  it('serves the built manifest to a ?signing=1 fetch despite a signed blob', async () => {
    process.env.BANKROLL_SIGNED_MANIFEST = 'signed.head.body';
    try {
      const request = new Request('https://app.example/.well-known/bankroll.jwt?signing=1');
      const manifest = decodeManifest(await (await manifestRoute(APP)(request)).text());
      expect(manifest.sub).toBe('https://app.example');
    } finally {
      delete process.env.BANKROLL_SIGNED_MANIFEST;
    }
  });

  it('omits supportUrl when the app declares none', async () => {
    expect(decodeManifest(await (await manifestRoute(APP)()).text())).not.toHaveProperty(
      'supportUrl',
    );
  });

  // Whatever the app declared, verbatim. The SDK does not police the scheme —
  // neither does the host, because which app answers for one is the platform's
  // decision.
  it.each([
    'https://help.acme.com/',
    'mailto:support@acme.com',
    'tel:+18005551234',
    'https://discord.gg/acme',
  ])('declares supportUrl %s untouched', async (supportUrl) => {
    const manifest = decodeManifest(
      await (await manifestRoute({ ...APP, supportUrl: () => supportUrl })()).text(),
    );
    expect(manifest.supportUrl).toBe(supportUrl);
  });

  // An empty claim is still a claim, and every claim is part of what a grant is
  // bound to — so sending one would re-ask every user the day it gained a value.
  it.each([null, '', '   '])('omits supportUrl rather than sending %p', async (value) => {
    expect(
      decodeManifest(await (await manifestRoute({ ...APP, supportUrl: () => value })()).text()),
    ).not.toHaveProperty('supportUrl');
  });

  it('trims a declared supportUrl', async () => {
    const manifest = decodeManifest(
      await (
        await manifestRoute({ ...APP, supportUrl: () => '  https://help.acme.com/  ' })()
      ).text(),
    );
    expect(manifest.supportUrl).toBe('https://help.acme.com/');
  });

  it('omits iconDigest when the app declares none', async () => {
    expect(decodeManifest(await (await manifestRoute(APP)()).text())).not.toHaveProperty(
      'iconDigest',
    );
  });

  it('declares iconDigest untouched', async () => {
    const digest = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
    const manifest = decodeManifest(
      await (await manifestRoute({ ...APP, iconDigest: () => digest })()).text(),
    );
    expect(manifest.iconDigest).toBe(digest);
  });

  // An icon claim with no icon behind it, or an empty one, would still be a
  // claim — omit it instead, exactly like supportUrl.
  it.each([null, '', '   '])('omits iconDigest rather than sending %p', async (value) => {
    expect(
      decodeManifest(await (await manifestRoute({ ...APP, iconDigest: () => value })()).text()),
    ).not.toHaveProperty('iconDigest');
  });

  it('declares a token with its display strings', async () => {
    const manifest = decodeManifest(
      await (
        await manifestRoute({
          ...APP,
          appTokens: () => ({ M1nt: { name: 'Acme Credit', description: 'Promo credit.' } }),
        })()
      ).text(),
    );
    expect(manifest.appTokens).toEqual({
      M1nt: { name: 'Acme Credit', description: 'Promo credit.' },
    });
  });

  // An app may issue several — the claim is a map, and the starter's single
  // env var could never express this.
  it('declares several tokens', async () => {
    const manifest = decodeManifest(
      await (
        await manifestRoute({
          ...APP,
          appTokens: () => ({ First: { name: 'One' }, Second: { name: 'Two' } }),
        })()
      ).text(),
    );
    expect(Object.keys(manifest.appTokens)).toEqual(['First', 'Second']);
  });

  it('omits display strings that were not given', async () => {
    const manifest = decodeManifest(
      await (await manifestRoute({ ...APP, appTokens: () => ({ M1nt: {} }) })()).text(),
    );
    expect(manifest.appTokens).toEqual({ M1nt: {} });
  });

  // An empty string is invalid to the host, and one bad entry takes the whole
  // manifest down — so drop the field rather than serve something refused.
  it('drops empty display strings rather than serving them', async () => {
    const manifest = decodeManifest(
      await (
        await manifestRoute({ ...APP, appTokens: () => ({ M1nt: { name: '', description: 'ok' } }) })()
      ).text(),
    );
    expect(manifest.appTokens.M1nt).toEqual({ description: 'ok' });
  });

  // Absent means only HSUSD may settle a charge, which is not the same as an
  // empty object.
  it('omits the claim entirely for an empty map', async () => {
    expect(
      decodeManifest(await (await manifestRoute({ ...APP, appTokens: () => ({}) })()).text()),
    ).not.toHaveProperty('appTokens');
  });

  // Re-read per request, so a token minted while the dev server is up shows up
  // without a restart.
  it('reads the app config on each request', async () => {
    let tokens: Record<string, { name?: string }> = {};
    const route = manifestRoute({ ...APP, appTokens: () => tokens });

    expect(decodeManifest(await (await route()).text())).not.toHaveProperty('appTokens');
    tokens = { M1nt: { name: 'Acme' } };
    expect(decodeManifest(await (await route()).text())).toHaveProperty('appTokens');
  });
});
