/**
 * READ-ONLY backtest of the 2026-07-26 opportunity-scoring sign fix.
 *
 * Re-scores every keyword's LATEST stored `store='app'` SERP with the OLD and
 * the NEW formula and reports whether the fix actually did what it claims. It
 * issues SELECTs only — it never writes to the database, and it never fetches
 * anything from Apple.
 *
 * Usage:
 *   bun run scripts/backtest-opportunity-scoring.ts
 *   bun run scripts/backtest-opportunity-scoring.ts --limit 20000   # quick pass
 *
 * What it checks
 * --------------
 *  0. SELF-CHECK: that the frozen OLD formula in this file reproduces the
 *     `opportunity` value actually stored in the DB. If that fails, nothing
 *     else in the report can be trusted.
 *  1. The owner's own shipped-app niches must rise in PERCENTILE rank (the
 *     absolute scale of the whole corpus shifts, so only rank is meaningful).
 *  2. Game/brand terms (`real claw machine` et al.) must fall relative to them.
 *  3. `corr(opportunity, competitiveness)` must flip from +0.41 to <= 0 and
 *     `corr(opportunity, incumbent_weakness)` from -0.36 to positive.
 *
 * Honest limitations (see also the PR body)
 * -----------------------------------------
 *  - `HintEvidence.covered` is NOT persisted per scan, so every zero-presence
 *    keyword is backtested as NEVER-PROBED (neutral), never as confirmed-absent.
 *    The `hintAbsencePenalty` branch is therefore unit-tested but NOT exercised
 *    here — the backtest is generous to the new model on that one branch.
 *  - `demand` is recomputed from the stored SERP payload, so the NEW score uses
 *    a PURE ratings/day measurement while the OLD score uses the stored
 *    `demand` column, which had the retired hint multiplier baked into it. That
 *    difference IS part of the change under test, not an artifact.
 *  - Trend is taken from the stored column (recomputing it would need the full
 *    per-keyword history and would conflate two changes in one measurement).
 */

import { getErrorMessage } from "../src/lib/error-serialization";
import { createLogger } from "../src/logger";
import { GIANT_REVIEW_THRESHOLD } from "../src/sources/appstore/keyword-gaps";
import type { ScoringWeights } from "../src/sources/appstore/keyword-scoring";
import {
  computeDemand,
  computeIncumbentWeakness,
  computeOpportunity,
  DEFAULT_SCORING_WEIGHTS,
  DEMAND_REF,
  REVIEWS_REF,
  VELOCITY_REF,
  winsorizeRatingsPerDayAtP90,
} from "../src/sources/appstore/keyword-scoring";
import type { GapTrend, HintEvidence, TopApp } from "../src/sources/appstore/keyword-types";
import { getDb, initDb } from "../src/store/db";

const log = createLogger("backtest-opportunity-scoring");

const PAGE_SIZE = 2_000;

// ---------------------------------------------------------------------------
// FROZEN copy of the pre-2026-07-26 model. Deliberately duplicated here rather
// than kept alive in `keyword-scoring.ts`: the old formula is an artifact of
// this backtest, not production code, and freezing it makes the comparison
// immune to future edits of the real module.
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const norm = (x: number, ref: number): number => clamp01(Math.log1p(x) / Math.log1p(ref));
const oldAppStrength = (a: TopApp): number =>
  0.6 * norm(a.reviews, REVIEWS_REF) + 0.4 * norm(a.ratingsPerDay, VELOCITY_REF);

const TREND_MULT: Record<GapTrend, number> = {
  heating: 1.15,
  stable: 1.0,
  new: 1.0,
  cooling: 0.85,
};

const FRESH_UPDATE_DAYS = 30;
const STALE_UPDATE_DAYS = 365;

function oldLeader(apps: readonly TopApp[]): TopApp | undefined {
  if (apps.length === 0) return undefined;
  return apps.reduce((best, a) => (oldAppStrength(a) > oldAppStrength(best) ? a : best));
}

