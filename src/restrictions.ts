// Where, and from what age, an app may take real money. A restriction policy
// is one JSON document with two parts: `geo` says which countries and regions
// are open or blocked, and `age` says the minimum age by country and region.
// Bankroll sets one on a builder app's BANKROLL_RESTRICTIONS setting; a
// self-hosted app can carry its own. The app evaluates it
// on the server against the verified session before every paid action.
//
// No policy means no restriction. A policy that sets no age means 18. The
// location rules fail closed: a country with region rules needs the session's
// region, and without it paid play is off. The age rules ask for the region
// only when it could change the answer.

export const RESTRICTION_POLICY_VERSION = 1 as const;

/** The setting an app reads its policy from. */
export const RESTRICTIONS_ENV = 'BANKROLL_RESTRICTIONS';

/** The minimum age wherever a policy sets none. */
export const DEFAULT_MINIMUM_AGE = 18;

export type RestrictionAction = 'allow' | 'block';

export interface RestrictionGeoCountryRule {
  /** Regions open for paid play, as suffixes: "CA" under "US". */
  allow?: string[];
  /** Regions closed for paid play. A region is never in both lists. */
  block?: string[];
  /** The action for the country's other regions. Falls back to `geo.default`. */
  default?: RestrictionAction;
}

export interface RestrictionGeo {
  /** By ISO 3166-1 alpha-2 country code. */
  countries: Record<string, RestrictionGeoCountryRule>;
  /** The action anywhere no country rule speaks. */
  default: RestrictionAction;
}

export interface RestrictionAgeCountryRule {
  /** The minimum age in the country's other regions. */
  default?: number;
  /** Minimum ages by region suffix: { QC: 19 } under "CA". */
  regions?: Record<string, number>;
}

export interface RestrictionAge {
  countries: Record<string, RestrictionAgeCountryRule>;
  /** The minimum age anywhere no country rule speaks. 18 when absent. */
  default?: number;
}

export interface RestrictionPolicy {
  version: typeof RESTRICTION_POLICY_VERSION;
  geo: RestrictionGeo;
  age?: RestrictionAge;
}

/** Why a session may not play for money. */
export type RestrictionReason =
  /** The session carries no verified age. */
  | 'age_unknown'
  /** The player is younger than the minimum where they are. */
  | 'age_under_minimum'
  /** The policy needs a region the session did not resolve. */
  | 'location_unknown'
  /** The policy closes the player's location. */
  | 'location_blocked';

export interface Restriction {
  /** Null when paid play is allowed. */
  reason: RestrictionReason | null;
  /** The minimum age the player was held to, when the policy resolves one. */
  minimumAge: number | null;
}

export interface RestrictionLocation {
  countryCode: string | null;
  /** The full ISO 3166-2 code, e.g. "US-ME". */
  regionCode: string | null;
}

const ACTIONS = new Set<string>(['allow', 'block']);
const COUNTRY_CODE = /^[A-Z]{2}$/;
const REGION_SUFFIX = /^[A-Z0-9]{1,3}$/;
const REGION_WITH_COUNTRY = /^([A-Z]{2})-([A-Z0-9]{1,3})$/;
const MINIMUM_AGE_RANGE = { min: 1, max: 99 };

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

export function normalizeCountryCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return COUNTRY_CODE.test(normalized) ? normalized : null;
}

/**
 * The region suffix for a value written as "CA" or "US-CA" under the country.
 * Null when it is malformed or names another country. Codes are checked by
 * shape only, so every ISO 3166-2 region of every country is accepted.
 */
export function normalizeRegionCode(
  countryCode: string | null | undefined,
  value: string | null | undefined,
): string | null {
  const country = normalizeCountryCode(countryCode);
  if (!country || !value) return null;
  const normalized = value.trim().toUpperCase();
  const prefixed = normalized.match(REGION_WITH_COUNTRY);
  if (prefixed) return prefixed[1] === country ? (prefixed[2] ?? null) : null;
  return REGION_SUFFIX.test(normalized) ? normalized : null;
}

