import { getDb } from "../../store/db";
import { JUNK_KEYWORDS } from "./keyword-junk";
import {
  computeMineSlots,
  HOT_LANE_MAX_BATCH,
  HOT_LANE_STALE_THRESHOLD_MS,
} from "./keyword-tiering";
import { DEACTIVATION_MIN_SCANS, MINED_DEACTIVATION_MAX_DEMAND_EVER } from "./keyword-deactivation";
import type { ClusterAssignmentRow, RawCandidate } from "./keyword-clustering";
import { computeBuildability } from "./keyword-scoring";
import type { GapTrend, KeywordGapProfile, TopApp } from "./keyword-types";

/**
 * Bun's SQL driver returns `jsonb` columns as raw JSON strings, not parsed
 * values. Mirrors `parseJson` in `src/pipelines/store.ts`: if already parsed
 * (array/object), use as-is; if a string, parse it; on failure, fall back
 * defensively rather than throwing.
 */
function parseJson<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

export interface KeywordSeedRow {
  readonly keyword: string;
  readonly genreZone: string;
  // "autocomplete" is the PRIMARY corpus-discovery source (restored
  // 2026-07-21 — see keyword-autocomplete.ts): real, popularity-ordered user
  // search queries pulled from Apple's MZSearchHints search-suggest
  // endpoint. It was briefly believed retired (the endpoint appeared to just
  // echo the query back) but that was a missing-header misdiagnosis — the
  // endpoint requires `X-Apple-Store-Front`, which Apple made mandatory at
  // some point; with it, real suggestions come back. "mined" is the
  // SECONDARY corpus-discovery source: candidates extracted from scraped
  // App Store ranking data (see keyword-miner.ts) — still useful for
  // brand-new apps autocomplete hasn't indexed yet, but demoted to a small
  // top-up now that autocomplete works.
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | "mined";
}

export interface KeywordScanRow {
  readonly id: number;
  readonly keyword: string;
  readonly store: "app" | "play" | "DE";
  readonly scannedAt: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly opportunity: number;
  readonly trend: GapTrend;
  readonly topAppReviews: number;
  readonly avgRating: number;
  readonly avgAgeDays: number;
  readonly topApps: readonly TopApp[];
  /**
   * Solo-indie "can I win this?" score, 0..100 — see `computeBuildability`
   * (`keyword-scoring.ts`). Read-time, deterministic from `demand` /
   * `topAppReviews` / `avgRating` (no stored column, no scan-time change).
   * `getTopOpportunities` computes this via the mirrored `BUILDABILITY_SQL`
   * expression; callers reading a plain `appstore_keyword_scans` row (no
   * `buildability` column in the raw SELECT, e.g. `getLatestScan` /
   * `getScanHistory`) get it computed in TS by `rowToScan` instead — same
   * formula either way.
   */
  readonly buildability: number;
  /**
   * True iff zero apps in this scan's SERP title-matched the keyword — see
   * `KeywordGapProfile.lowConfidence` (keyword-types.ts) and migration 042.
   */
  readonly lowConfidence: boolean;
  /**
   * True iff this scan's field looked brand-navigational — see
   * `KeywordGapProfile.brandNavigational` (keyword-types.ts), migration 050,
   * and `keyword-brand.ts`'s `isBrandNavigationalScan` (Batch A budget
   * rescue, 2026-07-22).
   */
  readonly brandNavigational: boolean;
}

/**
 * `KeywordScanRow` augmented with the keyword corpus's `created_at`/`source`
 * (from `appstore_keywords`, joined by `getTopOpportunities`). Both are
 * `null` when the scan has no corresponding corpus row (shouldn't happen in
 * practice, since scans are only ever inserted for corpus keywords, but the
 * LEFT JOIN makes it possible) rather than surfaced as an unusable zero/"".
 */
export interface OpportunityRow extends KeywordScanRow {
  readonly firstFoundAt: number | null;
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | "mined" | null;
  /**
   * MAX(opportunity) over this keyword's entire scan history (all stores).
   * Backs the "peak" leaderboard sort — a keyword whose latest scan has
   * collapsed to near-zero demand can still be found by how good it once
   * scored. Falls back to the latest-scan `opportunity` in the (expected
   * never to happen in practice) case the peak CTE has no matching row.
   */
  readonly peakOpportunity: number;
}

/** Raw column shape returned by `SELECT * FROM appstore_keyword_scans`. */
interface KeywordScanDbRow {
  readonly id: number | string;
  readonly keyword: string;
  readonly store: string;
  readonly scanned_at: number | string;
  readonly competitiveness: number | string;
  readonly demand: number | string;
  readonly incumbent_weakness: number | string;
  readonly opportunity: number | string;
  readonly trend: string;
  readonly top_app_reviews: number | string;
  readonly avg_rating: number | string;
  readonly avg_age_days: number | string;
  /** Raw jsonb value — Bun's SQL driver returns this as a JSON string, not a parsed array. */
  readonly top_apps: unknown;
  /**
   * Only present when the query's SELECT list added the mirrored
   * `BUILDABILITY_SQL` expression (`getTopOpportunities`). A plain
   * `SELECT * FROM appstore_keyword_scans` (`getLatestScan` /
   * `getScanHistory`) has no such column — `rowToScan` falls back to
   * computing it in TS via `computeBuildability` in that case.
   */
  readonly buildability?: number | string | null;
  /** Migration 042. Absent/null on any pre-migration row — treated as `false`. */
  readonly low_confidence?: boolean | null;
  /** Migration 050. Absent/null on any pre-migration row — treated as `false`. */
  readonly brand_navigational?: boolean | null;
}

/** Raw column shape returned by `getTopOpportunities`'s scan+corpus join. */
interface OpportunityDbRow extends KeywordScanDbRow {
  readonly keyword_created_at: number | string | null;
  readonly keyword_source: string | null;
  readonly peak_opportunity: number | string | null;
}

/**
 * Explicit column list for `getScanHistory`/`getLatestScan` — deliberately
 * EXCLUDES `serp_tail` (migration 044). Those two functions feed the
 * per-scan momentum/velocity-baseline series (`keyword-gaps.ts`'s
 * `scanKeyword`/`scanKeywordDeep`) and the dashboard's scan-history chart,
 * neither of which reads the deep-scan tail — including it would bloat both
 * hot paths with a column only `serp-rank-store.ts` ever consumes (via its
 * own explicit query). A frozen constant embedded via `db.unsafe`, matching
 * `BUILDABILITY_SQL`'s convention — no caller input reaches it.
 */
const SCAN_COLUMNS_SQL = `
  id, keyword, store, scanned_at, competitiveness, demand, incumbent_weakness,
  opportunity, trend, top_app_reviews, avg_rating, avg_age_days, top_apps, low_confidence,
  brand_navigational
`;

export function rowToScan(row: KeywordScanDbRow): KeywordScanRow {
  const demand = Number(row.demand);
  const topAppReviews = Number(row.top_app_reviews);
  const avgRating = Number(row.avg_rating);
  const buildability =
    row.buildability === undefined || row.buildability === null
      ? computeBuildability({ demand, topAppReviews, avgRating })
      : Number(row.buildability);
  return {
    id: Number(row.id),
    keyword: row.keyword,
    store: row.store as "app" | "play" | "DE",
    scannedAt: Number(row.scanned_at),
    competitiveness: Number(row.competitiveness),
    demand,
    incumbentWeakness: Number(row.incumbent_weakness),
    opportunity: Number(row.opportunity),
    trend: row.trend as GapTrend,
    topAppReviews,
    avgRating,
    avgAgeDays: Number(row.avg_age_days),
    topApps: parseJson<readonly TopApp[]>(row.top_apps, []),
    buildability,
    lowConfidence: row.low_confidence === true,
    brandNavigational: row.brand_navigational === true,
  };
}

export function rowToOpportunity(row: OpportunityDbRow): OpportunityRow {
  return {
    ...rowToScan(row),
    firstFoundAt:
      row.keyword_created_at === null || row.keyword_created_at === undefined
        ? null
        : Number(row.keyword_created_at),
    source: (row.keyword_source as OpportunityRow["source"]) ?? null,
    peakOpportunity:
      row.peak_opportunity === null || row.peak_opportunity === undefined
        ? Number(row.opportunity)
        : Number(row.peak_opportunity),
  };
}

export async function upsertKeywords(rows: readonly KeywordSeedRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const r of rows) {
    await db`
      INSERT INTO appstore_keywords (keyword, genre_zone, source, active, created_at)
      VALUES (${r.keyword}, ${r.genreZone}, ${r.source}, TRUE, ${now})
      ON CONFLICT (keyword) DO UPDATE SET genre_zone = EXCLUDED.genre_zone
    `;
    n++;
  }
  return n;
}

export async function getStaleKeywords(
  genreZone: string,
  limit: number,
): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE AND genre_zone = ${genreZone}
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return rows.map((r: { keyword: string }) => r.keyword);
}

/**
 * Stalest-first slice across the ENTIRE active corpus (no genre-zone
 * filter). Backs the timer-driven keyword-gap sweep, which scans the
 * globally stalest `keywordsPerSweep` keywords every cycle instead of
 * rotating through one zone per day.
 */
export async function getStaleKeywordsAcrossZones(limit: number): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return rows.map((r: { keyword: string }) => r.keyword);
}

/**
 * One `getStaleKeywordsTiered` pick, tagged with the lane it was drawn from
 * (serp-rank Stage 1, deep-scrape build) — lets the caller (`keyword-gaps.ts`'s
 * `runKeywordSweep`) decide which keywords deep-scan (hot/tier1, always) vs
 * stay shallow (mined, unless `appstoreKeywordGap.deepScanMined` opts in).
 */
