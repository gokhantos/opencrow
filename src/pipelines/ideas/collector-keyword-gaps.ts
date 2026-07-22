/**
 * Keyword-gap seed collector.
 *
 * Turns high-opportunity App Store keyword gaps (produced by the keyword-gap
 * scanner, persisted in `appstore_keyword_scans`) into SIGNAL seeds for the
 * idea-synthesis pipeline. A `GapSeed` is a bare market signal — a keyword with
 * a whitespace/opportunity score — NOT a pre-formed idea. It is fed to synthesis
 * as Pass-1 context so the generator can invent ideas that address the gap; it
 * is never pushed into the SIGE `extraCandidates` channel (which carries fully
 * formed idea candidates).
 *
 * `selectGapSeeds` is pure and DB-free (unit-tested). `collectKeywordGaps` is a
 * thin DB-backed wrapper that loads the top opportunities, applies the pure
 * selector against the run's consumed-signal set, records the chosen KEYWORDS
 * into `ctx.selected` (so pipeline.ts can mark them consumed), and returns the
 * seeds. All DB work is wrapped so a failure degrades to `[]` and can never
 * break the pipeline.
 *
 * Dedup unit is the KEYWORD, not the scan row id — `getTopOpportunities`
 * returns the newest scan per keyword, so every scan cycle mints a new row id
 * for the same keyword; id-based dedup would let the same keyword re-seed on
 * every run. `GapSeed.sourceId` still carries the scan row id (the
 * audit/whitespace trail); only the consumption/dedup key is the keyword.
 */
import { createLogger } from "../../logger";
import {
  getLatestScan,
  getTopOpportunities,
  type KeywordScanRow,
  type OpportunityRow,
} from "../../sources/appstore/keyword-store";
import type { GapTrend } from "../../sources/appstore/keyword-types";
import {
  getDownweightedKeywords,
  getExcludedKeywords,
  getPipelineKilledWeights,
  getStarredKeywords,
} from "../../sources/appstore/keyword-verdict-store";
import type { CollectorContext } from "./collectors";

const log = createLogger("pipeline:collector-keyword-gaps");

/** Consumption-ledger table these seeds are drawn from / deduped against. */
export const KEYWORD_SCANS_TABLE = "appstore_keyword_scans";

/**
 * Over-fetch factor: we fetch more scans than we cap at so the threshold and
 * consumed-id filters still leave a full `limit` of fresh seeds to choose from.
 */
const FETCH_MULTIPLIER = 4;
/** Floor on the fetch bound so a tiny `limit` still samples a useful window. */
const MIN_FETCH = 100;

/**
 * A market SIGNAL derived from an App Store keyword gap — not an idea. Carries
 * enough for synthesis to reason about the whitespace (keyword + opportunity)
 * plus the provenance (`sourceId` = the scan row id) for consumption tracking.
 */
export interface GapSeed {
  readonly keyword: string;
  readonly opportunity: number;
  readonly store: "appstore";
  readonly signalType: "keyword_gap";
  readonly sourceId: string;
  /** Measured demand (ratings/day baseline + recent-velocity momentum) — see `computeDemand`. */
  readonly demand: number;
  /** Measured field crowding, 0..100 — see `computeCompetitiveness`. */
  readonly competitiveness: number;
  /** Measured incumbent-leader weakness, 0..1 — see `computeIncumbentWeakness`. */
  readonly incumbentWeakness: number;
  readonly trend: GapTrend;
  /**
   * True iff this seed's scan is `low_confidence` (migration 042 — zero
   * title-matched incumbents; the caller currently filters these out via
   * `excludeLowConfidence`, but the field is carried so the synthesis prompt
   * can annotate defensively even if a future caller relaxes that filter).
   */
  readonly lowConfidence: boolean;
}

export interface SelectGapSeedsOptions {
  /** Hard cap on how many seeds are returned (share-ceiling for synthesis). */
  readonly limit: number;
  /** Minimum opportunity score (0..1) a scan must clear to become a seed. */
  readonly minOpportunity: number;
  /**
   * Strength of the pipeline-outcome kill downweight (Batch F, F5 leg 4) —
   * see {@link selectGapSeeds}'s `killedWeights` parameter. Threaded from
   * `appstoreKeywordGap.outcomeAttribution.killDownweightStrength`; defaults
   * to {@link DEFAULT_KILL_DOWNWEIGHT_STRENGTH} when omitted (e.g. a direct
   * unit-test call).
   */
  readonly killDownweightStrength?: number;
}

