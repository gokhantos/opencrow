// Pure logic for the keyword-gap sweep's priority re-scan lane (see
// `keyword-store.ts` `getStaleKeywordsTiered`, called from `keyword-gaps.ts`
// `runKeywordSweep`). Three lanes share one sweep batch, in priority order:
//
//   Hot lane — open signature-hit watchlist entries (`appstore_signature_hits
//   .status IN ('new', 'active')`) that haven't been scanned in
//   `HOT_LANE_STALE_THRESHOLD_MS` (6h), capped at `HOT_LANE_MAX_BATCH`
//   (~50/sweep) and selected BEFORE tier 1 fills the rest of the batch
//   (2026-07-21 audit NOW-tier fix, item A). These are keywords an operator
//   is actively watching for a signal breaking one way or the other — they
//   deserve faster-than-tier-1 resolution, and the cap+priority-ordering
//   means they can never lose a slot to a merely-stale tier-1 keyword even
//   in a small batch.
//
//   Tier 1 — "priority, daily-guaranteed": ALL active seed/manual/
//   autocomplete keywords, or any keyword with a row in
//   `appstore_signature_hits` (any status), that haven't been scanned in
//   `tier1StaleThresholdMs` (config, default 12h — see
//   `appstoreKeywordGapConfigSchema` in `src/config/schema.ts`; this used to
//   be a hardcoded `TIER1_STALE_THRESHOLD_MS` constant here, lifted into
//   config as part of the 2026-07-21 audit's NOW-tier fixes). UNCAPPED as of
//   the 2026-07-21 scan-budget retune (previously capped at
//   `TIER1_MAX_BATCH_FRACTION` of the batch) — these are the keywords an
//   operator actually cares about, and the whole point of the retune is that
//   they get scanned EVERY day, not merely prioritized within a shrinking
//   slice. This is safe without an explicit cap because tier 1 is
//   self-limiting: once every eligible keyword has been scanned within the
//   threshold window, the staleness gate empties tier 1 out until something
//   goes stale again, so across a full day tier 1 can never consume more
//   than (tier-1 pool size) scans total — bounded by the corpus's own
//   seed/manual/autocomplete/signature-hit count, which is a small fraction
//   of the overall corpus by design (mined keywords are explicitly NOT
//   tier-1-eligible on their own).
//
//   Mined exploration — capped by BOTH its own rolling daily quota
//   (`minedExploration.dailyQuota` in config, tracked via
//   `keyword-store.ts`'s `countMinedScansSince`) AND a per-sweep cap
//   (`perSweepCap = ceil(dailyQuota * scanIntervalMs / 86_400_000)`,
//   computed by the caller — `keyword-gaps.ts`'s `runKeywordSweep` — and
//   passed in) so a single sweep can never greedily spend the WHOLE day's
//   mined quota in one cycle when tier 1/hot are light that cycle (2026-07-21
//   audit NOW-tier fix, item A: this greedy-fill was silently starving later
//   sweeps of the day of any mined slots at all). Drawn from `source:
//   'mined'` keywords, never-scanned first then oldest-scanned. Replaces the
//   old "tier 2 = everything else, stalest-first" round robin: once the
//   mined pool's own daily quota (or this sweep's slice of it) is spent,
//   `getStaleKeywordsTiered` returns only hot + tier 1 for the rest of the
//   cycle — freed sweep capacity is not silently reabsorbed into more mined
//   scans, it funds the DE storefront lane instead (see `scraper.ts`'s
//   `runDeStorefrontSweepIfDue`).
//
// Why ~daily for tier 1: an operator watching tier 1 (including a signature
// hit) wants ~daily trend resolution — a scan cadence coarser than that
// can't distinguish "still heating" from "already cooled" until it's too
// late to act. Why 6h for hot: an OPEN signature hit is actively being
// triaged — a 12h+ gap between reads risks missing the window entirely.

/**
 * A hot-lane keyword (open signature hit) last scanned longer ago than this
 * (or never scanned) is stale enough to qualify — see module doc comment.
 */
export const HOT_LANE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** Per-sweep cap on the hot lane — see module doc comment. */
export const HOT_LANE_MAX_BATCH = 50;

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
 * (`staleThresholdMs`, the caller's `tier1StaleThresholdMs` config value)
 * AND (an eligible source OR an active signature-hit watchlist entry). Pure
 * — `nowSeconds`/`staleThresholdMs` are injected rather than read from
 * `Date.now()`/config so this is deterministic and testable.
 */
export function isTier1Eligible(
  input: Tier1Input,
  nowSeconds: number,
  staleThresholdMs: number,
): boolean {
  const isStale =
    input.lastScannedAt === null || (nowSeconds - input.lastScannedAt) * 1000 >= staleThresholdMs;
  if (!isStale) return false;
  return TIER1_ELIGIBLE_SOURCES.has(input.source) || input.hasActiveSignatureHit;
}


/**
 * This sweep's slice of the mined-exploration daily quota — see module doc
 * comment, "Mined exploration". Spreads `dailyQuota` evenly across the
 * sweeps expected in a rolling 24h window (`86_400_000 / scanIntervalMs`),
 * rounding up so a slow-cadence config still gets at least 1 mined slot per
 * sweep when the quota is nonzero. Pure — both inputs are already-loaded
 * config values, no I/O.
 */
export function computePerSweepCap(dailyQuota: number, scanIntervalMs: number): number {
  return Math.ceil((dailyQuota * scanIntervalMs) / 86_400_000);
}

/**
 * How many mined-exploration keywords may fill this sweep's batch — the
 * tightest of three independent ceilings: what's left of the batch after
 * hot lane + tier 1, what's left of the rolling daily mined quota, and this
 * sweep's own `perSweepCap` slice of that quota (see `computePerSweepCap`).
 * Pure, never negative.
 */
export function computeMineSlots(
  remainingBatch: number,
  mineQuotaRemaining: number,
  perSweepCap: number,
): number {
  return Math.max(0, Math.min(remainingBatch, mineQuotaRemaining, perSweepCap));
}