export interface TieredKeyword {
  readonly keyword: string;
  readonly lane: "hot" | "tier1" | "mined";
}

/**
 * How many of a keyword's most recent (US-store) scans `getStaleKeywordsTiered`'s
 * tier-1 query looks at to band its effective staleness threshold — see
 * `buildTier1ThresholdCaseSql` and `keyword-tiering.ts`'s
 * `computeEffectiveStaleThreshold`. Small and fixed: only the boundary
 * `>= TIER1_SLOW_BAND_MIN_SCANS` (2) matters for the scan-count check, and
 * only the latest reading (or the recent MAX when it's `low_confidence`)
 * matters for the opportunity check — 5 gives that recent-max check a small
 * cushion without pulling a keyword's whole scan history per row.
 */
const TIER1_RECENT_SCAN_WINDOW = 5;

/**
 * Frozen SQL CASE expression mirroring `keyword-tiering.ts`'s
 * `computeEffectiveStaleThreshold`, PLUS its two documented adjustments —
 * hand-mirrored (same convention as `isTier1Eligible`'s relationship to the
 * inline eligibility SQL below: a pure, unit-tested TS function documents
 * the intended semantics; SQL cannot call back into TS at query time, so the
 * bands are re-expressed here). References the `tier1_candidates c` /
 * `scan_stats s` aliases from `getStaleKeywordsTiered`'s tier-1 CTE.
 * `baseMs` is a validated (Zod `z.number().int()`) config value, never
 * caller/agent-supplied text, so embedding it as a numeric literal is safe —
 * same convention as `BUILDABILITY_SQL`'s frozen numeric constants.
 *
 *   - adjustment (a): a keyword with an active signature hit
 *     (`c.has_active_signature_hit`) ALWAYS keeps the fast band, regardless
 *     of opportunity.
 *   - adjustment (b): the opportunity value banded against is the LATEST
 *     reading, UNLESS the latest scan was `low_confidence` — in that case
 *     the RECENT-MAX opportunity (over `TIER1_RECENT_SCAN_WINDOW` scans) is
 *     used instead, so one degraded read can't demote a real opportunity.
 *   - otherwise: the same high/mid/slow/grace bands as
 *     `computeEffectiveStaleThreshold`.
 *
 * Deliberately DOES NOT special-case `scan_count = 0` as immediately
 * eligible (unlike `computeEffectiveStaleThreshold`'s own `scanCount === 0`
 * branch): the outer query's `c.last_scanned_at IS NULL` check already
 * covers every GENUINE never-scanned keyword (an `OR` ahead of this CASE
 * entirely — see the `WHERE` clause below), so a redundant zero-scan-count
 * fast path here would only ever fire for the narrow, non-genuine edge case
 * of a keyword with `last_scanned_at` SET (e.g. touched by something other
 * than a real scan) but zero rows in `appstore_keyword_scans` — where
 * treating it as immediately-eligible would be WRONG (it isn't actually
 * "never scanned", staleness should still be judged against its
 * `last_scanned_at`). Falling through to the opportunity bands with
 * `effectiveOpportunity` defaulting to 0 (via the `COALESCE`) lands it in
 * the mid/grace band instead, which is the safe, conservative choice.
 */
function buildTier1ThresholdCaseSql(baseMs: number): string {
  const base = Math.trunc(baseMs);
  const mid = base * 2;
  const slow = base * 8;
  const effectiveOpportunity = `
    COALESCE(
      CASE WHEN s.latest_low_confidence THEN s.recent_max_opportunity ELSE s.latest_opportunity END,
      0
    )
  `;
  return `
    CASE
      WHEN c.has_active_signature_hit THEN ${base}
      WHEN ${effectiveOpportunity} >= 0.4 THEN ${base}
      WHEN ${effectiveOpportunity} >= 0.1 THEN ${mid}
      WHEN s.scan_count >= 2 THEN ${slow}
      ELSE ${mid}
    END
  `;
}

/**
 * Frozen SQL condition (safe to embed via `db.unsafe` — no caller/agent
 * input) selecting the GUARANTEED tier-1 sources: manual/seed (a human
 * explicitly asked for daily coverage) OR any active signature hit. Does
 * NOT include `autocomplete` — see `AUTOCOMPLETE_TIER1_SOURCE_CONDITION_SQL`
 * and the structural guard note below.
 */
const GUARANTEED_TIER1_SOURCE_CONDITION_SQL = `(
  k.source IN ('manual', 'seed')
  OR EXISTS (
    SELECT 1 FROM appstore_signature_hits h
    WHERE h.keyword = k.keyword AND h.status != 'dismissed'
  )
)`;

/** Frozen SQL condition selecting ONLY `source: 'autocomplete'` keywords. */
const AUTOCOMPLETE_TIER1_SOURCE_CONDITION_SQL = `k.source = 'autocomplete'`;

/**
 * Selects up to `limit` stale (per `thresholdCaseSql`'s banded per-keyword
 * threshold) active keywords matching `sourceConditionSql`, excluding
 * `excludeKeywords`, stalest-first. Shared core for `getStaleKeywordsTiered`'s
 * TWO tier-1 sub-lanes (Batch A budget rescue, 2026-07-22 — structural
 * guard, coordinated with the promise-tiered cadence banding above):
 *
 *   1. GUARANTEED (manual/seed/signature-hit) — UNCAPPED, `limit` is
 *      whatever's left of the batch after the hot lane.
 *   2. AUTOCOMPLETE — CAPPED at `tier1AutocompleteCap` per sweep, so a
 *      brand-new (or merely numerous) autocomplete keyword can no longer
 *      unconditionally compete for the WHOLE daily-guaranteed lane the way
 *      seed/manual do. Measured 2026-07-21/22: autocomplete had grown to
 *      83% of the tier-1 pool (4,175 keywords), 89% at opportunity < 0.1 —
 *      the promise-tiered cadence above already backs off an INDIVIDUAL
 *      autocomplete keyword's re-scan rate once it's proven weak, but this
 *      cap additionally bounds how many autocomplete keywords can occupy
 *      the guaranteed lane in the FIRST PLACE, protecting seed/manual (the
 *      corpus every validated candidate has ever come from) from ever being
 *      crowded out by sheer autocomplete volume.
 *
 * `sourceConditionSql`/`thresholdCaseSql` are frozen, non-caller-controlled
 * SQL text (see their own doc comments) — never string-built from request
 * input.
 */
