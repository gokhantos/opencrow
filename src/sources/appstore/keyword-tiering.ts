// Pure logic for the keyword-gap sweep's priority re-scan lane (see
// `keyword-store.ts` `getStaleKeywordsTiered`, called from `keyword-gaps.ts`
// `runKeywordSweep`). Two lanes share one sweep batch:
//
//   Tier 1 — "priority, daily-guaranteed": ALL active seed/manual/
//   autocomplete keywords, or any keyword with a row in
//   `appstore_signature_hits` (any status), that haven't been scanned in
//   `TIER1_STALE_THRESHOLD_MS` (24h). UNCAPPED as of the 2026-07-21
//   scan-budget retune (previously capped at `TIER1_MAX_BATCH_FRACTION` of
//   the batch) — these are the keywords an operator actually cares about,
//   and the whole point of the retune is that they get scanned EVERY day,
//   not merely prioritized within a shrinking slice. This is safe without an
//   explicit cap because tier 1 is self-limiting: once every eligible
//   keyword has been scanned within the last 24h, the staleness gate empties
//   tier 1 out until something goes stale again, so across a full day tier 1
//   can never consume more than (tier-1 pool size) scans total — bounded by
//   the corpus's own seed/manual/autocomplete/signature-hit count, which is
//   a small fraction of the overall corpus by design (mined keywords are
//   explicitly NOT tier-1-eligible on their own).
//
//   Mined exploration — a capped daily quota (`minedExploration.dailyQuota`
//   in config, tracked via `keyword-store.ts`'s `countMinedScansSince`) drawn
//   from `source: 'mined'` keywords, never-scanned first then oldest-scanned.
//   Replaces the old "tier 2 = everything else, stalest-first" round robin:
//   once the mined pool's own daily quota is spent, `getStaleKeywordsTiered`
//   returns ONLY tier 1 for the rest of the day — freed sweep capacity is not
//   silently reabsorbed into more mined scans, it funds the DE storefront
//   lane instead (see `scraper.ts`'s `runDeStorefrontSweepIfDue`).
//
// Why 24h: an operator watching tier 1 (including a signature hit) wants
// ~daily trend resolution — a scan cadence coarser than that can't
// distinguish "still heating" from "already cooled" until it's too late to
// act.

/**
 * A keyword last scanned longer ago than this (or never scanned) is stale
 * enough to qualify for tier 1 — see module doc comment for the "~daily
 * trend resolution" rationale.
 */
export const TIER1_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Corpus sources that unconditionally qualify a stale keyword for tier 1.
 * Widened 2026-07-21 (scan-budget retune) to include `autocomplete` — real,
 * popularity-ordered user search queries are exactly the corpus tier 1
 * exists to guarantee daily coverage for, same as seed/manual. `mined` is
 * deliberately excluded: it only reaches tier 1 via an active signature hit
 * (see `hasActiveSignatureHit` below), never by source alone.
 */
export const TIER1_ELIGIBLE_SOURCES: ReadonlySet<string> = new Set([
  "manual",
  "seed",
  "autocomplete",
]);

export interface Tier1Input {
  /** Epoch seconds, or `null` if the keyword has never been scanned. */
  readonly lastScannedAt: number | null;
  readonly source: string;
  /** True iff the keyword has a row in `appstore_signature_hits` with `status != 'dismissed'`. */
  readonly hasActiveSignatureHit: boolean;
}

/**
 * True iff `input` qualifies for tier 1 of the current sweep: stale enough
 * (`TIER1_STALE_THRESHOLD_MS`) AND (an eligible source OR an active
 * signature-hit watchlist entry). Pure — `nowSeconds` is injected rather
 * than read from `Date.now()` so this is deterministic and testable.
 */
export function isTier1Eligible(input: Tier1Input, nowSeconds: number): boolean {
  const isStale =
    input.lastScannedAt === null ||
    (nowSeconds - input.lastScannedAt) * 1000 >= TIER1_STALE_THRESHOLD_MS;
  if (!isStale) return false;
  return TIER1_ELIGIBLE_SOURCES.has(input.source) || input.hasActiveSignatureHit;
}