export interface ZeroVolumeVetoOptions {
  /** Recorded ASA `searchPopularity` at/under this value is treated as "known dead". */
  readonly threshold: number;
  /** A reading older than this many days is ignored by the veto (stale). */
  readonly freshnessDays: number;
  readonly nowEpochSeconds: number;
}

/**
 * Batch E — ASA popularity manual-import veto (`appstoreKeywordGap.
 * excludeKnownZeroVolume` config knob, `popularity-store.ts`). PURE: drops
 * scans whose LEFT-JOINed `asaPopularity` (`getTopOpportunities`) is <=
 * `opts.threshold` AND whose `asaPopularityCheckedAt` is within the
 * freshness window — a scan with no recorded popularity, or one whose
 * reading has aged past `freshnessDays`, is left untouched (never probed, or
 * the probe is too stale to trust). This is a hard VETO on seed selection
 * only, never a scoring multiplier — see the config field's doc comment for
 * why (coverage is a handful of manually-probed keywords against the whole
 * corpus).
 */
export function filterKnownZeroVolume(
  scans: readonly OpportunityRow[],
  opts: ZeroVolumeVetoOptions,
): readonly OpportunityRow[] {
  const freshnessFloorSec = opts.nowEpochSeconds - opts.freshnessDays * 86_400;
  return scans.filter((s) => {
    if (s.asaPopularity === null || s.asaPopularityCheckedAt === null) return true;
    if (s.asaPopularityCheckedAt < freshnessFloorSec) return true; // stale — ignore veto
    return s.asaPopularity > opts.threshold;
  });
}

/** {@link collectKeywordGaps}'s options — {@link SelectGapSeedsOptions} plus the DB-backed fetch knobs. */
export interface CollectKeywordGapsOptions extends SelectGapSeedsOptions {
  /**
   * Minimum `buildability` (0..100) a scan must clear to become an
   * auto-selected seed — additive to the store/low-confidence/junk filters
   * `collectKeywordGaps` always applies (Batch F, F1). Threaded from
   * `appstoreKeywordGap.pipelineMinBuildability` by the caller. `undefined`
   * (the config default is 0) means no additional buildability filter.
   */
  readonly minBuildability?: number;
  /**
   * Explicit user-picked keywords (e.g. the dashboard's "Generate ideas from
   * these keywords" button — see `pipelines.ts`'s POST `/pipelines/:id/run`
   * `seedKeywords` body field) that are drawn AHEAD of the auto-selected
   * opportunity-ranked seeds, bypassing the opportunity-threshold sort. Each
   * is looked up by its own latest US-storefront scan (bypasses the
   * `getTopOpportunities` corpus fetch entirely) and still gated behind the
   * SAME low-confidence quality filter `excludeLowConfidence` applies to
   * auto-selected seeds — an explicit pick with no usable scan data does not
   * force its way in. Deduped, capped at `limit`, does NOT consult
   * `consumedKeywords` (an explicit request this run is not a stale reseed).
   */
  readonly seedKeywords?: readonly string[];
}

/**
 * Sort-rank discount applied to a `downweightedKeywords` member in
 * {@link selectGapSeeds} — a PIPELINE-sourced soft-downweight verdict (Batch
 * F, F5 leg 2/3: a screener "velocity alert is noise" dismissal — see
 * `keyword-verdict-store.ts`'s `getDownweightedKeywords`). Halves the
 * effective sort key rather than excluding the scan outright — it stays
 * ELIGIBLE as a seed, just outranked by an equal-opportunity keyword with no
 * such flag.
 */
const DOWNWEIGHT_SORT_FACTOR = 0.5;

/**
 * Default strength of the pipeline-outcome kill downweight (Batch F, F5 leg
 * 4) applied in {@link selectGapSeeds} when the caller doesn't supply
 * `opts.killDownweightStrength` — e.g. a direct unit-test call. Matches the
 * `appstoreKeywordGap.outcomeAttribution.killDownweightStrength` config
 * default (`schema.ts`) so the two never drift silently out of sync in the
 * common case.
 */