async function selectTier1Slice(
  db: ReturnType<typeof getDb>,
  opts: {
    readonly now: number;
    readonly sourceConditionSql: string;
    readonly excludeKeywords: readonly string[];
    readonly thresholdCaseSql: string;
    readonly limit: number;
  },
): Promise<readonly string[]> {
  if (opts.limit <= 0) return [];
  const rows = await db`
    WITH tier1_candidates AS (
      SELECT
        k.keyword,
        k.last_scanned_at,
        EXISTS (
          SELECT 1 FROM appstore_signature_hits h
          WHERE h.keyword = k.keyword AND h.status != 'dismissed'
        ) AS has_active_signature_hit
      FROM appstore_keywords k
      WHERE k.active = TRUE
        AND NOT (k.keyword = ANY(${db.array([...opts.excludeKeywords], "text")}))
        AND ${db.unsafe(opts.sourceConditionSql)}
    ),
    scan_stats AS (
      SELECT
        c.keyword,
        recent.scan_count,
        recent.latest_opportunity,
        recent.latest_low_confidence,
        recent.recent_max_opportunity
      FROM tier1_candidates c
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS scan_count,
          max(opportunity) AS recent_max_opportunity,
          (array_agg(opportunity ORDER BY scanned_at DESC))[1] AS latest_opportunity,
          (array_agg(low_confidence ORDER BY scanned_at DESC))[1] AS latest_low_confidence
        FROM (
          SELECT opportunity, low_confidence, scanned_at
          FROM appstore_keyword_scans
          WHERE keyword = c.keyword AND store = 'app'
          ORDER BY scanned_at DESC
          LIMIT ${TIER1_RECENT_SCAN_WINDOW}
        ) recent
      ) recent ON TRUE
    )
    SELECT c.keyword
    FROM tier1_candidates c
    LEFT JOIN scan_stats s ON s.keyword = c.keyword
    WHERE (
      c.last_scanned_at IS NULL
      OR (${opts.now} - c.last_scanned_at) * 1000 >= ${db.unsafe(opts.thresholdCaseSql)}
    )
    ORDER BY c.last_scanned_at ASC NULLS FIRST
    LIMIT ${opts.limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword);
}

/**
 * Tier-1-guaranteed + mined-quota slice across the whole active corpus,
 * backing the timer-driven keyword-gap sweep's priority re-scan lane (see
 * `keyword-tiering.ts` for the full rationale, updated 2026-07-21's
 * scan-budget retune, and again 2026-07-22's promise-tiered cadence budget
 * rescue). Tier 1 — seed/manual/autocomplete keywords, or keywords with ANY
 * `appstore_signature_hits` row, whose OWN banded effective staleness
 * threshold has elapsed (see `buildTier1ThresholdCaseSql` — no longer one
 * flat threshold for the whole pool) — is UNCAPPED, filling up to the whole
 * batch if needed; mined exploration fills whatever's left, bounded by BOTH
 * the remaining batch slots and the caller-supplied rolling-daily mined
 * quota (`opts.mineQuotaRemaining`), excluding whatever tier 1 already
 * picked so no keyword is returned twice. `keyword = ANY('{}')` is always
 * FALSE (never NULL) in Postgres, so an empty tier-1 list needs no
 * special-casing in the mined exclusion. Each returned entry is tagged with
 * its lane (`TieredKeyword`) — see that type's doc comment.
 */
export async function getStaleKeywordsTiered(opts: {
  /** This cycle's overall scan batch size (throttle-adjusted `keywordsPerSweep`). */
  readonly batchLimit: number;
  /**
   * Remaining mined-exploration quota for the rolling 24h window (
   * `minedExploration.dailyQuota` minus `countMinedScansSince`'s count for
   * the same window — computed by the caller, `runKeywordSweep`). Once this
   * hits 0, no more mined keywords are drawn for the rest of the day — the
   * batch returns hot + tier 1 only, even if `batchLimit` has slots left over.
   */
  readonly mineQuotaRemaining: number;
  /**
   * Tier 1's FAST/BASE staleness window in ms
   * (`appstoreKeywordGap.tier1StaleThresholdMs` config, default 6h — see
   * keyword-tiering.ts module doc). No longer applied flat to every tier-1
   * keyword (Batch A budget rescue, 2026-07-22) — see
   * `buildTier1ThresholdCaseSql` for how each keyword's own effective
   * threshold is banded off this base. Computed by the caller so this module
   * stays config-free, matching `mineQuotaRemaining`.
   */
  readonly tier1StaleThresholdMs: number;
  /**
   * This sweep's slice of the mined daily quota
   * (`ceil(dailyQuota * scanIntervalMs / 86_400_000)`, computed by the
   * caller — `runKeywordSweep`). Prevents a single sweep from greedily
   * spending the WHOLE day's mined quota in one cycle when hot/tier 1 are
   * light that cycle — see keyword-tiering.ts module doc, "Mined
   * exploration".
   */
  readonly perSweepCap: number;
  /**
   * Per-sweep cap on how many `source: 'autocomplete'` keywords the tier-1
   * GUARANTEED lane may include (Batch A budget rescue, 2026-07-22 —
   * structural guard; see `selectTier1Slice`'s doc comment). manual/seed/
   * signature-hit keywords stay uncapped. `appstoreKeywordGap.tier1AutocompleteCap`
   * config, computed by the caller so this module stays config-free.
   */
  readonly tier1AutocompleteCap: number;
}): Promise<readonly TieredKeyword[]> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const hotStaleThresholdAt = now - Math.floor(HOT_LANE_STALE_THRESHOLD_MS / 1000);

  // Hot lane — open signature-hit watchlist entries, stale by the SHORTER
  // hot-lane threshold, pulled ahead of tier 1 so they never lose a slot to
  // a merely-stale tier-1 keyword (see keyword-tiering.ts module doc).
  // Capped (unlike tier 1) since an unbounded watchlist could otherwise
  // crowd out everything else.
  const hotRows =
    opts.batchLimit > 0
      ? await db`
          SELECT k.keyword FROM appstore_keywords k
          JOIN appstore_signature_hits h ON h.keyword = k.keyword
          WHERE k.active = TRUE
            AND h.status IN ('new', 'active')
            AND (k.last_scanned_at IS NULL OR k.last_scanned_at < ${hotStaleThresholdAt})
          ORDER BY k.last_scanned_at ASC NULLS FIRST
          LIMIT ${Math.min(HOT_LANE_MAX_BATCH, opts.batchLimit)}
        `
      : [];
  const hotKeywords = (hotRows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword);

  // Tier 1 — UNCAPPED (see keyword-tiering.ts module doc): every stale
  // eligible-source or signature-hit keyword not already claimed by the hot
  // lane competes for the rest of this cycle's batch, stalest-first, up to
  // the WHOLE remaining batch if needed. Self-limiting in practice — see
  // module doc comment. "Stale" is no longer one flat `tier1StaleThresholdMs`
  // for the whole pool (Batch A budget rescue, 2026-07-22): each keyword's
  // OWN effective threshold is banded by its own recent opportunity — see
  // `buildTier1ThresholdCaseSql`'s doc comment for the full band + adjustment
  // rules, and `keyword-tiering.ts`'s `computeEffectiveStaleThreshold` for
  // the canonical pure-function statement of the same bands. `scan_stats`
  // uses a LATERAL join bounded to `TIER1_RECENT_SCAN_WINDOW` rows per
  // keyword (via the existing `idx_appstore_keyword_scans_history (keyword,
  // store, scanned_at DESC)` index) rather than a window function over the
  // whole scans table, so this stays a per-keyword index seek, not a table
  // scan, even though it now runs once per active tier1-eligible keyword
  // every sweep cycle (bounded by the tier-1 pool size, not the far larger
  // whole-corpus scan history).
  const remainingAfterHot = opts.batchLimit - hotKeywords.length;
  const tier1ThresholdCaseSql = buildTier1ThresholdCaseSql(opts.tier1StaleThresholdMs);

  // Guaranteed sub-lane (manual/seed/signature-hit) — UNCAPPED, exactly the
  // pre-2026-07-22 tier-1 behavior, restricted to the sources an operator
  // (or the signature screener) explicitly asked for daily coverage.
  const guaranteedKeywords = await selectTier1Slice(db, {
    now,
    sourceConditionSql: GUARANTEED_TIER1_SOURCE_CONDITION_SQL,
    excludeKeywords: hotKeywords,
    thresholdCaseSql: tier1ThresholdCaseSql,
    limit: remainingAfterHot,
  });

  // Autocomplete sub-lane — CAPPED at `tier1AutocompleteCap` per sweep (see
  // `selectTier1Slice`'s doc comment, "structural guard"): fills whatever's
  // left after the guaranteed sub-lane, up to the cap.
  const remainingAfterGuaranteed = remainingAfterHot - guaranteedKeywords.length;
  const autocompleteLimit = Math.min(remainingAfterGuaranteed, opts.tier1AutocompleteCap);
  const autocompleteKeywords = await selectTier1Slice(db, {
    now,
    sourceConditionSql: AUTOCOMPLETE_TIER1_SOURCE_CONDITION_SQL,
    excludeKeywords: [...hotKeywords, ...guaranteedKeywords],
    thresholdCaseSql: tier1ThresholdCaseSql,
    limit: autocompleteLimit,
  });

  const tier1Keywords = [...guaranteedKeywords, ...autocompleteKeywords];
  const claimedKeywords = [...hotKeywords, ...tier1Keywords];
  const claimedTiered: readonly TieredKeyword[] = [
    ...hotKeywords.map((keyword) => ({ keyword, lane: "hot" as const })),
    ...tier1Keywords.map((keyword) => ({ keyword, lane: "tier1" as const })),
  ];
  const remainingBatch = remainingAfterHot - tier1Keywords.length;
  const mineSlots = computeMineSlots(remainingBatch, opts.mineQuotaRemaining, opts.perSweepCap);
  if (mineSlots <= 0) return claimedTiered;

  // Mined exploration — never-scanned first (NULLS FIRST), then
  // oldest-scanned-still-active, capped by whatever's left of this cycle's
  // batch, the rolling daily mined quota, AND this sweep's per-sweep slice
  // of that quota (`perSweepCap`).
  const mineRows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE
      AND source = 'mined'
      AND NOT (keyword = ANY(${db.array(claimedKeywords, "text")}))
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${mineSlots}
  `;

  return [
    ...claimedTiered,
    ...(mineRows as ReadonlyArray<{ keyword: string }>).map((r) => ({
      keyword: r.keyword,
      lane: "mined" as const,
    })),
  ];
}

export async function markScanned(keywords: readonly string[], at: number): Promise<void> {
  if (keywords.length === 0) return;
  const db = getDb();
  await db`UPDATE appstore_keywords SET last_scanned_at = ${at} WHERE keyword IN ${db(keywords)}`;
}

export async function insertScan(p: KeywordGapProfile): Promise<void> {
  const db = getDb();
  // `serp_tail` (migration 044): NULL for a plain (non-deep) scan — only
  // `scanKeywordDeep` populates `p.serpTail`. Written the same
  // `JSON.stringify`-into-JSONB way as `top_apps`, which double-encodes it at
  // the Postgres level by design — see migration 044's doc comment.
  await db`
    INSERT INTO appstore_keyword_scans (
      keyword, store, scanned_at, competitiveness, demand, incumbent_weakness,
      opportunity, trend, top_app_reviews, avg_rating, avg_age_days, top_apps,
      low_confidence, serp_tail, brand_navigational
    ) VALUES (
      ${p.keyword}, ${p.store}, ${p.scannedAt}, ${p.competitiveness}, ${p.demand},
      ${p.incumbentWeakness}, ${p.opportunity}, ${p.trend}, ${p.topAppReviews},
      ${p.avgRating}, ${p.avgAgeDays}, ${JSON.stringify(p.topApps)}, ${p.lowConfidence},
      ${p.serpTail ? JSON.stringify(p.serpTail) : null}, ${p.brandNavigational}
    )
  `;
}

export async function getLatestScan(
  keyword: string,
  store: "app" | "play" | "DE" = "app",
): Promise<KeywordScanRow | null> {
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT ON (keyword, store) ${db.unsafe(SCAN_COLUMNS_SQL)}
    FROM appstore_keyword_scans
    WHERE keyword = ${keyword} AND store = ${store}
    ORDER BY keyword, store, scanned_at DESC
  `;
  const row = (rows as KeywordScanDbRow[])[0];
  return row ? rowToScan(row) : null;
}

/**
 * Full-column sort keys the `GET /appstore/opportunities` dashboard table can
 * sort by. Each maps to a column on `s`, the DISTINCT-ON (keyword, store)
 * latest-scan subquery aliased in `getTopOpportunities` — see
 * `SORT_COLUMNS`.
 */
export type SortKey =
  | "keyword"
  | "store"
  | "opportunity"
  | "competitiveness"
  | "demand"
  | "incumbentWeakness"
  | "trend"
  | "topAppReviews"
  | "avgRating"
  | "avgAgeDays"
  | "buildability";

/** Every valid `SortKey`, for building the Zod enum at the route boundary. */
export const SORT_KEYS = [
  "keyword",
  "store",
  "opportunity",
  "competitiveness",
  "demand",
  "incumbentWeakness",
  "trend",
  "topAppReviews",
  "avgRating",
  "avgAgeDays",
  "buildability",
] as const satisfies readonly SortKey[];

/**
 * SQL mirror of `computeBuildability` (`keyword-scoring.ts`) over the `s`
 * (DISTINCT ON latest-scan) subquery alias's `demand` / `top_app_reviews` /
 * `avg_rating` columns. Defined ONCE and reused verbatim in the data query's
 * SELECT list, the `buildability` `SORT_COLUMNS` branch, and the
 * `minBuildability` filter comparison (`buildFilterClause`), so the three can
 * never drift out of sync with each other — and an integration test
 * drift-guards this SQL text against the canonical TS `computeBuildability`
 * itself. `demand` is REAL NOT NULL and `top_app_reviews` is INTEGER NOT NULL
 * (migration 037), both always >= 0 in practice, so `ln(1 + x)` never sees a
 * non-positive argument here. No caller input reaches this string — it is a
 * frozen constant, embedded via `db.unsafe`, never interpolated as a normal
 * `${}` value.
 */
const BUILDABILITY_SQL = `round(100 * least(1,greatest(0, ln(1+s.demand)/ln(1+50))) *
      (0.65*least(1,greatest(0, 1 - ln(1+s.top_app_reviews)/ln(1+5000)))
       + 0.35*least(1,greatest(0, (4.5 - s.avg_rating)/1.5))))`;

/**
 * Whitelist mapping each `SortKey` to its literal SQL column/expression on
 * subquery alias `s` (see `getTopOpportunities`). This is the ONLY place a
 * sort key becomes SQL text: Bun.sql tagged templates parameterize VALUES,
 * not identifiers, so an ORDER BY column can never be interpolated as a
 * normal `${}` placeholder. Caller-supplied `sort`/`dir` only ever select a
 * branch of this frozen constant via `buildOrderByClause` — they never reach
 * SQL text directly, closing off any injection surface even though `sort` is
 * already narrowed to the `SortKey` union by Zod at the route boundary.
 * `buildability` maps to the full `BUILDABILITY_SQL` constant expression
 * rather than a plain column — still no user input in ORDER BY.
 */
const SORT_COLUMNS: Readonly<Record<SortKey, string>> = Object.freeze({
  keyword: "s.keyword",
  store: "s.store",
  opportunity: "s.opportunity",
  competitiveness: "s.competitiveness",
  demand: "s.demand",
  incumbentWeakness: "s.incumbent_weakness",
  trend: "s.trend",
  topAppReviews: "s.top_app_reviews",
  avgRating: "s.avg_rating",
  avgAgeDays: "s.avg_age_days",
  buildability: BUILDABILITY_SQL,
});

/**
 * Builds the ORDER BY fragment for `getTopOpportunities`: the whitelisted
 * sort column in the requested direction, then a deterministic
 * `keyword, store` tiebreaker so pagination stays stable across pages even
 * when many rows share the same sort-column value (e.g. many keywords tied
 * on `trend`).
 */
function buildOrderByClause(sort: SortKey, dir: "asc" | "desc"): string {
  const column = SORT_COLUMNS[sort];
  const direction = dir === "asc" ? "ASC" : "DESC";
  return `${column} ${direction} NULLS LAST, s.keyword ASC, s.store ASC`;
}

interface OpportunityFilters {
  readonly genreZone: string | null;
  readonly trend: GapTrend | null;
  readonly minDemand: number | null;
  readonly maxCompetitiveness: number | null;
  readonly minIncumbentWeakness: number | null;
  readonly minOpportunity: number | null;
  readonly minBuildability: number | null;
  readonly hideJunk: boolean;
}

/**
 * Builds the shared WHERE-condition fragment for both `getTopOpportunities`'s
 * data query and `countFilteredOpportunities`'s count query, so the two can
 * never drift out of sync (a mismatch would make `total` lie about the
 * actual filtered page count). Every numeric/trend/zone filter is a
 * NULL-guarded `${}` value placeholder — omitted filters (`null`) are true
 * no-ops, never string-interpolated.
 *
 * The `hideJunk` branch drops a row when its ENTIRE (trimmed, lowercased)
 * keyword is a sole generic word from `JUNK_KEYWORDS` (bound as a `text[]`
 * array parameter via `db.array`, never interpolated), OR the trimmed
 * keyword is under 3 characters, OR the keyword is purely
 * numeric/punctuation/whitespace. A multi-word keyword survives even if one
 * token is generic (e.g. "budget planner" is kept) — only a keyword that IS
 * (whole, trimmed) a stoplist entry is junk.
 *
 * `s.brand_navigational` (migration 050, Batch A budget rescue,
 * 2026-07-22 — see `keyword-brand.ts`) is EXCLUDED unconditionally, unlike
 * `hideJunk` — a brand-navigational SERP (one incumbent dominating the
 * field, matched to the keyword) is never a genuine whitespace opportunity
 * by definition, so there is no legitimate reason for the dashboard to ever
 * surface one here.
 */
function buildFilterClause(db: ReturnType<typeof getDb>, filters: OpportunityFilters) {
  return db`
    (${filters.genreZone}::text IS NULL OR k.genre_zone = ${filters.genreZone})
    AND (${filters.trend}::text IS NULL OR s.trend = ${filters.trend})
    AND (${filters.minDemand}::numeric IS NULL OR s.demand >= ${filters.minDemand})
    AND (
      ${filters.maxCompetitiveness}::numeric IS NULL
      OR s.competitiveness <= ${filters.maxCompetitiveness}
    )
    AND (
      ${filters.minIncumbentWeakness}::numeric IS NULL
      OR s.incumbent_weakness >= ${filters.minIncumbentWeakness}
    )
    AND (${filters.minOpportunity}::numeric IS NULL OR s.opportunity >= ${filters.minOpportunity})
    AND (
      ${filters.minBuildability}::numeric IS NULL
      OR ${db.unsafe(BUILDABILITY_SQL)} >= ${filters.minBuildability}
    )
    AND s.brand_navigational = FALSE
    AND (
      ${filters.hideJunk} = FALSE
      OR (
        lower(btrim(s.keyword)) <> ALL(${db.array([...JUNK_KEYWORDS], "text")})
        AND char_length(btrim(s.keyword)) >= 3
        AND s.keyword !~ '^[0-9[:punct:][:space:]]+$'
      )
    )
  `;
}

/**
 * Total count of (keyword, store) pairs matching the filters, independent of
 * pagination — backs `meta.total` so the dashboard can page through the
 * whole corpus rather than just the returned slice. Counts the same
 * DISTINCT-ON (keyword, store) latest-scan set that `getTopOpportunities`
 * pages through, applying the identical `buildFilterClause` fragment, so
 * `total` always matches the filtered result-set size before `limit`/`offset`.
 */
async function countFilteredOpportunities(filters: OpportunityFilters): Promise<number> {
  const db = getDb();
  const rows = await db`
    WITH s AS (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    )
    SELECT count(*) AS count
    FROM s
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE ${buildFilterClause(db, filters)}
  `;
  const count = (rows as ReadonlyArray<{ count: number | string }>)[0]?.count;
  return count === undefined ? 0 : Number(count);
}

export interface GetTopOpportunitiesOptions {
  readonly limit: number;
  readonly offset?: number;
  /** Column to sort by. Default "opportunity". */
  readonly sort?: SortKey;
  /** Sort direction. Default "desc". */
  readonly dir?: "asc" | "desc";
  readonly genreZone?: string;
  readonly trend?: GapTrend;
  /** Only include rows whose latest-scan `demand` is >= this value. */
  readonly minDemand?: number;
  /** Only include rows whose latest-scan `competitiveness` is <= this value. */
  readonly maxCompetitiveness?: number;
  /** Only include rows whose latest-scan `incumbentWeakness` is >= this value. */
  readonly minIncumbentWeakness?: number;
  /** Only include rows whose latest-scan `opportunity` is >= this value. */
  readonly minOpportunity?: number;
  /** Only include rows whose computed `buildability` (0..100) is >= this value. */
  readonly minBuildability?: number;
  /**
   * When true, drop junk rows: sole-generic-word keywords (see
   * `JUNK_KEYWORDS`), keywords under 3 characters, and purely
   * numeric/punctuation/whitespace keywords. Default false (no suppression).
   */
  readonly hideJunk?: boolean;
}

export interface GetTopOpportunitiesResult {
  readonly rows: readonly OpportunityRow[];
  /** Count of (keyword, store) rows matching ALL supplied filters, ignoring `limit`/`offset` — for pagination. */
  readonly total: number;
}

/**
 * Server-side paginated, sortable listing of the WHOLE keyword corpus's
 * latest scan per (keyword, store) — backs `GET /appstore/opportunities`.
 * Sorting is full-column (see `SortKey`) via a whitelisted ORDER BY
 * (`buildOrderByClause`), never by interpolating caller input into SQL
 * text. `peakOpportunity` (MAX(opportunity) over each keyword's full scan
 * history, all stores) is always included on every row alongside the
 * latest-scan `opportunity`, so the UI can show both numbers regardless of
 * sort column. `total` is the filtered, pre-pagination match count.
 */
export async function getTopOpportunities(
  opts: GetTopOpportunitiesOptions,
): Promise<GetTopOpportunitiesResult> {
  const db = getDb();
  const filters: OpportunityFilters = {
    genreZone: opts.genreZone ?? null,
    trend: opts.trend ?? null,
    minDemand: opts.minDemand ?? null,
    maxCompetitiveness: opts.maxCompetitiveness ?? null,
    minIncumbentWeakness: opts.minIncumbentWeakness ?? null,
    minOpportunity: opts.minOpportunity ?? null,
    minBuildability: opts.minBuildability ?? null,
    hideJunk: opts.hideJunk ?? false,
  };
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? "opportunity";
  const dir = opts.dir ?? "desc";
  const orderByClause = buildOrderByClause(sort, dir);

  const dataQuery = db`
    WITH s AS (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    ),
    peak AS (
      SELECT keyword, MAX(opportunity) AS peak_opportunity
      FROM appstore_keyword_scans
      GROUP BY keyword
    )
    SELECT
      s.*,
      ${db.unsafe(BUILDABILITY_SQL)} AS buildability,
      peak.peak_opportunity AS peak_opportunity,
      k.created_at AS keyword_created_at,
      k.source AS keyword_source
    FROM s
    LEFT JOIN peak ON peak.keyword = s.keyword
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE ${buildFilterClause(db, filters)}
    ORDER BY ${db.unsafe(orderByClause)}
    LIMIT ${opts.limit} OFFSET ${offset}
  `;

  const [rows, total] = await Promise.all([dataQuery, countFilteredOpportunities(filters)]);

  return {
    rows: (rows as OpportunityDbRow[]).map(rowToOpportunity),
    total,
  };
}

/**
 * Returns the epoch-second timestamp of the most recent scan among keywords
 * belonging to `genreZone`, or `null` if the zone has no scans yet. Used to
 * gate the keyword-gap sweep to `scanIntervalMs` cadence instead of running
 * on every scraper tick.
 */
export async function getMostRecentScanAt(genreZone: string): Promise<number | null> {
  const db = getDb();
  const rows = await db`
    SELECT MAX(s.scanned_at) AS last
    FROM appstore_keyword_scans s
    JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE k.genre_zone = ${genreZone}
  `;
  const last = (rows as ReadonlyArray<{ last: number | string | null }>)[0]?.last;
  return last === null || last === undefined ? null : Number(last);
}

/**
 * Count of keyword scans recorded at or after `epochSeconds`. Backs the
 * `dailyKeywordBudget` rolling-24h safety ceiling: the sweep checks this
 * against `now - 86_400` before spending more lookups.
 */
export async function countScansSince(epochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT count(*) AS count FROM appstore_keyword_scans WHERE scanned_at >= ${epochSeconds}
  `;
  const count = (rows as ReadonlyArray<{ count: number | string }>)[0]?.count;
  return count === undefined ? 0 : Number(count);
}

/**
 * Count of `source: 'mined'` keyword scans recorded at or after
 * `epochSeconds` — backs the mined-exploration daily quota
 * (`appstoreKeywordGap.minedExploration.dailyQuota`), tracked SEPARATELY
 * from `countScansSince`'s whole-corpus rolling budget so tier-1
 * (seed/manual/autocomplete/signature-hit) scans never eat into the mined
 * pool's own daily cap, and vice versa. Joins to `appstore_keywords` for
 * `source` since `appstore_keyword_scans` itself has no source column; the
 * `scanned_at >= epochSeconds` filter is applied before the join so this
 * stays index-friendly against `idx_appstore_keyword_scans_top`.
 */
export async function countMinedScansSince(epochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT count(*) AS count
    FROM appstore_keyword_scans s
    JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE s.scanned_at >= ${epochSeconds} AND k.source = 'mined'
  `;
  const count = (rows as ReadonlyArray<{ count: number | string }>)[0]?.count;
  return count === undefined ? 0 : Number(count);
}

/**
 * Latest scan per keyword, joined to its corpus row for `genre_zone`,
 * filtered to `opportunity >= minOpportunity` and ordered richest-first.
 * Used to seed autocomplete expansion from proven high-opportunity
 * "winners" — an inner join means a scan with no corresponding corpus row
 * (shouldn't happen in practice) is silently excluded rather than surfaced
 * with an unusable null zone.
 */
/**
 * High-opportunity "winner" keywords, seed-rotated (2026-07-21 audit item D
 * fix): among ALL qualifying winners (`opportunity >= minOpportunity`), the
 * least-recently-used-as-an-expansion-seed surfaces first (`e.last_expanded_at
 * ASC NULLS FIRST`, via `appstore_seed_expansion_state` — see
 * `markSeedsExpanded`), with `opportunity DESC` only as a tiebreak. Without
 * this, the same top-N-by-opportunity keywords are re-selected as seeds on
 * EVERY pass (opportunity rarely changes pass-to-pass) — this is exactly the
 * "same ~25 seeds re-fetched every pass" flatlining the audit measured live.
 * Store-scoped to 'app' (2026-07-21 audit item B fix) — see module doc.
 */

export async function getWinnerKeywords(
  minOpportunity: number,
  limit: number,
): Promise<readonly { keyword: string; genreZone: string }[]> {
  const db = getDb();
  const rows = await db`
    SELECT s.keyword, k.genre_zone
    FROM (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    ) s
    JOIN appstore_keywords k ON k.keyword = s.keyword
    LEFT JOIN appstore_seed_expansion_state e ON e.keyword = s.keyword
    WHERE s.store = 'app' AND s.opportunity >= ${minOpportunity}
    ORDER BY e.last_expanded_at ASC NULLS FIRST, s.opportunity DESC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string; genre_zone: string }>).map((r) => ({
    keyword: r.keyword,
    genreZone: r.genre_zone,
  }));
}

/**
 * A diverse, zone-spread sample of the active corpus: the stalest
 * (least-recently-scanned — NULLS FIRST so never-scanned keywords sort
 * first) keyword per genre zone, then each zone's second-stalest, and so
 * on — interleaved round-robin across zones rather than exhausting one
 * zone before moving to the next. Paired with `getWinnerKeywords` in
 * `getExpansionSeeds` so autocomplete corpus expansion isn't purely
 * winner-driven: a keyword that has never posted a high-opportunity scan
 * (or hasn't been scanned at all) still gets a turn to seed expansion,
 * which keeps under-covered zones from starving (anti rich-get-richer
 * monoculture).
 */
/**
 * Zone-diverse expansion-seed picks, seed-rotated (2026-07-21 audit item D
 * fix): PRIMARY order key is `e.last_expanded_at ASC NULLS FIRST` (seed
 * rotation state, via `appstore_seed_expansion_state` — see
 * `markSeedsExpanded`), not `last_scanned_at` (a different concern — SERP
 * scan cadence). `last_scanned_at` remains a secondary tiebreak among
 * equally-never-expanded keywords in a zone.
 */

export async function getDiverseZoneSample(
  limit: number,
): Promise<readonly { keyword: string; genreZone: string }[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = await db`
    WITH ranked AS (
      SELECT
        k.keyword,
        k.genre_zone,
        ROW_NUMBER() OVER (
          PARTITION BY k.genre_zone
          ORDER BY e.last_expanded_at ASC NULLS FIRST, k.last_scanned_at ASC NULLS FIRST, k.keyword ASC
        ) AS rn
      FROM appstore_keywords k
      LEFT JOIN appstore_seed_expansion_state e ON e.keyword = k.keyword
      WHERE k.active = TRUE
    )
    SELECT keyword, genre_zone
    FROM ranked
    ORDER BY rn ASC, genre_zone ASC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string; genre_zone: string }>).map((r) => ({
    keyword: r.keyword,
    genreZone: r.genre_zone,
  }));
}

