// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BANKROLL_TOKEN_HEADER } from '../src/constants';
import {
  Unauthorized,
  getOrigin,
  getSession,
  manifestRoute,
  publicOrigin,
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

const decodeManifest = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

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
    await expect(getOrigin()).rejects.toThrow('requires a request');
  });
});

describe('publicOrigin', () => {
  beforeEach(() => {
    state.host = 'localhost:3000';
    delete process.env.BANKROLL_DEV_TUNNEL_ORIGIN;
  });

  it('falls back to the request origin', async () => {
    await expect(publicOrigin()).resolves.toBe('http://localhost:3000');
  });

  it('prefers the dev tunnel, which is what a phone can reach', async () => {
    process.env.BANKROLL_DEV_TUNNEL_ORIGIN = 'https://brave-cat-42.trycloudflare.com';
    await expect(publicOrigin()).resolves.toBe('https://brave-cat-42.trycloudflare.com');
    delete process.env.BANKROLL_DEV_TUNNEL_ORIGIN;
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
    const [header, , signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'none',
      typ: 'bankroll-app-manifest+jwt',
    });
    // The origin it is served from is the proof, not a signature.
    expect(signature).toBe('');

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

  it('declares an app token, defaulting its name', async () => {
    const manifest = decodeManifest(
      await (await manifestRoute({ ...APP, tokenMint: () => 'M1nt' })()).text(),
    );
    expect(manifest.appTokens).toEqual({
      M1nt: { description: 'Funds for Acme', name: 'Acme Tokens' },
    });
  });

  it('uses a configured token name', async () => {
    const manifest = decodeManifest(
      await (
        await manifestRoute({ ...APP, tokenMint: () => 'M1nt', tokenName: () => 'Acme Credit' })()
      ).text(),
    );
    expect(manifest.appTokens.M1nt.name).toBe('Acme Credit');
  });

  // Re-read per request, so a token minted while the dev server is up shows up
  // without a restart.
  it('reads the app config on each request', async () => {
    let mint: string | null = null;
    const route = manifestRoute({ ...APP, tokenMint: () => mint });

    expect(decodeManifest(await (await route()).text())).not.toHaveProperty('appTokens');
    mint = 'M1nt';
    expect(decodeManifest(await (await route()).text())).toHaveProperty('appTokens');
  });
});