const DEFAULT_KILL_DOWNWEIGHT_STRENGTH = 0.35;

/**
 * Pure seed selection: drop scans below `minOpportunity`, drop scans whose
 * `keyword` is already consumed, sort by (downweight-adjusted) opportunity
 * DESC, cap at `limit`, and map to {@link GapSeed}. Never mutates `scans`.
 *
 * Dedup unit is the KEYWORD, not the scan row id: `getTopOpportunities` returns
 * the newest scan per keyword, so a new scan cycle mints a fresh row id for the
 * same keyword every time — id-based dedup would let the same keyword re-seed
 * on every run. Consumption still decays over time via the ledger's half-life,
 * so a keyword becomes eligible again once it's no longer freshly consumed.
 *
 * `downweightedKeywords` (Batch F, F5 leg 2/3 — a screener soft-dismissal
 * flag) and `killedWeights` (Batch F, F5 leg 4 — the decayed, accumulated
 * `killed_count` a keyword's exposed pipeline runs earned; see
 * `keyword-verdict-store.ts`'s `getPipelineKilledWeights`) both ONLY affect
 * SORT ORDER, never filtering — a keyword's own `opportunity` field on the
 * returned {@link GapSeed} is always the real measured value, never
 * discounted. The two downweights COMPOSE (a keyword can be both screener-
 * dismissed AND carry an outcome kill signal) via simple multiplication;
 * `killedWeights` uses a graduated `1 / (1 + killedCount * strength)` curve
 * (rather than `downweightedKeywords`'s flat halving) since it is a continuous
 * magnitude, not a boolean flag — a keyword killed across many exposed runs
 * sinks further than one killed once.
 */
export function selectGapSeeds(
  scans: readonly KeywordScanRow[],
  consumedKeywords: ReadonlySet<string>,
  opts: SelectGapSeedsOptions,
  downweightedKeywords: ReadonlySet<string> = new Set(),
  killedWeights: ReadonlyMap<string, number> = new Map(),
): readonly GapSeed[] {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
  if (limit === 0) return [];

  const killStrength = opts.killDownweightStrength ?? DEFAULT_KILL_DOWNWEIGHT_STRENGTH;
  const sortRank = (s: KeywordScanRow): number => {
    let rank = downweightedKeywords.has(s.keyword) ? s.opportunity * DOWNWEIGHT_SORT_FACTOR : s.opportunity;
    const killed = killedWeights.get(s.keyword);
    if (killed !== undefined && killed > 0) {
      rank = rank / (1 + killed * killStrength);
    }
    return rank;
  };

  return scans
    .filter((s) => s.opportunity >= opts.minOpportunity)
    .filter((s) => !consumedKeywords.has(s.keyword))
    .slice()
    .sort((a, b) => sortRank(b) - sortRank(a))
    .slice(0, limit)
    .map(scanToGapSeed);
}

/** Maps one scan row to a {@link GapSeed} — shared by the auto and priority paths. */
function scanToGapSeed(s: KeywordScanRow): GapSeed {
  return {
    keyword: s.keyword,
    opportunity: s.opportunity,
    store: "appstore",
    signalType: "keyword_gap",
    sourceId: String(s.id),
    demand: s.demand,
    competitiveness: s.competitiveness,
    incumbentWeakness: s.incumbentWeakness,
    trend: s.trend,
    lowConfidence: s.lowConfidence,
  };
}

/**
 * Resolve up to `limit` explicit `seedKeywords` into {@link GapSeed}s via their
 * own latest US-storefront scan — bypasses the opportunity-ranked corpus fetch
 * entirely (an explicit pick, not a ranking result). A keyword with no scan yet,
 * or whose latest scan is `low_confidence`, is dropped — quality-filtered the
 * same as `excludeLowConfidence` filters auto-selected seeds, so a user's pick
 * with no usable data does not force its way into the prompt. Deduped
 * (case-sensitive; callers pass raw dashboard-selected keyword strings).
 */