/**
 * Broadened seed set for autocomplete corpus expansion: up to
 * `winnerLimit` current high-opportunity "winners" (`getWinnerKeywords`)
 * PLUS up to `diverseLimit` round-robin picks spread across genre zones
 * (`getDiverseZoneSample`). Winners take priority on overlap — a diverse
 * pick that duplicates an already-selected winner keyword is dropped
 * rather than double-counted — so the combined, deduped list never exceeds
 * `winnerLimit + diverseLimit` entries. Both limits are caller-supplied so
 * behavior stays deterministic and testable against a fixed DB state.
 */
export async function getExpansionSeeds(opts: {
  readonly minOpportunity: number;
  readonly winnerLimit: number;
  readonly diverseLimit: number;
}): Promise<readonly { keyword: string; genreZone: string }[]> {
  const [winners, diverse] = await Promise.all([
    getWinnerKeywords(opts.minOpportunity, opts.winnerLimit),
    getDiverseZoneSample(opts.diverseLimit),
  ]);

  const seen = new Set(winners.map((w) => w.keyword));
  const combined = [...winners];
  for (const pick of diverse) {
    if (seen.has(pick.keyword)) continue;
    seen.add(pick.keyword);
    combined.push(pick);
  }
  return combined;
}

/**
 * Marks `keywords` as having just been used as autocomplete expansion seeds
 * (2026-07-21 audit item D fix) — upserts `last_expanded_at = at` into
 * `appstore_seed_expansion_state` for each. Called once per expansion pass
 * for EVERY seed drawn that pass (regardless of whether its hint fetch
 * succeeded or yielded any candidates), so a permanently-failing seed still
 * rotates away next pass instead of being retried forever. See
 * `getWinnerKeywords`/`getDiverseZoneSample`'s doc comments for how this
 * state is consumed.
 */
