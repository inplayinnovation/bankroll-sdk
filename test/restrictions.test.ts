// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MINIMUM_AGE,
  RESTRICTIONS_ENV,
  evaluateRestrictionPolicy,
  locationFromGeo,
  normalizeRegionCode,
  readRestrictionPolicy,
  restrictionFor,
  restrictionPolicyFromEnv,
  type RestrictionAge,
  type RestrictionPolicy,
} from '../src/restrictions';

const OPEN: RestrictionPolicy = { version: 1, geo: { countries: {}, default: 'allow' } };

// Two states off, everything else on.
const BLOCKS_TWO: RestrictionPolicy = {
  version: 1,
  geo: { countries: { US: { block: ['ME', 'NY'] } }, default: 'allow' },
};

// On only in listed US states and in Canada outside Quebec, with two states
// asking for more than 18.
const LISTED_AGE: RestrictionAge = { countries: { US: { regions: { TX: 21, CA: 19 } } } };
const LISTED: RestrictionPolicy = {
  version: 1,
  geo: {
    countries: {
      US: { default: 'block', allow: ['AK', 'CA', 'TX'] },
      CA: { default: 'allow', block: ['QC'] },
    },
    default: 'block',
  },
  age: LISTED_AGE,
};

const at = (countryCode: string | null, regionCode: string | null = null) => ({ countryCode, regionCode });

describe('readRestrictionPolicy', () => {
  it('is null for no document', () => {
    expect(readRestrictionPolicy(null)).toBeNull();
    expect(readRestrictionPolicy(undefined)).toBeNull();
  });

  it('puts codes, lists, and ages in canonical form', () => {
    expect(
      readRestrictionPolicy({
        version: 1,
        geo: {
          default: 'ALLOW',
          countries: {
            us: { default: 'Block', allow: ['tx', 'CA', 'US-CA'], block: ['ny'] },
            ca: { block: ['qc'] },
            fr: {},
          },
        },
        age: { countries: { us: { default: 21, regions: { ak: 19, 'US-TX': 21 } } }, default: 18 },
      }),
    ).toEqual({
      version: 1,
      geo: {
        countries: {
          CA: { block: ['QC'] },
          US: { default: 'block', allow: ['CA', 'TX'], block: ['NY'] },
        },
        default: 'allow',
      },
      age: { countries: { US: { default: 21, regions: { AK: 19, TX: 21 } } }, default: 18 },
    });
  });

  it('leaves the age section out when it says nothing', () => {
    expect(readRestrictionPolicy({ version: 1, geo: { countries: {}, default: 'block' }, age: { countries: {} } })).toEqual({
      version: 1,
      geo: { countries: {}, default: 'block' },
    });
  });

  it('accepts any well-formed region of any country', () => {
    expect(
      readRestrictionPolicy({
        version: 1,
        geo: { countries: { US: { block: ['PR', 'GU'] }, GB: { block: ['ENG'] }, FR: { allow: ['75'] } }, default: 'allow' },
      })?.geo.countries,
    ).toEqual({ FR: { allow: ['75'] }, GB: { block: ['ENG'] }, US: { block: ['GU', 'PR'] } });
  });

  it.each([
    [{ version: 2, geo: { countries: {}, default: 'allow' } }, 'version must be 1'],
    [{ version: 1, geo: { countries: {}, default: 'allow' }, extra: 1 }, 'Unexpected keys in restriction policy: extra'],
    [{ version: 1, geo: { countries: {} } }, 'geo.default must be allow or block'],
    [{ version: 1, geo: { countries: {}, default: 'maybe' } }, 'geo.default must be allow or block'],
    [{ version: 1, geo: { countries: { USA: {} }, default: 'allow' } }, 'invalid country code: USA'],
    [{ version: 1, geo: { countries: { US: { allow: ['CA-ON'] } }, default: 'allow' } }, 'invalid region code: CA-ON'],
    [{ version: 1, geo: { countries: { US: { allow: ['Maine'] } }, default: 'allow' } }, 'invalid region code: Maine'],
    [{ version: 1, geo: { countries: { US: { allow: 'CA' } }, default: 'allow' } }, 'must be an array of region codes'],
    [{ version: 1, geo: { countries: { US: { allow: ['CA'], block: ['CA'] } }, default: 'allow' } }, 'same region in allow and block: CA'],
    [{ version: 1, geo: { countries: { US: { regions: {} } }, default: 'allow' } }, 'Unexpected keys in restriction policy geo.countries.US: regions'],
    [{ version: 1, geo: { countries: {}, default: 'allow' }, age: { default: 0, countries: {} } }, 'whole number from 1 to 99'],
    [{ version: 1, geo: { countries: {}, default: 'allow' }, age: { countries: { US: { regions: { NE: '19' } } } } }, 'whole number from 1 to 99'],
    [{ version: 1, geo: { countries: {}, default: 'allow' }, age: { countries: { US: { regions: { NE: null } } } } }, 'must be a minimum age'],
    ['not a policy', 'must be an object'],
  ])('rejects a malformed document: %j', (raw, message) => {
    expect(() => readRestrictionPolicy(raw)).toThrow(message);
  });
});

