// Pure logic for the keyword-gap sweep's priority re-scan lane (see
// `keyword-store.ts` `getStaleKeywordsTiered`, called from `keyword-gaps.ts`
// `runKeywordSweep`). Two tiers share one sweep batch:
//
//   Tier 1 — "priority": manual/seed keywords, or keywords with an active
//   (non-dismissed) signature-hit watchlist entry, that haven't been scanned
//   in `TIER1_STALE_THRESHOLD_MS` (24h). These are the keywords an operator
//   actually cares about trending history for — a watchlist hit is worthless
//   if it only gets re-scanned once a week.
//
//   Tier 2 — "round robin": everything else, stalest-first, exactly the
//   pre-existing whole-corpus behavior (`getStaleKeywordsAcrossZones`).
//
// Why 24h: an operator watching a signature hit wants ~daily trend
// resolution — a scan cadence coarser than that can't distinguish "still
// heating" from "already cooled" until it's too late to act. Why cap tier 1
// at `TIER1_MAX_BATCH_FRACTION` (30%): even at the higher sweep throughput
// (`keywordsPerSweep`/`sweepDelayMs` — see `sweep-throttle.ts` for the full
// math, target ~2,250 scans/hour ≈ a ~2.1-day full round-robin over a
// ~114k-keyword corpus) — if tier 1 were allowed to fill an entire batch, a
// corpus with enough manual/seed/watchlisted keywords could starve tier 2
// indefinitely and the round-robin cycle would stall entirely, regardless of
// how fast the sweep runs overall.

/**
 * A keyword last scanned longer ago than this (or never scanned) is stale
 * enough to qualify for tier 1 — see module doc comment for the "~daily
 * trend resolution" rationale.
 */
export const TIER1_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on tier 1's share of a sweep batch, so it can never fully
 * starve tier 2's round-robin corpus cycle — see module doc comment.
 */
export const TIER1_MAX_BATCH_FRACTION = 0.3;

/** Corpus sources that unconditionally qualify a stale keyword for tier 1. */
export const TIER1_ELIGIBLE_SOURCES: ReadonlySet<string> = new Set(["manual", "seed"]);

export interface Tier1Input {
  /** Epoch seconds, or `null` if the keyword has never been scanned. */
  readonly lastScannedAt: number | null;
  readonly source: string;
  /** True iff the keyword has a row in `appstore_signature_hits` with `status != 'dismissed'`. */
  readonly hasActiveSignatureHit: boolean;
}

/**
 * True iff `input` qualifies for tier 1 of the current sweep: stale enough
 * (`TIER1_STALE_THRESHOLD_MS`) AND (manual/seed source OR an active
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

/**
 * Tier 1's share of a `batchLimit`-sized sweep batch, floored and clamped to
 * a non-negative integer — see `TIER1_MAX_BATCH_FRACTION`.
 */
export function computeTier1Cap(batchLimit: number): number {
  return Math.max(0, Math.floor(batchLimit * TIER1_MAX_BATCH_FRACTION));
}