export async function markSeedsExpanded(keywords: readonly string[], at: number): Promise<void> {
  if (keywords.length === 0) return;
  const db = getDb();
  for (const keyword of keywords) {
    await db`
      INSERT INTO appstore_seed_expansion_state (keyword, last_expanded_at)
      VALUES (${keyword}, ${at})
      ON CONFLICT (keyword) DO UPDATE SET last_expanded_at = EXCLUDED.last_expanded_at
    `;
  }
}

export interface AutocompleteHintRow {
  /** The exact query string sent to Apple's search-suggest endpoint — the bare seed, or a prefix-fan-out query built from it. */
  readonly seed: string;
  readonly term: string;
  /** 0-based position in Apple's popularity-ordered response for this seed/query. */
  readonly rank: number;
  readonly seenAt: number;
  /**
   * Apple storefront this hint was observed in, lowercase cc (throughput
   * wave item 3, migration 049) — `"us"` (the pre-migration/default lane)
   * or `"gb"` (the new GB hints lane). Optional on input; defaults to
   * `"us"` so every pre-item-3 caller is unaffected.
   */
  readonly storefront?: string;
}

/**
 * Append-only log of every (seed, term, rank) hint Apple's search-suggest
 * returned (2026-07-21 audit item D fix, migration 043) — the one giant-free
 * demand signal in the whole system, previously discarded entirely at write
 * time (`HintCandidate.rank` was computed but never persisted — see
 * keyword-autocomplete.ts's `expandCorpus`). `storefront` (migration 049,
 * throughput wave item 3) distinguishes which market a hint was observed in
 * — a hint's popularity ranking is inherently per-storefront.
 */
