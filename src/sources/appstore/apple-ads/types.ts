/**
 * Shared types for the Apple Ads (Search Ads Campaign Management API v5)
 * connection foundation.
 *
 * SCOPE: this is the credential + auth substrate plus an EXPERIMENTAL
 * searchPopularity probe. It does not blend into demand/opportunity/
 * buildability scoring — see apple-ads/client.ts probeSearchPopularity for
 * the "pending live validation" caveats.
 */

/** The five credentials needed to authenticate against the Apple Ads API. */
export interface AppleAdsCreds {
  readonly clientId: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly orgId: string;
  /** EC P-256 private key, PEM-encoded (PKCS8: "-----BEGIN PRIVATE KEY-----"). */
  readonly privateKey: string;
}

/** Result of a `testConnection` call. Never carries secret values. */
export interface AppleAdsConnectionStatus {
  readonly ok: boolean;
  readonly orgName?: string;
  readonly error?: string;
}

/**
 * Diagnostic result of the EXPERIMENTAL `probeSearchPopularity` call.
 * Intentionally carries the RAW (untransformed) rows Apple's Custom Reports
 * API returned, so we can inspect the real shape/coverage before designing
 * a store + scoring pipeline. `error` is set (and `state` reflects the
 * failure point) on any failure — this function never throws.
 */
export interface SearchPopularityProbeResult {
  readonly state: string;
  readonly reportId?: string;
  readonly rowCount: number;
  readonly sample: readonly unknown[];
  readonly error?: string;
}