/** A session's `geo` claim ("US-ME" or "US") as a location. */
export function locationFromGeo(geo: string | null | undefined): RestrictionLocation {
  if (!geo) return { countryCode: null, regionCode: null };
  const [country, region] = geo.trim().toUpperCase().split('-', 2);
  const countryCode = normalizeCountryCode(country);
  if (!countryCode) return { countryCode: null, regionCode: null };
  const suffix = region === undefined ? null : normalizeRegionCode(countryCode, region);
  return { countryCode, regionCode: suffix ? `${countryCode}-${suffix}` : null };
}

// ---------------------------------------------------------------------------
// Reading a policy
// ---------------------------------------------------------------------------

/**
 * The policy in a stored document, checked and put in canonical form: codes
 * upper case, region lists sorted without duplicates, full ISO region codes
 * reduced to suffixes. Null for no document. Throws on anything malformed.
 */
export function readRestrictionPolicy(raw: unknown): RestrictionPolicy | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) throw new Error('Restriction policy must be an object');
  if (raw.version !== RESTRICTION_POLICY_VERSION) {
    throw new Error(`Restriction policy version must be ${RESTRICTION_POLICY_VERSION}`);
  }
  assertKeys(raw, ['age', 'geo', 'version'], 'restriction policy');
  const geo = readGeo(raw.geo);
  const age = readAge(raw.age);
  return { version: RESTRICTION_POLICY_VERSION, geo, ...(age ? { age } : {}) };
}

