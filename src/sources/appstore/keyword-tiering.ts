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
//   their OWN EFFECTIVE staleness threshold (config base
//   `tier1StaleThresholdMs`, default 6h — see `appstoreKeywordGapConfigSchema`
//   in `src/config/schema.ts`; this used to be a hardcoded
//   `TIER1_STALE_THRESHOLD_MS` constant here, lifted into config as part of
//   the 2026-07-21 audit's NOW-tier fixes). UNCAPPED as of the 2026-07-21
//   scan-budget retune (previously capped at `TIER1_MAX_BATCH_FRACTION` of
//   the batch) — these are the keywords an operator actually cares about,
//   and the whole point of the retune is that they get scanned EVERY day,
//   not merely prioritized within a shrinking slice. This is safe without an
//   explicit cap because tier 1 is self-limiting: once every eligible
//   keyword has been scanned within its own threshold window, the staleness
//   gate empties tier 1 out until something goes stale again, so across a
//   full day tier 1 can never consume more than (tier-1 pool size) scans
//   total — bounded by the corpus's own seed/manual/autocomplete/
//   signature-hit count, which is a small fraction of the overall corpus by
//   design (mined keywords are explicitly NOT tier-1-eligible on their own).
//
//   PROMISE-TIERED CADENCE (Batch A budget rescue, 2026-07-22): "self-
//   limiting" above assumed every tier-1 keyword deserved the SAME cadence —
//   live measurement on 2026-07-21/22 found the tier-1 pool had grown to
//   ~4,175 keywords (83% autocomplete), with 89% sitting at opportunity <
//   0.1 (i.e. proven, repeatedly, to be dead brand/navigational terms), yet
//   still consuming the SAME `tier1StaleThresholdMs` cadence as the rare
//   real opportunity. `computeEffectiveStaleThreshold` bands each keyword's
//   OWN threshold by its own recent opportunity: high-opportunity keywords
//   keep the fast base cadence, low-opportunity ones back off (2x, then 8x
//   once repeatedly proven dead), and a never-scanned keyword stays
//   immediately eligible (exploration). This SQL-mirrors into
//   `keyword-store.ts`'s `getStaleKeywordsTiered` (same convention as
//   `isTier1Eligible` below — a pure, unit-tested TS function documenting
//   the intended semantics, hand-mirrored as a CASE expression in SQL, since
//   SQL cannot call back into TS at query time).
//
//   Mined exploration — fills whatever's left of the batch after hot + tier
//   1, capped by its own rolling daily quota (`minedExploration.dailyQuota`
//   in config, tracked via `keyword-store.ts`'s `countMinedScansSince`) and
//   by `perSweepCap`, a caller-supplied ceiling (see `computeMineSlots`
//   below). Drawn from `source: 'mined'` keywords, never-scanned first then
//   oldest-scanned — see `getStaleKeywordsTiered`'s `ORDER BY
//   last_scanned_at ASC NULLS FIRST`.
//
//   CONTINUOUS FETCH (2026-07-23): from 2026-07-21 to 2026-07-22 this cap was
//   deliberately paced — `perSweepCap = ceil(dailyQuota * scanIntervalMs /
//   86_400_000)`, spreading `dailyQuota` evenly across the sweeps a nominal
//   cadence implies — so a light hot+tier1 cycle couldn't greedily spend the
//   whole day's mined quota in one sweep. Live measurement found that pacing
//   was itself the mechanism producing IDLE sweeps: with a mined backlog
//   (never-scanned keywords, ~120k of them) that vastly exceeds any single
//   sweep's batch, the paced cap (~70/sweep at the time) left most of every
//   600-keyword batch (`keywordsPerSweep`) unfilled once hot+tier1 ran out,
//   so the process sat idle between sweeps instead of continuously fetching.
//   `keyword-gaps.ts`'s `runKeywordSweep` now passes `perSweepCap =
//   opts.limit` (this cycle's own, already throttle-adjusted batch size) —
//   i.e. no additional pacing beyond the batch itself, so mined exploration
//   fills the ENTIRE remaining batch every cycle whenever the backlog
//   supports it. The real regulators are no longer the per-sweep pacing
//   formula but (a) `dailyKeywordBudget`, the rolling-24h whole-corpus
//   ceiling checked in `runKeywordSweep` before any lane runs, (b)
//   `mineQuotaRemaining`, mined's own rolling-24h quota, and (c) the adaptive
//   `sweepThrottleState` (`sweep-throttle.ts`) upstream, which shrinks
//   `opts.limit` itself (and therefore this ceiling too) once Apple starts
//   429ing. `computeMineSlots` keeps its general 3-ceiling shape so a caller
//   can still supply a tighter `perSweepCap` if per-sweep pacing is ever
//   wanted again — production just no longer derives one from the daily
//   quota.
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
 * exists to guarantee daily coverage for, same as seed/manual. `mined` (and,
 * as of Batch C4, `review` — see keyword-review-miner.ts, which shares the
 * mined pool's exploration quota) is deliberately excluded: it only reaches
 * tier 1 via an active signature hit (see `hasActiveSignatureHit` below),
 * never by source alone.
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
 * How many mined-exploration keywords may fill this sweep's batch — the
 * tightest of three independent ceilings: what's left of the batch after
 * hot lane + tier 1 (`remainingBatch`), what's left of the rolling daily
 * mined quota (`mineQuotaRemaining`), and a caller-supplied `perSweepCap`.
 * Pure, never negative.
 *
 * CONTINUOUS FETCH (2026-07-23): `perSweepCap` no longer means "this sweep's
 * paced slice of the daily quota" (see module doc comment, "Mined
 * exploration") — `keyword-gaps.ts`'s `runKeywordSweep` now passes this
 * cycle's own batch limit, which is always `>= remainingBatch`, so in
 * practice this third ceiling never binds; `remainingBatch` and
 * `mineQuotaRemaining` are the two ceilings that actually govern the fill.
 * The parameter stays generic (rather than being dropped) so a caller can
 * still supply a tighter value if per-sweep pacing is ever needed again.
 */
export function computeMineSlots(
  remainingBatch: number,
  mineQuotaRemaining: number,
  perSweepCap: number,
): number {
  return Math.max(0, Math.min(remainingBatch, mineQuotaRemaining, perSweepCap));
}

// ---------------------------------------------------------------------------
// Promise-tiered rescan cadence (Batch A budget rescue, 2026-07-22) — see
// module doc comment above. Bands a tier-1 keyword's effective staleness
// threshold by its own recent opportunity, instead of one flat
// `tier1StaleThresholdMs` for the whole pool.
// ---------------------------------------------------------------------------

/** Opportunity at/above this keeps the FAST (base) band. */
export const TIER1_HIGH_OPPORTUNITY = 0.4;

/** Opportunity at/above this (but below `TIER1_HIGH_OPPORTUNITY`) gets the MID band (2x base). */
export const TIER1_MID_OPPORTUNITY = 0.1;

/** Multiplier applied to `baseMs` for the MID opportunity band. */
export const TIER1_MID_MULTIPLIER = 2;

/** Multiplier applied to `baseMs` for the SLOW (proven-dead) opportunity band — ~2 days at the 6h config default. */
export const TIER1_SLOW_MULTIPLIER = 8;

/** A keyword needs at least this many scans before it can be demoted to the SLOW band — one weak reading is not enough evidence. */
export const TIER1_SLOW_BAND_MIN_SCANS = 2;

/**
 * A tier-1 keyword's effective staleness threshold (ms), banded by its own
 * recent `opportunity` and `scanCount` against `baseMs`
 * (`appstoreKeywordGap.tier1StaleThresholdMs`, the fast/base cadence):
 *
 *   - never scanned (`scanCount === 0`) -> `0` (immediately eligible —
 *     exploration; the caller's own `last_scanned_at IS NULL` staleness
 *     check already treats a never-scanned keyword as due regardless, so
 *     this only matters for callers that read the threshold value itself).
 *   - `opportunity >= TIER1_HIGH_OPPORTUNITY` -> `baseMs` (fast band,
 *     regardless of scan count — a keyword that's ALREADY proven itself
 *     doesn't need extra scans to earn the fast cadence).
 *   - `opportunity >= TIER1_MID_OPPORTUNITY` -> `baseMs * TIER1_MID_MULTIPLIER`
 *     (mid band).
 *   - `opportunity < TIER1_MID_OPPORTUNITY` AND `scanCount >= TIER1_SLOW_BAND_MIN_SCANS`
 *     -> `baseMs * TIER1_SLOW_MULTIPLIER` (slow band — repeatedly proven
 *     weak, most of the tier-1 pool in practice; see module doc comment).
 *   - `opportunity < TIER1_MID_OPPORTUNITY` but `scanCount < TIER1_SLOW_BAND_MIN_SCANS`
 *     -> `baseMs * TIER1_MID_MULTIPLIER` (grace band — one weak reading
 *     alone is not enough evidence to demote all the way to slow).
 *
 * Pure — no I/O, no Date. Callers apply two further adjustments this
 * function does NOT know about on its own (see `keyword-store.ts`'s
 * `getStaleKeywordsTiered` SQL, which hand-mirrors both): (a) a keyword with
 * an active `appstore_signature_hits` row keeps the fast band regardless of
 * opportunity, and (b) when the latest scan is `low_confidence`, the caller
 * passes the RECENT-MAX opportunity instead of the latest reading, so one
 * degraded read can't demote a real opportunity.
 */
export function computeEffectiveStaleThreshold(
  opportunity: number,
  scanCount: number,
  baseMs: number,
): number {
  if (scanCount === 0) return 0;
  if (opportunity >= TIER1_HIGH_OPPORTUNITY) return baseMs;
  if (opportunity >= TIER1_MID_OPPORTUNITY) return baseMs * TIER1_MID_MULTIPLIER;
  if (scanCount >= TIER1_SLOW_BAND_MIN_SCANS) return baseMs * TIER1_SLOW_MULTIPLIER;
  return baseMs * TIER1_MID_MULTIPLIER;
}