export async function insertAutocompleteHints(rows: readonly AutocompleteHintRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  for (const row of rows) {
    await db`
      INSERT INTO appstore_autocomplete_hints (seed, term, rank, seen_at, storefront)
      VALUES (${row.seed}, ${row.term}, ${row.rank}, ${row.seenAt}, ${row.storefront ?? "us"})
    `;
  }
}

/**
 * Returns the subset of `keywords` that already exist in the corpus.
 * Used by autocomplete expansion to avoid double-counting an
 * `upsertKeywords` call against an already-present keyword as "new".
 */
export async function keywordsExist(keywords: readonly string[]): Promise<ReadonlySet<string>> {
  if (keywords.length === 0) return new Set();
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords WHERE keyword IN ${db(keywords)}
  `;
  return new Set((rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword));
}

/**
 * Default cap on how many of the most-recent `appstore_keyword_scans` rows
 * are inspected for embedded app names (see `getScannedAppNames`). Bounds
 * query cost against a table that grows every scan cycle — recent rows
 * alone already cover the vast majority of distinct app names ever seen (in
 * practice ~12k distinct names live within the ~2k most-recent rows), so
 * this stays small relative to the table's overall size while staying
 * fresh.
 */
const DEFAULT_SCANNED_ROWS_LIMIT = 3000;

/**
 * Distinct app names embedded in the `top_apps` JSONB column of the most
 * recent `appstore_keyword_scans` rows — a broad, continuously-growing pool
 * of real App Store app names that goes well beyond the finite top-chart
 * apps in `appstore_apps`/`getRankings` (every keyword scan records its own
 * top results, and the scanner runs continuously). Paired with `getRankings`
 * in `keyword-miner.ts`'s `mineKeywords`, which mines candidate keywords
 * from both pools.
 *
 * `top_apps` is stored DOUBLE-ENCODED: Bun's SQL driver returns the jsonb
 * column as a JS string, and that string is itself a JSON-encoded array
 * (written via `JSON.stringify(p.topApps)` in `insertScan`) — so the
 * column's own `jsonb_typeof` is `'string'`, not `'array'`.
 * `(top_apps #>> '{}')::jsonb` un-escapes the outer string to recover the
 * real array before `jsonb_array_elements` can walk it.
 *
 * Defensive by construction rather than by catching a thrown cast error —
 * Postgres has no per-row try/catch in plain SQL, so a single bad cast
 * would abort the whole query and every caller with it. The WHERE clause
 * restricts to rows that are non-null, not the JSON literal `'null'`, AND
 * whose text representation starts with `"[` (the shape of a
 * JSON-encoded-string wrapping an array, checked with `LIKE` rather than a
 * `~` regex — `[` needs no escaping there, sidestepping any
 * JS-string-literal-vs-POSIX-regex escaping mismatch) BEFORE the cast ever
 * runs, so a malformed row is silently skipped instead of blowing up the
 * query.
 *
 * Bounded twice: `scanRowsLimit` caps how many recent scan rows are even
 * considered (freshness + cost bound on a table that grows without end),
 * and `limit` caps the distinct names returned. The final `GROUP BY name
 * ORDER BY max(scanned_at) DESC` (rather than a plain `SELECT DISTINCT ...
 * LIMIT`) matters: a bare `DISTINCT` has no ordering guarantee of its own,
 * so a `LIMIT` stacked directly on it could arbitrarily keep or drop any
 * given distinct name — grouping and explicitly ordering by each name's own
 * freshest occurrence makes "freshest names survive the limit first" an
 * actual guarantee instead of an implementation-detail coincidence.
 */
export async function getScannedAppNames(
  limit: number,
  scanRowsLimit: number = DEFAULT_SCANNED_ROWS_LIMIT,
): Promise<readonly string[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = await db`
    WITH recent AS (
      SELECT scanned_at, top_apps
      FROM appstore_keyword_scans
      WHERE store = 'app'
        AND top_apps IS NOT NULL
        AND top_apps::text <> 'null'
        AND top_apps::text LIKE '"[%'
      ORDER BY scanned_at DESC
      LIMIT ${scanRowsLimit}
    ),
    names AS (
      SELECT app ->> 'name' AS name, recent.scanned_at AS scanned_at
      FROM recent, LATERAL jsonb_array_elements((recent.top_apps #>> '{}')::jsonb) AS app
      WHERE app ->> 'name' IS NOT NULL AND app ->> 'name' <> ''
    )
    SELECT name
    FROM names
    GROUP BY name
    ORDER BY max(scanned_at) DESC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ name: string }>).map((r) => r.name);
}

export async function getScanHistory(
  keyword: string,
  limit: number,
  store: "app" | "play" | "DE",
): Promise<readonly KeywordScanRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT ${db.unsafe(SCAN_COLUMNS_SQL)} FROM appstore_keyword_scans
    WHERE keyword = ${keyword} AND store = ${store}
    ORDER BY scanned_at DESC
    LIMIT ${limit}
  `;
  return (rows as KeywordScanDbRow[]).map(rowToScan);
}

/** First-found timestamp + source for one keyword, from `appstore_keywords`. */
export interface KeywordMeta {
  readonly firstFoundAt: number;
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | "mined";
}

/**
 * Corpus metadata (`created_at`, `source`) for a single keyword — backs the
 * `GET /appstore/opportunities/:keyword` history endpoint's `meta`, so the
 * dashboard can mark a keyword's "first found" date and origin alongside its
 * scan-history chart. Returns `null` if the keyword has no corpus row (e.g.
 * it was never seeded/discovered, only ever scanned directly).
 */
export async function getKeywordMeta(keyword: string): Promise<KeywordMeta | null> {
  const db = getDb();
  const rows = await db`
    SELECT created_at, source FROM appstore_keywords WHERE keyword = ${keyword}
  `;
  const row = (rows as ReadonlyArray<{ created_at: number | string; source: string }>)[0];
  if (!row) return null;
  return {
    firstFoundAt: Number(row.created_at),
    source: row.source as KeywordMeta["source"],
  };
}

/**
 * Deactivates (`active = FALSE`) the subset of `keywords` that are
 * structurally hopeless (see `keyword-deactivation.ts`'s
 * `shouldDeactivateKeyword` — the caller evaluates that predicate and passes
 * only the keywords that should be deactivated). `source NOT IN
 * ('manual', 'seed')` is enforced HERE too, independent of the caller's own
 * check — belt + suspenders, so a caller bug can never deactivate a keyword
 * a human explicitly seeded. Reversible: only ever flips `active`, never
 * deletes. Returns the count actually deactivated (may be less than
 * `keywords.length` if some were already inactive or protected).
 */
export async function deactivateJunkKeywords(keywords: readonly string[]): Promise<number> {
  if (keywords.length === 0) return 0;
  const db = getDb();
  const rows = await db`
    UPDATE appstore_keywords
    SET active = FALSE
    WHERE keyword IN ${db(keywords)}
      AND active = TRUE
      AND source NOT IN ('manual', 'seed')
    RETURNING keyword
  `;
  return (rows as ReadonlyArray<{ keyword: string }>).length;
}

/**
 * Per-keyword stats backing `keyword-deactivation.ts`'s
 * `shouldDeactivateMinedKeyword` — the mined-pool-specific deactivation rule
 * evaluated inline during the sweep (see `keyword-gaps.ts`'s
 * `scanAndRecord`, which only calls this for `source: 'mined'` candidates so
 * the extra query cost is paid only by the pool it's meant to prune). Three
 * cheap, keyword-scoped subqueries rather than a full `getScanHistory` fetch
 * — `maxDemand` needs the WHOLE scan history, not just the most recent rows.
 */
export async function getMinedDeactivationStats(keyword: string): Promise<{
  readonly scanCount: number;
  readonly maxDemand: number;
  readonly hasSignatureHit: boolean;
}> {
  const db = getDb();
  const rows = await db`
    SELECT
      (SELECT count(*) FROM appstore_keyword_scans WHERE keyword = ${keyword}) AS scan_count,
      (SELECT max(demand) FROM appstore_keyword_scans WHERE keyword = ${keyword}) AS max_demand,
      EXISTS (SELECT 1 FROM appstore_signature_hits WHERE keyword = ${keyword}) AS has_signature_hit
  `;
  const row = (
    rows as ReadonlyArray<{
      scan_count: number | string;
      max_demand: number | string | null;
      has_signature_hit: boolean;
    }>
  )[0];
  return {
    scanCount: row ? Number(row.scan_count) : 0,
    maxDemand:
      row?.max_demand === null || row?.max_demand === undefined ? 0 : Number(row.max_demand),
    hasSignatureHit: row?.has_signature_hit === true,
  };
}

/**
 * One-time, set-based backfill of `shouldDeactivateMinedKeyword` against the
 * EXISTING mined pool (see `scraper.ts`'s `runMinedBackfillOnce` — run once
 * per process lifetime off the async keyword-sweep tick, never blocking
 * startup). A single UPDATE rather than budgeted batches: narrowing the join
 * to only currently-`active`, `source = 'mined'` keywords BEFORE aggregating
 * their scans (rather than aggregating the whole `appstore_keyword_scans`
 * table first) keeps the query's cost proportional to the CURRENT active
 * mined pool, not the full historical scan volume — and that pool only ever
 * shrinks across repeated calls (idempotent: `k.active = TRUE` in the WHERE
 * clause means a keyword already deactivated by a prior run, or by the
 * per-scan inline check, is never re-touched). The final UPDATE also
 * re-asserts `k.active = TRUE AND k.source = 'mined'` directly in its own
 * WHERE clause — belt + suspenders (mirroring `deactivateJunkKeywords`'s own
 * redundant `source NOT IN ('manual', 'seed')` check): the CTE already
 * scopes `agg` to exactly this set via the join, but the mass-write itself
 * must stay self-limiting even if that scoping/query shape ever changes,
 * rather than relying solely on the keyword PK join to stay mined-scoped.
 * Returns the count actually deactivated.
 */
export async function backfillMinedDeactivation(): Promise<number> {
  const db = getDb();
  const rows = await db`
    WITH candidates AS (
      SELECT keyword FROM appstore_keywords WHERE active = TRUE AND source = 'mined'
    ),
    agg AS (
      SELECT s.keyword AS keyword, count(*) AS scan_count, max(s.demand) AS max_demand
      FROM appstore_keyword_scans s
      JOIN candidates c ON c.keyword = s.keyword
      GROUP BY s.keyword
    )
    UPDATE appstore_keywords k
    SET active = FALSE
    FROM agg
    WHERE k.keyword = agg.keyword
      AND k.active = TRUE
      AND k.source = 'mined'
      AND agg.scan_count >= ${DEACTIVATION_MIN_SCANS}
      AND agg.max_demand < ${MINED_DEACTIVATION_MAX_DEMAND_EVER}
      AND NOT EXISTS (
        SELECT 1 FROM appstore_signature_hits h WHERE h.keyword = k.keyword
      )
    RETURNING k.keyword
  `;
  return (rows as ReadonlyArray<{ keyword: string }>).length;
}

/**
 * The `limit` stalest-by-DE-scan active seed/manual/autocomplete keywords —
 * backs the DE storefront lane's now-CHUNKED pass (Batch A budget rescue,
 * 2026-07-22 — see `keyword-gaps.ts`'s `runDeStorefrontSweep`). Deliberately
 * NARROWER than tier 1's full definition (which also admits any
 * signature-hit keyword regardless of source) — the DE lane's scope is
 * explicitly the human-curated/real-user-query corpus, not the
 * (US-calibrated) signature-hit watchlist.
 *
 * Previously unpaginated (the whole ~4,175-keyword protected pool scanned in
 * ONE pass, ~110 minutes at the live per-keyword rate — see PR #327's
 * `pass-deadline.ts`, which fixed the same class of wedge for other lanes
 * but not this one). Now ordered `last_de_scanned_at ASC NULLS FIRST` — a
 * dedicated column (migration 050) maintained by the DE lane itself
 * (`markDeScanned`), distinct from the US-cadence `last_scanned_at` this
 * lane must never touch (see `scanAndRecord`'s `markCorpusScanned` doc
 * comment) — so each chunk resumes from wherever the LAST chunk left off:
 * the staleness ordering itself is the resume cursor, no separate offset/
 * cursor state needs to be persisted. A never-DE-scanned keyword sorts first
 * (`NULLS FIRST`), so new tier-1-protected keywords get picked up promptly
 * rather than waiting behind the whole existing pool.
 */
export async function getTier1ProtectedKeywords(limit: number): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE AND source IN ('seed', 'manual', 'autocomplete')
    ORDER BY last_de_scanned_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword);
}