/** The policy in the BANKROLL_RESTRICTIONS setting, or null when it is unset. */
export function restrictionPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RestrictionPolicy | null {
  const value = env[RESTRICTIONS_ENV]?.trim();
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${RESTRICTIONS_ENV} must be a JSON restriction policy`);
  }
  return readRestrictionPolicy(parsed);
}

function readGeo(raw: unknown): RestrictionGeo {
  if (!isPlainObject(raw)) throw new Error('Restriction policy geo must be an object');
  assertKeys(raw, ['countries', 'default'], 'restriction policy geo');
  const countries: RestrictionGeo['countries'] = {};
  for (const [countryCode, rule] of readCountries(raw.countries, 'geo')) {
    const label = `geo.countries.${countryCode}`;
    if (!isPlainObject(rule)) throw new Error(`Restriction policy ${label} must be an object`);
    assertKeys(rule, ['allow', 'block', 'default'], `restriction policy ${label}`);
    const allow = readRegionList(countryCode, rule.allow, `${label}.allow`);
    const block = readRegionList(countryCode, rule.block, `${label}.block`);
    const overlap = allow.filter((region) => block.includes(region));
    if (overlap.length > 0) {
      throw new Error(
        `Restriction policy ${label} lists the same region in allow and block: ${overlap.join(', ')}`,
      );
    }
    const normalized: RestrictionGeoCountryRule = {};
    const action = readAction(rule.default, `${label}.default`);
    if (action) normalized.default = action;
    if (allow.length > 0) normalized.allow = allow;
    if (block.length > 0) normalized.block = block;
    if (Object.keys(normalized).length > 0) countries[countryCode] = normalized;
  }
  const action = readAction(raw.default, 'geo.default');
  if (!action) throw new Error('Restriction policy geo.default must be allow or block');
  return { countries, default: action };
}

function readAge(raw: unknown): RestrictionAge | undefined {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) throw new Error('Restriction policy age must be an object');
  assertKeys(raw, ['countries', 'default'], 'restriction policy age');
  const countries: RestrictionAge['countries'] = {};
  for (const [countryCode, rule] of readCountries(raw.countries, 'age')) {
    const label = `age.countries.${countryCode}`;
    if (!isPlainObject(rule)) throw new Error(`Restriction policy ${label} must be an object`);
    assertKeys(rule, ['default', 'regions'], `restriction policy ${label}`);
    const normalized: RestrictionAgeCountryRule = {};
    const minimum = readMinimumAge(rule.default, `${label}.default`);
    if (minimum !== undefined) normalized.default = minimum;
    const regions = readAgeRegions(countryCode, rule.regions, `${label}.regions`);
    if (Object.keys(regions).length > 0) normalized.regions = regions;
    if (Object.keys(normalized).length > 0) countries[countryCode] = normalized;
  }
  const minimum = readMinimumAge(raw.default, 'age.default');
  if (minimum === undefined && Object.keys(countries).length === 0) return undefined;
  return { countries, ...(minimum === undefined ? {} : { default: minimum }) };
}

function readCountries(raw: unknown, part: string): [string, unknown][] {
  if (raw == null) return [];
  if (!isPlainObject(raw)) throw new Error(`Restriction policy ${part}.countries must be an object`);
  return Object.keys(raw)
    .sort()
    .map((key) => {
      const countryCode = normalizeCountryCode(key);
      if (!countryCode) {
        throw new Error(`Restriction policy ${part}.countries has an invalid country code: ${key}`);
      }
      return [countryCode, raw[key]];
    });
}

function readRegionList(countryCode: string, raw: unknown, label: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`Restriction policy ${label} must be an array of region codes`);
  const regions = new Set<string>();
  for (const value of raw) {
    const region = typeof value === 'string' ? normalizeRegionCode(countryCode, value) : null;
    if (!region) throw new Error(`Restriction policy ${label} has an invalid region code: ${String(value)}`);
    regions.add(region);
  }
  return [...regions].sort();
}

function readAgeRegions(countryCode: string, raw: unknown, label: string): Record<string, number> {
  if (raw == null) return {};
  if (!isPlainObject(raw)) throw new Error(`Restriction policy ${label} must be an object`);
  const regions: Record<string, number> = {};
  for (const key of Object.keys(raw).sort()) {
    const region = normalizeRegionCode(countryCode, key);
    if (!region) throw new Error(`Restriction policy ${label} has an invalid region code: ${key}`);
    const minimum = readMinimumAge(raw[key], `${label}.${region}`);
    if (minimum === undefined) throw new Error(`Restriction policy ${label}.${region} must be a minimum age`);
    regions[region] = minimum;
  }
  return regions;
}

function readAction(value: unknown, label: string): RestrictionAction | undefined {
  if (value == null) return undefined;
  const action = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ACTIONS.has(action)) throw new Error(`Restriction policy ${label} must be allow or block`);
  return action as RestrictionAction;
}

function readMinimumAge(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MINIMUM_AGE_RANGE.min ||
    value > MINIMUM_AGE_RANGE.max
  ) {
    throw new Error(
      `Restriction policy ${label} must be a whole number from ${MINIMUM_AGE_RANGE.min} to ${MINIMUM_AGE_RANGE.max}`,
    );
  }
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected keys in ${label}: ${unexpected.sort().join(', ')}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Evaluating a policy
// ---------------------------------------------------------------------------

/**
 * Whether a player of `age` at `location` may play for money under `policy`.
 * The age rules come first, then the location rules. A missing country or
 * region is "location unknown" when a rule needs it: always for the location
 * rules, and for the age rules only when the player is younger than the
 * highest minimum the missing part could select.
 */
export function evaluateRestrictionPolicy(input: {
  age: number | null;
  location: RestrictionLocation;
  policy: RestrictionPolicy;
}): Restriction {
  const { age, policy } = input;
  const location = normalizeLocation(input.location);
  const minimum = resolveMinimumAge(policy, location, age);

  if (age === null) return { reason: 'age_unknown', minimumAge: minimum.age };
  if (minimum.locationUnknown) return { reason: 'location_unknown', minimumAge: null };
  if (minimum.age !== null && age < minimum.age) {
    return { reason: 'age_under_minimum', minimumAge: minimum.age };
  }

  const geo = resolveGeo(policy, location);
  if (geo.locationUnknown) return { reason: 'location_unknown', minimumAge: minimum.age };
  return { reason: geo.blocked ? 'location_blocked' : null, minimumAge: minimum.age };
}

/**
 * The restriction on a verified session: its `geo` claim is the location and
 * its identity's `age` is the age. No policy means no restriction; whether the
 * player has verified at all is a separate gate.
 */
export function restrictionFor(
  session: { geo?: string; user: { identity: { age?: number } | false } },
  policy: RestrictionPolicy | null,
): Restriction {
  if (!policy) return { reason: null, minimumAge: null };
  const identity = session.user.identity;
  const age = identity && typeof identity.age === 'number' ? identity.age : null;
  return evaluateRestrictionPolicy({ age, location: locationFromGeo(session.geo), policy });
}

function normalizeLocation(location: RestrictionLocation): RestrictionLocation {
  const countryCode = normalizeCountryCode(location.countryCode);
  if (!countryCode) return { countryCode: null, regionCode: null };
  const suffix = normalizeRegionCode(countryCode, location.regionCode);
  return { countryCode, regionCode: suffix ? `${countryCode}-${suffix}` : null };
}

// The minimum age the player is held to. When the location is missing a part
// the age rules use, the player is held to the highest minimum that part
// could select: a player who clears it clears every one, so the missing part
// cannot change the answer. A younger player, or one with no age, needs it.
function resolveMinimumAge(
  policy: RestrictionPolicy,
  location: RestrictionLocation,
  age: number | null,
): { age: number | null; locationUnknown: boolean } {
  const rules = policy.age;
  const fallback = rules?.default ?? DEFAULT_MINIMUM_AGE;
  const { countryCode, regionCode } = location;
  const highest = (candidates: number[]) => Math.max(fallback, ...candidates);
  const decide = (candidates: number[]) => {
    const minimum = highest(candidates);
    if (age !== null && age >= minimum) return { age: minimum, locationUnknown: false };
    return { age: null, locationUnknown: true };
  };

  if (!countryCode) {
    const countries = Object.values(rules?.countries ?? {});
    if (countries.length === 0) return { age: fallback, locationUnknown: false };
    return decide(
      countries.flatMap((country) => [
        ...(country.default === undefined ? [] : [country.default]),
        ...Object.values(country.regions ?? {}),
      ]),
    );
  }
  const country = rules?.countries[countryCode];
  const countryDefault = country?.default ?? fallback;
  const regions = country?.regions ?? {};
  const suffix = regionCode ? regionCode.slice(countryCode.length + 1) : null;
  if (suffix) return { age: regions[suffix] ?? countryDefault, locationUnknown: false };
  if (Object.keys(regions).length === 0) return { age: countryDefault, locationUnknown: false };
  return decide([countryDefault, ...Object.values(regions)]);
}

function resolveGeo(
  policy: RestrictionPolicy,
  location: RestrictionLocation,
): { blocked: boolean; locationUnknown: boolean } {
  const { geo } = policy;
  const { countryCode, regionCode } = location;
  if (!countryCode) {
    if (Object.keys(geo.countries).length > 0) return { blocked: false, locationUnknown: true };
    return { blocked: geo.default === 'block', locationUnknown: false };
  }
  const country = geo.countries[countryCode];
  const allow = country?.allow ?? [];
  const block = country?.block ?? [];
  if ((allow.length > 0 || block.length > 0) && !regionCode) {
    return { blocked: false, locationUnknown: true };
  }
  const suffix = regionCode ? regionCode.slice(countryCode.length + 1) : null;
  if (suffix && allow.includes(suffix)) return { blocked: false, locationUnknown: false };
  if (suffix && block.includes(suffix)) return { blocked: true, locationUnknown: false };
  return { blocked: (country?.default ?? geo.default) === 'block', locationUnknown: false };
}
