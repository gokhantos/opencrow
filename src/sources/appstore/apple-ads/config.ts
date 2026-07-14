/**
 * config.ts — credential + activation-flag reads for the Apple Ads
 * connection foundation.
 *
 * Credentials live in the DB secrets namespace (via getSecret(), which also
 * falls back to process.env — see src/config/secrets.ts) under five keys:
 * APPLE_ADS_CLIENT_ID, APPLE_ADS_TEAM_ID, APPLE_ADS_KEY_ID, APPLE_ADS_ORG_ID,
 * APPLE_ADS_PRIVATE_KEY. getAppleAdsCredentials() returns null unless ALL
 * five are present, so the feature is fully inert (no network calls, no
 * partial/garbage credential objects) until an operator configures it.
 */

import { getSecret } from "../../../config/secrets";
import { loadConfig } from "../../../config/loader";
import type { AppleAdsCreds } from "./types";

const SECRET_KEYS = {
  clientId: "APPLE_ADS_CLIENT_ID",
  teamId: "APPLE_ADS_TEAM_ID",
  keyId: "APPLE_ADS_KEY_ID",
  orgId: "APPLE_ADS_ORG_ID",
  privateKey: "APPLE_ADS_PRIVATE_KEY",
} as const;

/** Injectable secret reader so tests never touch the DB/env. */
export type SecretReader = (key: string) => Promise<string | undefined>;

/**
 * Read all five Apple Ads credentials. Returns null if ANY is missing —
 * callers must treat null as "feature not configured" and no-op, never throw.
 */
export async function getAppleAdsCredentials(
  readSecret: SecretReader = getSecret,
): Promise<AppleAdsCreds | null> {
  const [clientId, teamId, keyId, orgId, privateKey] = await Promise.all([
    readSecret(SECRET_KEYS.clientId),
    readSecret(SECRET_KEYS.teamId),
    readSecret(SECRET_KEYS.keyId),
    readSecret(SECRET_KEYS.orgId),
    readSecret(SECRET_KEYS.privateKey),
  ]);

  if (!clientId || !teamId || !keyId || !orgId || !privateKey) {
    return null;
  }

  return { clientId, teamId, keyId, orgId, privateKey };
}

/**
 * Whether the (not-yet-built) automated external-demand pipeline is allowed
 * to activate. Default false. This does NOT gate the manual test/probe
 * routes — see appstoreExternalDemandConfigSchema in src/config/schema.ts
 * for why.
 */
export function isExternalDemandEnabled(): boolean {
  return loadConfig().appstoreExternalDemand.enabled;
}

/** Per-key presence booleans, for a status endpoint. Never returns values. */
export interface AppleAdsCredentialStatus {
  readonly clientIdSet: boolean;
  readonly teamIdSet: boolean;
  readonly keyIdSet: boolean;
  readonly orgIdSet: boolean;
  readonly privateKeySet: boolean;
  readonly configured: boolean;
}

/**
 * Read presence (not value) of each of the 5 Apple Ads secrets, so a status
 * UI can show which specific field is still missing without ever exposing
 * the value — the private key in particular is write-only by design.
 */
export async function getAppleAdsCredentialStatus(
  readSecret: SecretReader = getSecret,
): Promise<AppleAdsCredentialStatus> {
  const isSet = async (key: string): Promise<boolean> => {
    const value = await readSecret(key);
    return typeof value === "string" && value.length > 0;
  };

  const [clientIdSet, teamIdSet, keyIdSet, orgIdSet, privateKeySet] = await Promise.all([
    isSet(SECRET_KEYS.clientId),
    isSet(SECRET_KEYS.teamId),
    isSet(SECRET_KEYS.keyId),
    isSet(SECRET_KEYS.orgId),
    isSet(SECRET_KEYS.privateKey),
  ]);

  return {
    clientIdSet,
    teamIdSet,
    keyIdSet,
    orgIdSet,
    privateKeySet,
    configured: clientIdSet && teamIdSet && keyIdSet && orgIdSet && privateKeySet,
  };
}

export { SECRET_KEYS as APPLE_ADS_SECRET_KEYS };