function oldUpdateStaleness(lastUpdatedDays: number | undefined): number {
  if (lastUpdatedDays === undefined) return 0;
  return clamp01((lastUpdatedDays - FRESH_UPDATE_DAYS) / (STALE_UPDATE_DAYS - FRESH_UPDATE_DAYS));
}

/** The defect-A function: rating + staleness only, review mass entirely ignored. */
function oldIncumbentWeakness(apps: readonly TopApp[]): number {
  const top = oldLeader(apps);
  if (!top) return 1;
  const ratingWeakness = clamp01((4.5 - top.rating) / 2);
  return clamp01(0.6 * ratingWeakness + 0.4 * oldUpdateStaleness(top.lastUpdatedDays));
}

/** The defect-B composition: additive beatability, capped at 0.5 when weakness is 0. */
function oldOpportunity(a: {
  readonly demand: number;
  readonly competitiveness: number;
  readonly incumbentWeakness: number;
  readonly trend: GapTrend;
}): number {
  const demandNorm = norm(a.demand, DEMAND_REF);
  const beatability = clamp01(0.5 * (1 - a.competitiveness / 100) + 0.5 * a.incumbentWeakness);
  return clamp01(demandNorm * beatability * TREND_MULT[a.trend]);
}

// ---------------------------------------------------------------------------
// Streaming statistics
// ---------------------------------------------------------------------------

/** Streaming Pearson accumulator — keeps the harness O(1) in memory per series pair. */
class Correlation {
  private n = 0;
  private sx = 0;
  private sy = 0;
  private sxy = 0;
  private sxx = 0;
  private syy = 0;

  add(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.n += 1;
    this.sx += x;
    this.sy += y;
    this.sxy += x * y;
    this.sxx += x * x;
    this.syy += y * y;
  }

  value(): number {
    if (this.n < 2) return Number.NaN;
    const cov = this.sxy / this.n - (this.sx / this.n) * (this.sy / this.n);
    const vx = this.sxx / this.n - (this.sx / this.n) ** 2;
    const vy = this.syy / this.n - (this.sy / this.n) ** 2;
    if (vx <= 0 || vy <= 0) return Number.NaN;
    return cov / Math.sqrt(vx * vy);
  }
}