/**
 * Marks `keywords` as just having been DE-scanned (`last_de_scanned_at = at`)
 * — the DE storefront lane's OWN resume cursor (Batch A budget rescue,
 * 2026-07-22 — see `getTier1ProtectedKeywords`), deliberately separate from
 * `markScanned`'s `last_scanned_at`, which drives the US tier-1/mined
 * staleness cadence and must never be touched by this lane (mirrors
 * `scanAndRecord`'s existing `markCorpusScanned: false` for the DE lane).
 */
export async function markDeScanned(keywords: readonly string[], at: number): Promise<void> {
  if (keywords.length === 0) return;
  const db = getDb();
  await db`UPDATE appstore_keywords SET last_de_scanned_at = ${at} WHERE keyword IN ${db(keywords)}`;
}

// ===========================================================================
// Semantic keyword clustering (see keyword-clustering.ts + migration 038)
// ===========================================================================

/**
 * Load clusterable candidate keywords: the latest scan per keyword (DISTINCT ON
 * (keyword) — one row per keyword, matching the `appstore_keyword_clusters`
 * keyword PK), restricted to `demand >= 1`, at least 3 characters, and not
 * purely numeric/punctuation, ordered highest-demand-first. `buildability` is
 * the mirrored `BUILDABILITY_SQL` expression so labeling can fall back to it.
 * The junk/sole-generic-token prefilter is applied in TS by
 * `isClusterableKeyword` (the clustering module owns that stoplist), not here —
 * this SQL only does the cheap, index-friendly bounds.
 */
export async function selectClusterCandidateRows(): Promise<readonly RawCandidate[]> {
  const db = getDb();
  const rows = await db`
    WITH s AS (
      SELECT DISTINCT ON (keyword) *
      FROM appstore_keyword_scans
      ORDER BY keyword, scanned_at DESC
    )
    SELECT
      s.keyword AS keyword,
      s.demand AS demand,
      ${db.unsafe(BUILDABILITY_SQL)} AS buildability
    FROM s
    WHERE s.demand >= 1
      AND char_length(btrim(s.keyword)) >= 3
      AND s.keyword !~ '^[0-9[:punct:][:space:]]+$'
    ORDER BY s.demand DESC, s.keyword ASC
  `;
  return (
    rows as ReadonlyArray<{
      keyword: string;
      demand: number | string;
      buildability: number | string;
    }>
  ).map((r) => ({
    keyword: r.keyword,
    demand: Number(r.demand),
    buildability: Number(r.buildability),
  }));
}

/** Max rows per bulk INSERT — keeps each statement well under param limits. */
const CLUSTER_INSERT_CHUNK = 1000;

/**
 * Replace the ENTIRE prior cluster assignment set with `rows` in ONE
 * transaction (delete-all-then-insert), stamped with `updatedAt`. A clustering
 * run is a full recompute, so stale keywords from a prior run must not linger —
 * clearing first (rather than upserting) guarantees the table only ever holds
 * the latest run's assignments. Inserts are chunked multi-row statements.
 */
export async function replaceClusterAssignments(
  rows: readonly ClusterAssignmentRow[],
  updatedAt: number,
): Promise<void> {
  const db = getDb();
  await db.begin(async (tx) => {
    await tx`DELETE FROM appstore_keyword_clusters`;
    for (let i = 0; i < rows.length; i += CLUSTER_INSERT_CHUNK) {
      const chunk = rows.slice(i, i + CLUSTER_INSERT_CHUNK).map((r) => ({
        keyword: r.keyword,
        cluster_id: r.clusterId,
        cluster_label: r.clusterLabel,
        similarity: r.similarity,
        updated_at: updatedAt,
      }));
      if (chunk.length > 0) {
        await tx`INSERT INTO appstore_keyword_clusters ${tx(chunk)}`;
      }
    }
  });
}

/**
 * Cluster-level sort keys the concepts view can order by. Each maps to a
 * literal SQL alias produced by the `getOpportunityClusters` aggregate SELECT —
 * frozen + whitelisted exactly like `SORT_COLUMNS`, so caller input never
 * reaches ORDER BY text.
 */
export type ClusterSortKey = "maxBuildability" | "memberCount" | "avgDemand";

export const CLUSTER_SORT_KEYS = [
  "maxBuildability",
  "memberCount",
  "avgDemand",
] as const satisfies readonly ClusterSortKey[];

const CLUSTER_SORT_COLUMNS: Readonly<Record<ClusterSortKey, string>> = Object.freeze({
  maxBuildability: "max_buildability",
  memberCount: "member_count",
  avgDemand: "avg_demand",
});

/**
 * ORDER BY fragment for `getOpportunityClusters`: the whitelisted aggregate
 * column in the requested direction, then `cluster_id ASC` as a deterministic
 * tiebreaker so pagination stays stable across pages.
 */
function buildClusterOrderByClause(sort: ClusterSortKey, dir: "asc" | "desc"): string {
  const column = CLUSTER_SORT_COLUMNS[sort];
  const direction = dir === "asc" ? "ASC" : "DESC";
  return `${column} ${direction} NULLS LAST, cluster_id ASC`;
}

export interface GetOpportunityClustersOptions {
  readonly limit: number;
  readonly offset?: number;
  /** Cluster-level sort column. Default "maxBuildability". */
  readonly sort?: ClusterSortKey;
  /** Sort direction. Default "desc". */
  readonly dir?: "asc" | "desc";
  readonly trend?: GapTrend;
  readonly minDemand?: number;
  readonly maxCompetitiveness?: number;
  readonly minIncumbentWeakness?: number;
  readonly minOpportunity?: number;
  readonly minBuildability?: number;
  readonly hideJunk?: boolean;
}

/** A cluster's strongest member keywords (top by buildability). */
export interface ClusterTopMember {
  readonly keyword: string;
  readonly buildability: number;
  readonly demand: number;
  readonly opportunity: number;
}