async function selectPriorityGapSeeds(
  seedKeywords: readonly string[],
  limit: number,
): Promise<readonly GapSeed[]> {
  if (seedKeywords.length === 0 || limit <= 0) return [];
  const uniqueKeywords = [...new Set(seedKeywords)].slice(0, limit);
  const scans = await Promise.all(uniqueKeywords.map((kw) => getLatestScan(kw, "app")));
  const seeds: GapSeed[] = [];
  for (const scan of scans) {
    if (!scan || scan.lowConfidence) continue;
    seeds.push(scanToGapSeed(scan));
  }
  return seeds;
}

/** {@link loadVerdictSignals}'s return shape. */
interface VerdictSignals {
  readonly excluded: ReadonlySet<string>;
  readonly downweighted: ReadonlySet<string>;
  readonly starred: readonly string[];
  /** Batch F, F5 leg 4 — see `getPipelineKilledWeights`. */
  readonly killedWeights: ReadonlyMap<string, number>;
}

const NO_VERDICT_SIGNALS: VerdictSignals = {
  excluded: new Set(),
  downweighted: new Set(),
  starred: [],
  killedWeights: new Map(),
};

/**
 * Load the FOUR keyword-verdict signals `collectKeywordGaps` consumes (Batch
 * F, F5 legs 2/3/4) — HARD-exclude (human dismissed/killed), SOFT-downweight
 * (pipeline dismissed), the starred watchlist (auto-pulled as priority
 * seeds), and the pipeline-outcome kill WEIGHTS (F5 leg 4 — a graduated,
 * decayed downweight distinct from the boolean screener-dismissal flag).
 * Isolated in its own try/catch so a `appstore_keyword_verdicts` failure
 * degrades to "no verdict signal" (today's pre-F5 behavior) rather than
 * losing auto-selected seeds entirely.
 */
async function loadVerdictSignals(starredLimit: number): Promise<VerdictSignals> {
  try {
    const [excluded, downweighted, starred, killedWeights] = await Promise.all([
      getExcludedKeywords(),
      getDownweightedKeywords(),
      getStarredKeywords(starredLimit),
      getPipelineKilledWeights(),
    ]);
    return { excluded, downweighted, starred, killedWeights };
  } catch (err) {
    log.warn("Keyword-verdict signal load failed; proceeding with no verdict signal", { err });
    return NO_VERDICT_SIGNALS;
  }
}

export interface CollectKeywordGapsOptions extends SelectGapSeedsOptions {
  /** Batch E: when true, drop known-dead (recorded ASA popularity <= `zeroVolumeThreshold`) keywords from seed selection. Default false (off). */
  readonly excludeKnownZeroVolume?: boolean;
  readonly zeroVolumeThreshold?: number;
  readonly zeroVolumeFreshnessDays?: number;
}

const DEFAULT_ZERO_VOLUME_THRESHOLD = 1;
const DEFAULT_ZERO_VOLUME_FRESHNESS_DAYS = 45;

/**
 * Load the top keyword opportunities, select fresh above-threshold seeds, record
 * the chosen KEYWORDS into `ctx.selected` under {@link KEYWORD_SCANS_TABLE}
 * (mirroring how `analyzeAppLandscape` registers its selections so pipeline.ts
 * can mark them consumed), and return the seeds. Graceful: any DB failure logs a
 * warning and yields `[]`.
 *
 * `ctx.consumed.get(KEYWORD_SCANS_TABLE)` is likewise a set of KEYWORDS (wired
 * by pipeline.ts via `getConsumedIds(KEYWORD_SCANS_TABLE)`, which is id-space
 * agnostic — it just returns whatever strings were previously marked consumed
 * under this table). Keeping the read and write sides in the same id-space
 * (keyword) is what makes cross-run dedup actually work — see
 * {@link selectGapSeeds}.
 *
 * Quality-filtered at the fetch (Batch F, F1): auto-selected seeds are drawn
 * ONLY from the `"app"` (US) storefront lane, excluding `low_confidence` scans
 * (zero title-matched incumbents — an unreliable fabricated-fallback estimate)
 * and junk keywords (`hideJunk` — sole-generic-word / too-short / purely
 * numeric-punctuation-whitespace keywords), same predicate the dashboard's
 * curation filters already apply. `opts.seedKeywords` (Batch F, F3 — the
 * dashboard's "Generate ideas from these keywords" watchlist) are drawn AHEAD
 * of the auto-selected pool via {@link selectPriorityGapSeeds}, sharing the
 * same `limit` ceiling and low-confidence quality gate but bypassing the
 * opportunity-ranked sort and the consumed-keyword dedup (an explicit request
 * this run, not a stale reseed).
 *
 * Verdict-aware (Batch F, F5 legs 2/3/4 — `keyword-verdict-store.ts`): the
 * server-side STARRED watchlist is auto-pulled as additional priority seeds
 * (merged with `opts.seedKeywords`); a HUMAN `dismissed`/`killed` verdict
 * HARD-excludes a keyword from the auto-selected pool; a PIPELINE (screener)
 * `dismissed` verdict only SOFT-downweights its sort rank (see
 * `DOWNWEIGHT_SORT_FACTOR`) — it stays eligible; a keyword's accumulated
 * pipeline-outcome `killed_count` (F5 leg 4 — see
 * `getPipelineKilledWeights`) applies a further graduated SOFT downweight,
 * also never a hard exclude.
 */
