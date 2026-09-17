import { describe, expect, it } from 'vitest';

import { MANIFEST_AUDIENCE, MANIFEST_VERSION, manifestClaims } from '../src/manifest';

const BASE = { origin: 'https://app.example', name: 'Acme', launch: '/app' };

describe('manifestClaims', () => {
  it('builds the minimal manifest with every optional claim omitted', () => {
    expect(manifestClaims(BASE)).toEqual({
      aud: MANIFEST_AUDIENCE,
      capabilities: { session: true },
      launch: '/app',
      manifestVersion: MANIFEST_VERSION,
      name: 'Acme',
      sub: 'https://app.example',
    });
  });

  it('keeps the claim order the route has always served, so signed bytes do not move', () => {
    const claims = manifestClaims({
      ...BASE,
      payments: 'Treasury111',
      appKey: 'AppKey111',
      push: true,
      supportUrl: ' https://help.example ',
      iconDigest: ' sha256-abc ',
      appTokens: { Mint111: { name: 'Coin', description: '' }, '': { name: 'dropped' } },
    });
    expect(Object.keys(claims)).toEqual([
      'appKey',
      'appTokens',
      'aud',
      'capabilities',
      'iconDigest',
      'launch',
      'manifestVersion',
      'name',
      'sub',
      'supportUrl',
    ]);
    expect(claims.capabilities).toEqual({ session: true, payments: 'Treasury111', push: true });
    expect(claims.appTokens).toEqual({ Mint111: { name: 'Coin' } });
    expect(claims.supportUrl).toBe('https://help.example');
    expect(claims.iconDigest).toBe('sha256-abc');
  });

  it.each([null, undefined, '', '   '])('omits supportUrl and iconDigest for %s', (value) => {
    const claims = manifestClaims({ ...BASE, supportUrl: value, iconDigest: value });
    expect(claims).not.toHaveProperty('supportUrl');
    expect(claims).not.toHaveProperty('iconDigest');
  });

  it('omits appTokens for an empty or all-invalid map', () => {
    expect(manifestClaims({ ...BASE, appTokens: {} })).not.toHaveProperty('appTokens');
    expect(manifestClaims({ ...BASE, appTokens: { '': {} } })).not.toHaveProperty('appTokens');
  });
});