/** One aggregated app-concept cluster for the concepts view. */
export interface OpportunityCluster {
  readonly clusterId: number;
  readonly label: string;
  readonly memberCount: number;
  readonly maxBuildability: number;
  readonly maxOpportunity: number;
  readonly avgDemand: number;
  readonly minTopAppReviews: number;
  readonly topMembers: readonly ClusterTopMember[];
}

export interface GetOpportunityClustersResult {
  readonly clusters: readonly OpportunityCluster[];
  /** Distinct cluster count after member-level filters — for pagination. */
  readonly total: number;
}

/** Max member rows returned per cluster in the aggregated concepts view. */
const CLUSTER_TOP_MEMBERS = 6;

/**
 * Build the member-level `OpportunityFilters` for the cluster queries. Clusters
 * never filter by genre zone (concepts span zones), so `genreZone` is always
 * null; every other filter mirrors `getTopOpportunities` exactly, so a member
 * keyword is included in its cluster's aggregate iff it would pass the same
 * filter on the opportunities endpoint.
 */
function clusterMemberFilters(opts: GetOpportunityClustersOptions): OpportunityFilters {
  return {
    genreZone: null,
    trend: opts.trend ?? null,
    minDemand: opts.minDemand ?? null,
    maxCompetitiveness: opts.maxCompetitiveness ?? null,
    minIncumbentWeakness: opts.minIncumbentWeakness ?? null,
    minOpportunity: opts.minOpportunity ?? null,
    minBuildability: opts.minBuildability ?? null,
    hideJunk: opts.hideJunk ?? false,
  };
}

/**
 * Aggregated app-concept clusters — backs `GET /appstore/opportunity-clusters`.
 * Joins each keyword's latest scan (DISTINCT ON (keyword)) to its cluster row,
 * applies the SAME member-level filters as `getTopOpportunities` BEFORE
 * aggregation, then groups by cluster. Each cluster carries its buildability /
 * opportunity / demand aggregates plus its top members (by buildability).
 * `total` is the distinct cluster count after filters (pre-pagination). Sorting
 * is whitelisted (`buildClusterOrderByClause`) — no caller input reaches SQL.
 */
export async function getOpportunityClusters(
  opts: GetOpportunityClustersOptions,
): Promise<GetOpportunityClustersResult> {
  const db = getDb();
  const filters = clusterMemberFilters(opts);
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? "maxBuildability";
  const dir = opts.dir ?? "desc";
  const orderByClause = buildClusterOrderByClause(sort, dir);
  const filterClause = buildFilterClause(db, filters);

  const aggregateQuery = db`
    WITH s AS (
      SELECT DISTINCT ON (keyword) *
      FROM appstore_keyword_scans
      ORDER BY keyword, scanned_at DESC
    ),
    members AS (
      SELECT
        c.cluster_id AS cluster_id,
        c.cluster_label AS cluster_label,
        s.demand AS demand,
        s.opportunity AS opportunity,
        s.top_app_reviews AS top_app_reviews,
        ${db.unsafe(BUILDABILITY_SQL)} AS buildability
      FROM s
      JOIN appstore_keyword_clusters c ON c.keyword = s.keyword
      LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
      WHERE ${filterClause}
    )
    SELECT
      cluster_id,
      cluster_label,
      count(*)::int AS member_count,
      max(buildability) AS max_buildability,
      max(opportunity) AS max_opportunity,
      avg(demand) AS avg_demand,
      min(top_app_reviews) AS min_top_app_reviews
    FROM members
    GROUP BY cluster_id, cluster_label
    ORDER BY ${db.unsafe(orderByClause)}
    LIMIT ${opts.limit} OFFSET ${offset}
  `;

  const countQuery = db`
    WITH s AS (
      SELECT DISTINCT ON (keyword) *
      FROM appstore_keyword_scans
      ORDER BY keyword, scanned_at DESC
    ),
    members AS (
      SELECT
        c.cluster_id AS cluster_id,
        ${db.unsafe(BUILDABILITY_SQL)} AS buildability
      FROM s
      JOIN appstore_keyword_clusters c ON c.keyword = s.keyword
      LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
      WHERE ${filterClause}
    )
    SELECT count(DISTINCT cluster_id)::int AS count FROM members
  `;

  const [aggRows, countRows] = await Promise.all([aggregateQuery, countQuery]);

  const clusterRows = aggRows as ReadonlyArray<{
    cluster_id: number | string;
    cluster_label: string;
    member_count: number | string;
    max_buildability: number | string | null;
    max_opportunity: number | string | null;
    avg_demand: number | string | null;
    min_top_app_reviews: number | string | null;
  }>;

  const clusterIds = clusterRows.map((r) => Number(r.cluster_id));
  const topMembersByCluster = await getClusterTopMembers(db, clusterIds, filterClause);

  const clusters: OpportunityCluster[] = clusterRows.map((r) => {
    const clusterId = Number(r.cluster_id);
    return {
      clusterId,
      label: r.cluster_label,
      memberCount: Number(r.member_count),
      maxBuildability: r.max_buildability === null ? 0 : Number(r.max_buildability),
      maxOpportunity: r.max_opportunity === null ? 0 : Number(r.max_opportunity),
      avgDemand: r.avg_demand === null ? 0 : Number(r.avg_demand),
      minTopAppReviews: r.min_top_app_reviews === null ? 0 : Number(r.min_top_app_reviews),
      topMembers: topMembersByCluster.get(clusterId) ?? [],
    };
  });

  const total = (countRows as ReadonlyArray<{ count: number | string }>)[0]?.count;

  return {
    clusters,
    total: total === undefined ? 0 : Number(total),
  };
}

/**
 * Top `CLUSTER_TOP_MEMBERS` members (by buildability) for each cluster id in
 * `clusterIds`, applying the SAME member filter clause as the aggregate query
 * so a member excluded from the aggregate can never resurface as a top member.
 * One windowed query for the whole page, grouped back into a per-cluster map.
 */
async function getClusterTopMembers(
  db: ReturnType<typeof getDb>,
  clusterIds: readonly number[],
  filterClause: ReturnType<typeof buildFilterClause>,
): Promise<ReadonlyMap<number, readonly ClusterTopMember[]>> {
  if (clusterIds.length === 0) return new Map();
  const rows = await db`
    WITH s AS (
      SELECT DISTINCT ON (keyword) *
      FROM appstore_keyword_scans
      ORDER BY keyword, scanned_at DESC
    ),
    members AS (
      SELECT
        c.cluster_id AS cluster_id,
        s.keyword AS keyword,
        s.demand AS demand,
        s.opportunity AS opportunity,
        ${db.unsafe(BUILDABILITY_SQL)} AS buildability
      FROM s
      JOIN appstore_keyword_clusters c ON c.keyword = s.keyword
      LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
      WHERE ${filterClause} AND c.cluster_id IN ${db(clusterIds)}
    ),
    ranked AS (
      SELECT
        cluster_id, keyword, demand, opportunity, buildability,
        ROW_NUMBER() OVER (
          PARTITION BY cluster_id ORDER BY buildability DESC, keyword ASC
        ) AS rn
      FROM members
    )
    SELECT cluster_id, keyword, demand, opportunity, buildability
    FROM ranked
    WHERE rn <= ${CLUSTER_TOP_MEMBERS}
    ORDER BY cluster_id ASC, buildability DESC, keyword ASC
  `;

  const byCluster = new Map<number, ClusterTopMember[]>();
  for (const row of rows as ReadonlyArray<{
    cluster_id: number | string;
    keyword: string;
    demand: number | string;
    opportunity: number | string;
    buildability: number | string;
  }>) {
    const clusterId = Number(row.cluster_id);
    const list = byCluster.get(clusterId) ?? [];
    list.push({
      keyword: row.keyword,
      demand: Number(row.demand),
      opportunity: Number(row.opportunity),
      buildability: Number(row.buildability),
    });
    byCluster.set(clusterId, list);
  }
  return byCluster;
}

export interface GetClusterMembersOptions extends GetOpportunityClustersOptions {
  readonly clusterId: number;
}

/**
 * All member keyword rows of a single cluster as full `OpportunityRow`s (the
 * same projection `getTopOpportunities` returns), for the concept expand view.
 * Applies the same member-level filters, ordered by buildability desc, bounded
 * by `limit`. Returns `[]` for an unknown cluster id.
 */
export async function getClusterMembers(
  opts: GetClusterMembersOptions,
): Promise<readonly OpportunityRow[]> {
  const db = getDb();
  const filters = clusterMemberFilters(opts);
  const filterClause = buildFilterClause(db, filters);
  const rows = await db`
    WITH s AS (
      SELECT DISTINCT ON (keyword) *
      FROM appstore_keyword_scans
      ORDER BY keyword, scanned_at DESC
    ),
    peak AS (
      SELECT keyword, MAX(opportunity) AS peak_opportunity
      FROM appstore_keyword_scans
      GROUP BY keyword
    )
    SELECT
      s.*,
      ${db.unsafe(BUILDABILITY_SQL)} AS buildability,
      peak.peak_opportunity AS peak_opportunity,
      k.created_at AS keyword_created_at,
      k.source AS keyword_source
    FROM s
    JOIN appstore_keyword_clusters c ON c.keyword = s.keyword AND c.cluster_id = ${opts.clusterId}
    LEFT JOIN peak ON peak.keyword = s.keyword
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE ${filterClause}
    ORDER BY ${db.unsafe(BUILDABILITY_SQL)} DESC, s.keyword ASC
    LIMIT ${opts.limit} OFFSET ${opts.offset ?? 0}
  `;
  return (rows as OpportunityDbRow[]).map(rowToOpportunity);
}