export async function collectKeywordGaps(
  ctx: CollectorContext,
  opts: CollectKeywordGapsOptions,
): Promise<readonly GapSeed[]> {
  try {
    const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
    if (limit === 0) return [];

    const verdicts = await loadVerdictSignals(limit);
    const priorityCandidates = [...new Set([...(opts.seedKeywords ?? []), ...verdicts.starred])];
    const priority = await selectPriorityGapSeeds(priorityCandidates, limit);
    const priorityKeywords = new Set(priority.map((s) => s.keyword));
    const remaining = limit - priority.length;

    let autoSeeds: readonly GapSeed[] = [];
    let fetchedCount = 0;
    if (remaining > 0) {
      const fetchLimit = Math.max(remaining * FETCH_MULTIPLIER, MIN_FETCH);
      const { rows: scans } = await getTopOpportunities({
        limit: fetchLimit,
        store: "app",
        excludeLowConfidence: true,
        hideJunk: true,
        minBuildability: opts.minBuildability,
      });
      fetchedCount = scans.length;
      // Batch E — ASA popularity manual-import veto, applied to the
      // auto-fetch pool before ranking/selection (see `filterKnownZeroVolume`'s
      // doc comment). `opts.seedKeywords`/`starred` priority picks bypass this
      // veto entirely — they're an explicit request, not a ranking result.
      const eligibleScans = opts.excludeKnownZeroVolume
        ? filterKnownZeroVolume(scans, {
            threshold: opts.zeroVolumeThreshold ?? DEFAULT_ZERO_VOLUME_THRESHOLD,
            freshnessDays: opts.zeroVolumeFreshnessDays ?? DEFAULT_ZERO_VOLUME_FRESHNESS_DAYS,
            nowEpochSeconds: Math.floor(Date.now() / 1000),
          })
        : scans;
      const consumedKeywords = ctx.consumed.get(KEYWORD_SCANS_TABLE) ?? new Set<string>();
      autoSeeds = selectGapSeeds(
        eligibleScans.filter(
          (s) => !priorityKeywords.has(s.keyword) && !verdicts.excluded.has(s.keyword),
        ),
        consumedKeywords,
        {
          limit: remaining,
          minOpportunity: opts.minOpportunity,
          killDownweightStrength: opts.killDownweightStrength,
        },
        verdicts.downweighted,
        verdicts.killedWeights,
      );
    }

    const seeds = [...priority, ...autoSeeds];

    if (seeds.length > 0) {
      // Record selected KEYWORDS (not scan ids) so the pipeline can mark them
      // consumed (dedup across runs, by keyword — see selectGapSeeds). ctx.selected
      // is an accumulator Map — extend the entry with a fresh array rather than
      // mutating the existing one.
      const existing = ctx.selected.get(KEYWORD_SCANS_TABLE) ?? [];
      ctx.selected.set(KEYWORD_SCANS_TABLE, [...existing, ...seeds.map((s) => s.keyword)]);
    }

    log.info("Collected keyword-gap seeds", {
      fetched: fetchedCount,
      priority: priority.length,
      selected: seeds.length,
      minOpportunity: opts.minOpportunity,
      minBuildability: opts.minBuildability,
      limit: opts.limit,
    });
    return seeds;
  } catch (err) {
    log.warn("Keyword-gap collection failed; returning no seeds", { err });
    return [];
  }
}