/** Percentile rank of `value` within an ASCENDING sorted array, in 0..100 (higher = better). */
function percentileRank(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return (100 * lo) / sorted.length;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The owner's own shipped-app niches — these MUST rise in percentile rank. */
const OWNER_NICHES: readonly string[] = [
  "card grading",
  "card grader",
  "stock analysis",
  "shorts blocker",
  "block shorts",
  "peptide tracker",
  "peptidepal",
];

/** Corpus leaders under the OLD model — mobile games and brand terms that MUST fall. */
const GAME_BRAND_TERMS: readonly string[] = [
  "real claw machine",
  "clawee - real claw machines",
  "balatro+",
  "love and deepspace",
];

const WATCHLIST = new Set<string>([...OWNER_NICHES, ...GAME_BRAND_TERMS]);

interface ScanRow {
  readonly keyword: string;
  readonly genre_zone: string | null;
  readonly demand: number | string;
  readonly competitiveness: number | string;
  readonly incumbent_weakness: number | string;
  readonly opportunity: number | string;
  readonly trend: string;
  readonly top_app_reviews: number | string;
  readonly low_confidence: boolean;
  readonly brand_navigational: boolean;
  readonly hint_best_rank: number | string | null;
  readonly hint_seed_count: number | string | null;
  readonly top_apps: unknown;
}

interface Scored {
  readonly keyword: string;
  readonly genreZone: string;
  readonly brandNavigational: boolean;
  readonly competitiveness: number;
  readonly storedDemand: number;
  readonly rawDemand: number;
  readonly topAppReviews: number;
  readonly leaderReviews: number;
  readonly hintBestRank: number | null;
  readonly storedWeakness: number;
  readonly oldWeakness: number;
  readonly newWeakness: number;
  readonly storedOpportunity: number;
  readonly oldOpportunity: number;
  readonly newOpportunity: number;
}

function toNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

/** `top_apps` is stored DOUBLE-ENCODED for most rows (a JSON string inside JSONB). */
function parseTopApps(raw: unknown): readonly TopApp[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? (value as readonly TopApp[]) : [];
}

/**
 * Reconstructs the `relevant` set `scanKeyword` scored over: title-matched
 * incumbents, or (when nothing title-matched) the non-giant remainder.
 */
function relevantApps(topApps: readonly TopApp[]): readonly TopApp[] {
  const matched = topApps.filter((a) => a.titleMatch);
  if (matched.length > 0) return matched;
  return topApps.filter((a) => a.reviews < GIANT_REVIEW_THRESHOLD);
}

/**
 * Hint evidence reconstructed from the per-scan snapshot columns. `covered` is
 * not persisted, so zero-presence reads as NEVER-PROBED (neutral) — the
 * conservative choice; see the module doc's limitations.
 */
function snapshotHintEvidence(row: ScanRow): HintEvidence | undefined {
  if (row.hint_seed_count === null && row.hint_best_rank === null) return undefined;
  return {
    bestRank: row.hint_best_rank === null ? null : Number(row.hint_best_rank),
    seedCount: toNumber(row.hint_seed_count),
    storefrontCount: 0,
    lastSeenAt: null,
    covered: false,
  };
}

function scoreRow(row: ScanRow, weights: ScoringWeights): Scored {
  const topApps = parseTopApps(row.top_apps);
  const relevant = relevantApps(topApps);
  const competitiveness = toNumber(row.competitiveness);
  const trend = row.trend as GapTrend;
  const storedDemand = toNumber(row.demand);
  const rawDemand = computeDemand(winsorizeRatingsPerDayAtP90(relevant));
  const oldWeakness = oldIncumbentWeakness(relevant);
  const newWeakness = computeIncumbentWeakness(relevant, weights);
  const leader = oldLeader(relevant);
  const storedWeakness = toNumber(row.incumbent_weakness);

  return {
    keyword: row.keyword,
    genreZone: row.genre_zone ?? "unknown",
    brandNavigational: row.brand_navigational,
    competitiveness,
    storedDemand,
    rawDemand,
    topAppReviews: toNumber(row.top_app_reviews),
    leaderReviews: leader ? leader.reviews : 0,
    hintBestRank: row.hint_best_rank === null ? null : Number(row.hint_best_rank),
    storedWeakness,
    oldWeakness,
    newWeakness,
    storedOpportunity: toNumber(row.opportunity),
    // OLD is fed the values the scan actually stored, so it reproduces the
    // stored `opportunity` exactly — that reproduction is the self-check.
    oldOpportunity: oldOpportunity({
      demand: storedDemand,
      competitiveness,
      incumbentWeakness: storedWeakness,
      trend,
    }),
    newOpportunity: computeOpportunity(
      {
        demand: rawDemand,
        competitiveness,
        incumbentWeakness: newWeakness,
        trend,
        hint: snapshotHintEvidence(row),
      },
      weights,
    ),
  };
}

// ---------------------------------------------------------------------------
// Load + score (paginated by keyword cursor so memory stays bounded)
// ---------------------------------------------------------------------------

async function fetchPage(afterKeyword: string, limit: number): Promise<readonly ScanRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT ON (s.keyword)
      s.keyword,
      k.genre_zone,
      s.demand, s.competitiveness, s.incumbent_weakness, s.opportunity, s.trend,
      s.top_app_reviews, s.low_confidence, s.brand_navigational,
      s.hint_best_rank, s.hint_seed_count,
      CASE WHEN jsonb_typeof(s.top_apps) = 'string'
        THEN (s.top_apps #>> '{}')::jsonb ELSE s.top_apps END AS top_apps
    FROM appstore_keyword_scans s
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE s.store = 'app' AND s.keyword > ${afterKeyword}
    ORDER BY s.keyword, s.scanned_at DESC
    LIMIT ${limit}
  `;
  return rows as readonly ScanRow[];
}

interface Aggregates {
  readonly scored: number;
  readonly watchlist: readonly Scored[];
  readonly oldOpps: Float64Array;
  readonly newOpps: Float64Array;
  readonly reproMaxAbsErr: number;
  readonly reproWithin1e4: number;
  readonly rawDemandMatches: number;
  readonly weaknessReconMatches: number;
  readonly zeroOldWeakness: number;
  readonly zeroNewWeakness: number;
  readonly corr: Readonly<Record<string, number>>;
  readonly top500Old: readonly Scored[];
  readonly top500New: readonly Scored[];
}

/** Keeps the running top-`k` by `key` without holding the whole corpus. */
function pushTopK(heap: Scored[], row: Scored, k: number, key: (s: Scored) => number): void {
  heap.push(row);
  if (heap.length > k * 2) {
    heap.sort((a, b) => key(b) - key(a));
    heap.length = k;
  }
}

async function run(maxKeywords: number, weights: ScoringWeights): Promise<Aggregates> {
  const oldList: number[] = [];
  const newList: number[] = [];
  const watchlist: Scored[] = [];
  const topOld: Scored[] = [];
  const topNew: Scored[] = [];

  const corrOldComp = new Correlation();
  const corrOldWeak = new Correlation();
  const corrOldReviews = new Correlation();
  const corrNewComp = new Correlation();
  const corrNewWeak = new Correlation();
  const corrNewReviews = new Correlation();

  let cursor = "";
  let scored = 0;
  let reproMaxAbsErr = 0;
  let reproWithin1e4 = 0;
  let rawDemandMatches = 0;
  let weaknessReconMatches = 0;
  let zeroOldWeakness = 0;
  let zeroNewWeakness = 0;

  for (;;) {
    const page = await fetchPage(cursor, Math.min(PAGE_SIZE, maxKeywords - scored));
    if (page.length === 0) break;
    for (const row of page) {
      const s = scoreRow(row, weights);
      scored += 1;
      oldList.push(s.oldOpportunity);
      newList.push(s.newOpportunity);

      const err = Math.abs(s.oldOpportunity - s.storedOpportunity);
      if (err > reproMaxAbsErr) reproMaxAbsErr = err;
      if (err <= 1e-4) reproWithin1e4 += 1;
      if (Math.abs(s.rawDemand - s.storedDemand) <= 1e-3 * Math.max(1, s.storedDemand)) {
        rawDemandMatches += 1;
      }
      if (Math.abs(s.oldWeakness - s.storedWeakness) <= 1e-3) weaknessReconMatches += 1;
      if (s.storedWeakness < 0.005) zeroOldWeakness += 1;
      if (s.newWeakness < 0.005) zeroNewWeakness += 1;

      corrOldComp.add(s.oldOpportunity, s.competitiveness);
      corrOldWeak.add(s.oldOpportunity, s.storedWeakness);
      corrOldReviews.add(s.oldOpportunity, Math.log1p(s.topAppReviews));
      corrNewComp.add(s.newOpportunity, s.competitiveness);
      corrNewWeak.add(s.newOpportunity, s.newWeakness);
      corrNewReviews.add(s.newOpportunity, Math.log1p(s.topAppReviews));

      pushTopK(topOld, s, 500, (x) => x.oldOpportunity);
      pushTopK(topNew, s, 500, (x) => x.newOpportunity);
      if (WATCHLIST.has(s.keyword)) watchlist.push(s);
    }
    cursor = (page[page.length - 1] as ScanRow).keyword;
    if (scored >= maxKeywords) break;
    if (scored % 20_000 < PAGE_SIZE) log.info("Scored keywords", { scored });
  }

  topOld.sort((a, b) => b.oldOpportunity - a.oldOpportunity);
  topNew.sort((a, b) => b.newOpportunity - a.newOpportunity);

  const oldOpps = Float64Array.from(oldList).sort();
  const newOpps = Float64Array.from(newList).sort();

  return {
    scored,
    watchlist,
    oldOpps,
    newOpps,
    reproMaxAbsErr,
    reproWithin1e4,
    rawDemandMatches,
    weaknessReconMatches,
    zeroOldWeakness,
    zeroNewWeakness,
    corr: {
      oldComp: corrOldComp.value(),
      oldWeak: corrOldWeak.value(),
      oldReviews: corrOldReviews.value(),
      newComp: corrNewComp.value(),
      newWeak: corrNewWeak.value(),
      newReviews: corrNewReviews.value(),
    },
    top500Old: topOld.slice(0, 500),
    top500New: topNew.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const f = (x: number, digits = 4): string => (Number.isFinite(x) ? x.toFixed(digits) : "n/a");
const pad = (s: string, width: number): string =>
  s.length >= width ? s.slice(0, width) : s.padEnd(width);
const padStart = (s: string, width: number): string => s.padStart(width);

function zoneShare(rows: readonly Scored[], zone: string): number {
  if (rows.length === 0) return 0;
  return (100 * rows.filter((r) => r.genreZone === zone).length) / rows.length;
}

function report(agg: Aggregates): boolean {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("=".repeat(112));
  push(`OPPORTUNITY SCORING BACKTEST — ${agg.scored.toLocaleString()} keywords (latest store='app' scan each)`);
  push("=".repeat(112));
  push();

  // --- 0. self-check -------------------------------------------------------
  push("0. SELF-CHECK — does the frozen OLD formula reproduce the stored `opportunity`?");
  const reproPct = (100 * agg.reproWithin1e4) / agg.scored;
  push(`   within 1e-4 of the stored value : ${f(reproPct, 3)}%  (${agg.reproWithin1e4.toLocaleString()}/${agg.scored.toLocaleString()})`);
  push(`   max absolute error              : ${f(agg.reproMaxAbsErr, 8)}`);
  push(`   recomputed demand == stored     : ${f((100 * agg.rawDemandMatches) / agg.scored, 3)}%  (rest = rows where the retired hint multiplier was applied)`);
  push(`   SERP-recon weakness == stored   : ${f((100 * agg.weaknessReconMatches) / agg.scored, 3)}%  (how faithfully the stored SERP payload reproduces the scan's own scoring set)`);
  const reproOk = reproPct >= 99;
  push(`   => ${reproOk ? "OK — the old model is faithfully reproduced" : "FAILED — treat everything below as unreliable"}`);
  push();

  // --- 1. watchlist --------------------------------------------------------
  push("1. WATCHLIST — owner niches vs corpus leaders (percentile rank, higher = better)");
  push(
    `   ${pad("keyword", 30)}${padStart("old opp", 9)}${padStart("old pct", 9)}${padStart("new opp", 9)}${padStart("new pct", 9)}${padStart("d pct", 8)}${padStart("weak o->n", 16)}${padStart("comp", 7)}${padStart("leaderRev", 11)}${padStart("rank", 6)}`,
  );
  push(`   ${"-".repeat(114)}`);

  const byKeyword = new Map(agg.watchlist.map((w) => [w.keyword, w]));
  const deltas = new Map<string, number>();
  const emit = (keyword: string) => {
    const w = byKeyword.get(keyword);
    if (!w) {
      push(`   ${pad(keyword, 30)}${padStart("— not in corpus —", 30)}`);
      return;
    }
    const oldPct = percentileRank(agg.oldOpps, w.oldOpportunity);
    const newPct = percentileRank(agg.newOpps, w.newOpportunity);
    deltas.set(keyword, newPct - oldPct);
    const dPct = newPct - oldPct;
    push(
      `   ${pad(keyword, 30)}${padStart(f(w.oldOpportunity), 9)}${padStart(f(oldPct, 2), 9)}${padStart(f(w.newOpportunity), 9)}${padStart(f(newPct, 2), 9)}${padStart(`${dPct >= 0 ? "+" : ""}${f(dPct, 2)}`, 8)}${padStart(`${f(w.oldWeakness, 3)} -> ${f(w.newWeakness, 3)}`, 16)}${padStart(f(w.competitiveness, 1), 7)}${padStart(w.leaderReviews.toLocaleString(), 11)}${padStart(w.hintBestRank === null ? "-" : String(w.hintBestRank), 6)}`,
    );
  };

  push("   -- owner's shipped-app niches --");
  for (const k of OWNER_NICHES) emit(k);
  push("   -- corpus leaders under the OLD model (games / brand terms) --");
  for (const k of GAME_BRAND_TERMS) emit(k);
  push();

  // --- 2. correlations -----------------------------------------------------
  push("2. CORRELATIONS — the sign of the model");
  push(`   ${pad("pair", 44)}${padStart("OLD", 10)}${padStart("NEW", 10)}   verdict`);
  push(`   ${"-".repeat(80)}`);
  const compOk = agg.corr.newComp !== undefined && (agg.corr.newComp as number) <= 0;
  const weakOk = agg.corr.newWeak !== undefined && (agg.corr.newWeak as number) > 0;
  push(
    `   ${pad("corr(opportunity, competitiveness)", 44)}${padStart(f(agg.corr.oldComp as number), 10)}${padStart(f(agg.corr.newComp as number), 10)}   ${compOk ? "PASS (<= 0)" : "FAIL (> 0)"}`,
  );
  push(
    `   ${pad("corr(opportunity, incumbent_weakness)", 44)}${padStart(f(agg.corr.oldWeak as number), 10)}${padStart(f(agg.corr.newWeak as number), 10)}   ${weakOk ? "PASS (> 0)" : "FAIL (<= 0)"}`,
  );
  push(
    `   ${pad("corr(opportunity, ln(1+top_app_reviews))", 44)}${padStart(f(agg.corr.oldReviews as number), 10)}${padStart(f(agg.corr.newReviews as number), 10)}   (informational)`,
  );
  push();
  push(
    `   incumbent_weakness == 0.00 : OLD ${f((100 * agg.zeroOldWeakness) / agg.scored, 2)}%  ->  NEW ${f((100 * agg.zeroNewWeakness) / agg.scored, 2)}%`,
  );
  push(
    `   max(opportunity)           : OLD ${f(agg.oldOpps[agg.oldOpps.length - 1] as number)}  ->  NEW ${f(agg.newOpps[agg.newOpps.length - 1] as number)}`,
  );
  push();

  // --- 3. top-500 composition ---------------------------------------------
  push("3. TOP-500 COMPOSITION — what the model actually surfaces");
  const zones = [...new Set([...agg.top500Old, ...agg.top500New].map((r) => r.genreZone))].sort();
  push(`   ${pad("genre zone", 24)}${padStart("OLD top-500 %", 15)}${padStart("NEW top-500 %", 15)}`);
  push(`   ${"-".repeat(54)}`);
  for (const zone of zones) {
    const o = zoneShare(agg.top500Old, zone);
    const n = zoneShare(agg.top500New, zone);
    if (o < 1 && n < 1) continue;
    push(`   ${pad(zone, 24)}${padStart(f(o, 2), 15)}${padStart(f(n, 2), 15)}`);
  }
  const brandOld = (100 * agg.top500Old.filter((r) => r.brandNavigational).length) / Math.max(1, agg.top500Old.length);
  const brandNew = (100 * agg.top500New.filter((r) => r.brandNavigational).length) / Math.max(1, agg.top500New.length);
  push(`   ${pad("brand-navigational", 24)}${padStart(f(brandOld, 2), 15)}${padStart(f(brandNew, 2), 15)}`);
  push();

  push("   TOP 15 under OLD:");
  for (const r of agg.top500Old.slice(0, 15)) {
    push(`     ${pad(r.keyword, 34)} old=${f(r.oldOpportunity)}  new=${f(r.newOpportunity)}  zone=${pad(r.genreZone, 14)} leaderRev=${r.leaderReviews.toLocaleString()}`);
  }
  push("   TOP 15 under NEW:");
  for (const r of agg.top500New.slice(0, 15)) {
    push(`     ${pad(r.keyword, 34)} new=${f(r.newOpportunity)}  old=${f(r.oldOpportunity)}  zone=${pad(r.genreZone, 14)} leaderRev=${r.leaderReviews.toLocaleString()}`);
  }
  push();

  // --- 4. verdicts ---------------------------------------------------------
  push("4. SUCCESS CRITERIA");
  const ownerDeltas = OWNER_NICHES.map((k) => deltas.get(k)).filter(
    (d): d is number => d !== undefined,
  );
  const ownerUp = ownerDeltas.filter((d) => d > 0).length;
  const ownerAllUp = ownerDeltas.length > 0 && ownerUp === ownerDeltas.length;
  push(
    `   [${ownerAllUp ? "PASS" : "PARTIAL"}] owner niches rise in percentile rank: ${ownerUp}/${ownerDeltas.length} up`,
  );
  for (const k of OWNER_NICHES) {
    const d = deltas.get(k);
    if (d === undefined) continue;
    push(`            ${pad(k, 24)} ${d >= 0 ? "+" : ""}${f(d, 2)} pct pts`);
  }

  const gameDeltas = GAME_BRAND_TERMS.map((k) => [k, deltas.get(k)] as const).filter(
    (e): e is readonly [string, number] => e[1] !== undefined,
  );
  const gamesDown = gameDeltas.filter(([, d]) => d < 0).length;
  const gamesAllDown = gameDeltas.length > 0 && gamesDown === gameDeltas.length;
  push(
    `   [${gamesAllDown ? "PASS" : "PARTIAL"}] game/brand terms fall in percentile rank: ${gamesDown}/${gameDeltas.length} down`,
  );
  for (const [k, d] of gameDeltas) {
    push(`            ${pad(k, 24)} ${d >= 0 ? "+" : ""}${f(d, 2)} pct pts`);
  }

  // Relative movement: every owner niche must end up above every game/brand term.
  const worstOwner = Math.min(
    ...OWNER_NICHES.map((k) => byKeyword.get(k))
      .filter((w): w is Scored => w !== undefined)
      .map((w) => percentileRank(agg.newOpps, w.newOpportunity)),
  );
  const bestGame = Math.max(
    ...GAME_BRAND_TERMS.map((k) => byKeyword.get(k))
      .filter((w): w is Scored => w !== undefined)
      .map((w) => percentileRank(agg.newOpps, w.newOpportunity)),
  );
  push(
    `   [${worstOwner > bestGame ? "PASS" : "PARTIAL"}] worst owner niche (${f(worstOwner, 2)} pct) vs best game/brand term (${f(bestGame, 2)} pct)`,
  );
  push(`   [${compOk ? "PASS" : "FAIL"}] corr(opportunity, competitiveness) <= 0`);
  push(`   [${weakOk ? "PASS" : "FAIL"}] corr(opportunity, incumbent_weakness) > 0`);
  push();
  push("NOTE: the 0.15 / 0.50 opportunity thresholds were NOT recalibrated by this change.");
  push("=".repeat(112));

  process.stdout.write(`${lines.join("\n")}\n`);
  return reproOk && compOk && weakOk && ownerAllUp && gamesAllDown;
}

// ---------------------------------------------------------------------------

/**
 * `--set key=value` (repeatable) overrides a single `ScoringWeights` field, so a
 * parameter sweep can be run from the shell without editing the defaults.
 */
function resolveWeights(argv: readonly string[]): ScoringWeights {
  const overrides: Record<string, number> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--set") continue;
    const pair = argv[i + 1];
    if (pair === undefined) continue;
    const [key, raw] = pair.split("=");
    if (key === undefined || raw === undefined) continue;
    if (!(key in DEFAULT_SCORING_WEIGHTS)) {
      throw new Error(`Unknown scoring weight: ${key}`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Non-numeric value for ${key}: ${raw}`);
    overrides[key] = value;
  }
  return { ...DEFAULT_SCORING_WEIGHTS, ...overrides };
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const maxKeywords =
    limitArg >= 0 && process.argv[limitArg + 1] !== undefined
      ? Number(process.argv[limitArg + 1])
      : Number.POSITIVE_INFINITY;
  const weights = resolveWeights(process.argv);
  log.info("Scoring weights under test", { weights });

  await initDb();
  const agg = await run(Number.isFinite(maxKeywords) ? maxKeywords : 10_000_000, weights);
  const allPassed = report(agg);
  if (!allPassed) {
    log.warn("Not every success criterion was met — see the report above; do NOT tune to fit.");
  }
}

main().catch((err) => {
  log.error("Backtest failed", { error: getErrorMessage(err) });
  process.exit(1);
});
