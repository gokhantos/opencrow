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
import { getTopOpportunities, type KeywordScanRow } from "../../sources/appstore/keyword-store";
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
}

export interface SelectGapSeedsOptions {
  /** Hard cap on how many seeds are returned (share-ceiling for synthesis). */
  readonly limit: number;
  /** Minimum opportunity score (0..1) a scan must clear to become a seed. */
  readonly minOpportunity: number;
}

/**
 * Pure seed selection: drop scans below `minOpportunity`, drop scans whose
 * `keyword` is already consumed, sort by opportunity DESC, cap at `limit`, and
 * map to {@link GapSeed}. Never mutates `scans`.
 *
 * Dedup unit is the KEYWORD, not the scan row id: `getTopOpportunities` returns
 * the newest scan per keyword, so a new scan cycle mints a fresh row id for the
 * same keyword every time — id-based dedup would let the same keyword re-seed
 * on every run. Consumption still decays over time via the ledger's half-life,
 * so a keyword becomes eligible again once it's no longer freshly consumed.
 */
export function selectGapSeeds(
  scans: readonly KeywordScanRow[],
  consumedKeywords: ReadonlySet<string>,
  opts: SelectGapSeedsOptions,
): readonly GapSeed[] {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
  if (limit === 0) return [];

  return scans
    .filter((s) => s.opportunity >= opts.minOpportunity)
    .filter((s) => !consumedKeywords.has(s.keyword))
    .slice()
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, limit)
    .map(
      (s): GapSeed => ({
        keyword: s.keyword,
        opportunity: s.opportunity,
        store: "appstore",
        signalType: "keyword_gap",
        sourceId: String(s.id),
      }),
    );
}

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
 */
export async function collectKeywordGaps(
  ctx: CollectorContext,
  opts: SelectGapSeedsOptions,
): Promise<readonly GapSeed[]> {
  try {
    const fetchLimit = Math.max(Math.floor(opts.limit) * FETCH_MULTIPLIER, MIN_FETCH);
    const scans = await getTopOpportunities({ limit: fetchLimit });
    const consumedKeywords = ctx.consumed.get(KEYWORD_SCANS_TABLE) ?? new Set<string>();
    const seeds = selectGapSeeds(scans, consumedKeywords, opts);

    if (seeds.length > 0) {
      // Record selected KEYWORDS (not scan ids) so the pipeline can mark them
      // consumed (dedup across runs, by keyword — see selectGapSeeds). ctx.selected
      // is an accumulator Map — extend the entry with a fresh array rather than
      // mutating the existing one.
      const existing = ctx.selected.get(KEYWORD_SCANS_TABLE) ?? [];
      ctx.selected.set(KEYWORD_SCANS_TABLE, [...existing, ...seeds.map((s) => s.keyword)]);
    }

    log.info("Collected keyword-gap seeds", {
      fetched: scans.length,
      selected: seeds.length,
      minOpportunity: opts.minOpportunity,
      limit: opts.limit,
    });
    return seeds;
  } catch (err) {
    log.warn("Keyword-gap collection failed; returning no seeds", { err });
    return [];
  }
}