describe('restrictionPolicyFromEnv', () => {
  it('is null when the setting is unset or blank', () => {
    expect(restrictionPolicyFromEnv({})).toBeNull();
    expect(restrictionPolicyFromEnv({ [RESTRICTIONS_ENV]: '  ' })).toBeNull();
  });

  it('reads the setting as a policy', () => {
    expect(restrictionPolicyFromEnv({ [RESTRICTIONS_ENV]: JSON.stringify(BLOCKS_TWO) })).toEqual(BLOCKS_TWO);
  });

  it('refuses a setting that is not JSON, by name', () => {
    expect(() => restrictionPolicyFromEnv({ [RESTRICTIONS_ENV]: 'US,US-ME' })).toThrow(RESTRICTIONS_ENV);
  });
});

describe('codes', () => {
  it('reads a geo claim as a location', () => {
    expect(locationFromGeo('US-ME')).toEqual(at('US', 'US-ME'));
    expect(locationFromGeo('us-me')).toEqual(at('US', 'US-ME'));
    expect(locationFromGeo('US')).toEqual(at('US'));
    expect(locationFromGeo('US-')).toEqual(at('US'));
    expect(locationFromGeo('')).toEqual(at(null));
    expect(locationFromGeo(undefined)).toEqual(at(null));
    expect(locationFromGeo('unknown')).toEqual(at(null));
  });

  it('accepts a region as a suffix or under its own country only', () => {
    expect(normalizeRegionCode('US', 'ca')).toBe('CA');
    expect(normalizeRegionCode('US', 'US-CA')).toBe('CA');
    expect(normalizeRegionCode('US', 'CA-ON')).toBeNull();
    expect(normalizeRegionCode('US', 'TEXAS')).toBeNull();
    expect(normalizeRegionCode(null, 'CA')).toBeNull();
  });
});

