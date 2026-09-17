// The Bankroll app manifest's claims, as one pure function. `manifestRoute`
// in `@joinbankroll/sdk/next` serves them from a request; Bankroll's own
// tooling builds the same claims for an app before that app is deployed,
// so the shape lives here, once, with nothing framework-specific attached.

export interface AppToken {
  name?: string;
  description?: string;
}

export type AppTokens = Record<string, AppToken>;

export const MANIFEST_VERSION = 1;
export const MANIFEST_AUDIENCE = 'bankroll-app-host';
export const MANIFEST_TYP = 'bankroll-app-manifest+jwt';

export interface ManifestInput {
  /** The origin the manifest is served from; the host binds it by checking `sub`. */
  origin: string;
  /** The app's name, as Bankroll shows it when someone connects. */
  name: string;
  /** Where the host boots a connected app. */
  launch: string;
  /** The address charges settle to. Omitted while the app has none. */
  payments?: string | null | undefined;
  /** The app's signing public key, base58. Omitted while the app has none. */
  appKey?: string | null | undefined;
  /** Consent to push notifications: true, or a legacy push public key. */
  push?: boolean | string | null | undefined;
  supportUrl?: string | null | undefined;
  /** `sha256-<base64>` of the icon's exact bytes. Omitted when no icon is served. */
  iconDigest?: string | null | undefined;
  /** The tokens this app issues, keyed by mint address. */
  appTokens?: AppTokens | null | undefined;
}

export interface ManifestClaims {
  appKey?: string;
  appTokens?: AppTokens;
  aud: string;
  capabilities: { session: true; payments?: string; push?: true | string };
  iconDigest?: string;
  launch: string;
  manifestVersion: number;
  name: string;
  sub: string;
  supportUrl?: string;
}

/**
 * Drop entries the host would reject rather than serving a manifest it refuses
 * to parse — an empty string is invalid for either field, and one bad entry
 * takes the whole manifest down with it.
 */
function usableTokens(tokens: AppTokens): AppTokens {
  const usable: AppTokens = {};
  for (const [mint, token] of Object.entries(tokens)) {
    if (!mint) continue;
    usable[mint] = {
      ...(token?.name ? { name: token.name } : {}),
      ...(token?.description ? { description: token.description } : {}),
    };
  }
  return usable;
}

/**
 * The manifest's claims for an app. Every optional claim is omitted rather
 * than sent empty: an absent claim means something (no icon, only HSUSD
 * settles charges) that an empty one would not, and every claim is part of
 * what a user's grant is bound to.
 */
export function manifestClaims(input: ManifestInput): ManifestClaims {
  const appTokens = usableTokens(input.appTokens ?? {});
  const supportUrl = input.supportUrl?.trim();
  const iconDigest = input.iconDigest?.trim();
  return {
    ...(input.appKey ? { appKey: input.appKey } : {}),
    ...(Object.keys(appTokens).length > 0 ? { appTokens } : {}),
    aud: MANIFEST_AUDIENCE,
    capabilities: {
      session: true,
      ...(input.payments ? { payments: input.payments } : {}),
      // Declared unsigned too: the claim is what Bankroll signs, so it must
      // appear in the manifest that gets submitted for signing.
      ...(input.push ? { push: input.push } : {}),
    },
    ...(iconDigest ? { iconDigest } : {}),
    launch: input.launch,
    manifestVersion: MANIFEST_VERSION,
    name: input.name,
    sub: input.origin,
    ...(supportUrl ? { supportUrl } : {}),
  };
}