describe('evaluateRestrictionPolicy', () => {
  it('holds a policy with no age section to 18', () => {
    expect(evaluateRestrictionPolicy({ age: 18, location: at('US', 'US-CA'), policy: BLOCKS_TWO })).toEqual({
      reason: null,
      minimumAge: DEFAULT_MINIMUM_AGE,
    });
    expect(evaluateRestrictionPolicy({ age: 17, location: at('US', 'US-CA'), policy: BLOCKS_TWO })).toEqual({
      reason: 'age_under_minimum',
      minimumAge: DEFAULT_MINIMUM_AGE,
    });
  });

  it('honors an age the policy sets, above or below 18', () => {
    const policy: RestrictionPolicy = { ...OPEN, age: { countries: {}, default: 16 } };
    expect(evaluateRestrictionPolicy({ age: 16, location: at('FR'), policy })).toEqual({ reason: null, minimumAge: 16 });
    expect(evaluateRestrictionPolicy({ age: 15, location: at('FR'), policy })).toEqual({
      reason: 'age_under_minimum',
      minimumAge: 16,
    });
  });

  it('resolves the minimum by region, then country, then the policy default', () => {
    const policy: RestrictionPolicy = {
      ...OPEN,
      age: { countries: { US: { default: 21, regions: { AK: 19 } } }, default: 18 },
    };
    expect(evaluateRestrictionPolicy({ age: 20, location: at('US', 'US-AK'), policy })).toEqual({ reason: null, minimumAge: 19 });
    expect(evaluateRestrictionPolicy({ age: 20, location: at('US', 'US-TX'), policy })).toEqual({
      reason: 'age_under_minimum',
      minimumAge: 21,
    });
    expect(evaluateRestrictionPolicy({ age: 20, location: at('CA', 'CA-QC'), policy })).toEqual({ reason: null, minimumAge: 18 });
  });

  it('asks for the region only when a younger player could be under a regional minimum', () => {
    const policy: RestrictionPolicy = { ...OPEN, age: LISTED_AGE };
    // 30 clears Texas' 21, so the region does not matter.
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US'), policy })).toEqual({ reason: null, minimumAge: 21 });
    // 20 clears 18 and 19 but not 21: the region decides.
    expect(evaluateRestrictionPolicy({ age: 20, location: at('US'), policy })).toEqual({
      reason: 'location_unknown',
      minimumAge: null,
    });
    // No age at all: nothing to clear it with.
    expect(evaluateRestrictionPolicy({ age: null, location: at('US'), policy })).toEqual({
      reason: 'age_unknown',
      minimumAge: null,
    });
  });

  it('does the same for a missing country', () => {
    const policy: RestrictionPolicy = { ...OPEN, age: { countries: { US: { default: 21 }, CA: { regions: { QC: 19 } } } } };
    expect(evaluateRestrictionPolicy({ age: 21, location: at(null), policy })).toEqual({ reason: null, minimumAge: 21 });
    expect(evaluateRestrictionPolicy({ age: 20, location: at(null), policy })).toEqual({
      reason: 'location_unknown',
      minimumAge: null,
    });
    expect(evaluateRestrictionPolicy({ age: 20, location: at(null), policy: OPEN })).toEqual({
      reason: null,
      minimumAge: DEFAULT_MINIMUM_AGE,
    });
  });

  it('reports a missing age with the minimum it can still resolve', () => {
    expect(evaluateRestrictionPolicy({ age: null, location: at('US', 'US-TX'), policy: LISTED })).toEqual({
      reason: 'age_unknown',
      minimumAge: 21,
    });
    expect(evaluateRestrictionPolicy({ age: null, location: at('US', 'US-ME'), policy: BLOCKS_TWO })).toEqual({
      reason: 'age_unknown',
      minimumAge: DEFAULT_MINIMUM_AGE,
    });
  });

  it('blocks and allows by region under a country default', () => {
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US', 'US-ME'), policy: BLOCKS_TWO }).reason).toBe('location_blocked');
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US', 'US-CA'), policy: BLOCKS_TWO }).reason).toBeNull();
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US', 'US-AK'), policy: LISTED }).reason).toBeNull();
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US', 'US-NY'), policy: LISTED }).reason).toBe('location_blocked');
    expect(evaluateRestrictionPolicy({ age: 30, location: at('CA', 'CA-QC'), policy: LISTED }).reason).toBe('location_blocked');
    expect(evaluateRestrictionPolicy({ age: 30, location: at('CA', 'CA-BC'), policy: LISTED }).reason).toBeNull();
  });

  it('falls back to the country default, then the policy default', () => {
    const policy: RestrictionPolicy = { version: 1, geo: { countries: { US: { default: 'block' } }, default: 'allow' } };
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US', 'US-CA'), policy }).reason).toBe('location_blocked');
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US'), policy }).reason).toBe('location_blocked');
    expect(evaluateRestrictionPolicy({ age: 30, location: at('FR', 'FR-75'), policy }).reason).toBeNull();
    expect(evaluateRestrictionPolicy({ age: 30, location: at('FR'), policy: LISTED }).reason).toBe('location_blocked');
  });

  it('needs the region wherever the country has region rules', () => {
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US'), policy: BLOCKS_TWO })).toEqual({
      reason: 'location_unknown',
      minimumAge: DEFAULT_MINIMUM_AGE,
    });
    expect(evaluateRestrictionPolicy({ age: 30, location: at('CA'), policy: LISTED }).reason).toBe('location_unknown');
  });

  it('needs the country wherever the policy has country rules', () => {
    expect(evaluateRestrictionPolicy({ age: 30, location: at(null), policy: BLOCKS_TWO }).reason).toBe('location_unknown');
    expect(evaluateRestrictionPolicy({ age: 30, location: at(null), policy: OPEN }).reason).toBeNull();
    const closed: RestrictionPolicy = { version: 1, geo: { countries: {}, default: 'block' } };
    expect(evaluateRestrictionPolicy({ age: 30, location: at(null), policy: closed }).reason).toBe('location_blocked');
  });

  it('reports age before location', () => {
    expect(evaluateRestrictionPolicy({ age: 17, location: at('US', 'US-ME'), policy: BLOCKS_TWO }).reason).toBe('age_under_minimum');
    expect(evaluateRestrictionPolicy({ age: null, location: at('US', 'US-ME'), policy: BLOCKS_TWO }).reason).toBe('age_unknown');
  });

  it('normalizes the location it is given', () => {
    expect(evaluateRestrictionPolicy({ age: 30, location: at('us', 'me'), policy: BLOCKS_TWO }).reason).toBe('location_blocked');
    expect(evaluateRestrictionPolicy({ age: 30, location: at('US', 'CA-QC'), policy: BLOCKS_TWO }).reason).toBe('location_unknown');
  });
});

describe('restrictionFor', () => {
  const verified = (age?: number, geo?: string) => ({
    ...(geo === undefined ? {} : { geo }),
    user: { identity: age === undefined ? {} : { age } },
  });

  it('is no restriction without a policy', () => {
    expect(restrictionFor({ user: { identity: false } }, null)).toEqual({ reason: null, minimumAge: null });
  });

  it('takes the age from the identity and the location from the geo claim', () => {
    expect(restrictionFor(verified(30, 'US-ME'), BLOCKS_TWO).reason).toBe('location_blocked');
    expect(restrictionFor(verified(30, 'US-CA'), BLOCKS_TWO).reason).toBeNull();
    expect(restrictionFor(verified(20, 'US-TX'), LISTED)).toEqual({ reason: 'age_under_minimum', minimumAge: 21 });
    expect(restrictionFor(verified(30), BLOCKS_TWO).reason).toBe('location_unknown');
  });

  it('has no age for an unverified identity or one with no date of birth', () => {
    expect(restrictionFor({ geo: 'US-CA', user: { identity: false } }, BLOCKS_TWO).reason).toBe('age_unknown');
    expect(restrictionFor(verified(undefined, 'US-CA'), BLOCKS_TWO).reason).toBe('age_unknown');
  });
});
