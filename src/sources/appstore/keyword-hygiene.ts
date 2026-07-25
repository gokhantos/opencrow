// Corpus-hygiene passes for the App Store keyword scanner (2026-07-25): the
// I/O orchestration that pairs the PURE decision modules
// (`keyword-retirement.ts`, `keyword-zones.ts`) with the store layer
// (`keyword-store.ts`). Both passes are DB-only — no Apple requests, nothing
// fed into `sweep-throttle.ts` — and both are bounded, resumable and
// idempotent:
//
//   - bounded: each pass evaluates at most `batchSize` keywords;
//   - resumable: each keyword carries its own cursor column
//     (`retirement_checked_at` / `genre_zone_derived_at`) which the pass
//     stamps for EVERY keyword it looked at, fired or not, and selection is
//     ordered by that cursor `ASC NULLS FIRST` — so successive passes walk the
//     whole corpus and then idle, with no separate offset state to persist and
//     nothing lost if a pass dies halfway;
//   - idempotent: retirement never restamps an already-retired keyword (its
//     `retired_at IS NULL` guard preserves the FIRST retirement's audit
//     trail), and re-deriving a zone rewrites the same value.
//
// Config-free by construction: every knob is an injected parameter, so both
// passes are exhaustively testable against fixed inputs. `scraper.ts`'s
// `runKeywordRetirementIfDue` / `runZoneDerivationIfDue` read
// `appstoreJunkDeactivation.retirement` / `.zoneDerivation` and pass the
// values in, matching how `getStaleKeywordsTiered` already keeps
// `keyword-store.ts` config-free.

import { createLogger } from "../../logger";
import { buildBrandSegmentSet } from "./keyword-brand";
import {
  applyDerivedZones,
  type DerivedZoneWrite,
  getScannedAppNames,
  markRetirementChecked,
  retireKeywords,
  selectRetirementCandidateRows,
  selectZoneDerivationRows,
} from "./keyword-store";
import {
  type RetirementReason,
  type RetirementRules,
  decideRetirement,
} from "./keyword-retirement";
import { deriveGenreZone } from "./keyword-zones";

const logger = createLogger("appstore:keyword-hygiene");

/**
 * How many recent app titles the brand-segment set is built from — the same
 * pool size `keyword-autocomplete.ts`'s `expandCorpus` uses for the identical
 * `buildBrandSegmentSet` call, so the retroactive `brand-lexical` retirement
 * rule and the insert-time filter judge candidates against the SAME set of
 * known brand names rather than two differently-sized samples.
 */
const BRAND_SEGMENT_APP_NAME_LIMIT = 2000;

export interface RetirementPassResult {
  /** Keywords evaluated (and cursor-stamped) this pass. */
  readonly evaluated: number;
  /** Keywords actually retired (rows changed). */
  readonly retired: number;
  readonly byReason: Readonly<Record<string, number>>;
}

/**
 * One bounded retirement pass: reads the next `batchSize` keywords due for a
 * decision, evaluates the PURE `decideRetirement` against each, writes the
 * ones that fired, and stamps the cursor on all of them.
 *
 * The brand-segment set is built ONCE per pass (not per candidate) from the
 * broad, continuously-refreshed scanned-app-name pool — same discipline as
 * `expandCorpus`.
 *
 * Nothing here reads `opportunity`, and nothing reads `demand` unless the
 * caller explicitly enabled `rules.scoreBased` (off in
 * `DEFAULT_RETIREMENT_RULES`, off in the config default, and documented as
 * unsafe until the scoring model is fixed and recalibrated — see
 * `keyword-retirement.ts`).
 */
export async function runRetirementPass(opts: {
  readonly batchSize: number;
  readonly rules: RetirementRules;
  readonly nowSeconds: number;
}): Promise<RetirementPassResult> {
  const empty: RetirementPassResult = { evaluated: 0, retired: 0, byReason: {} };
  if (opts.batchSize <= 0) return empty;

  const candidates = await selectRetirementCandidateRows(opts.batchSize);
  if (candidates.length === 0) return empty;

  const brandSegments = buildBrandSegmentSet(
    await getScannedAppNames(BRAND_SEGMENT_APP_NAME_LIMIT),
  );

  const decisions: Array<{ keyword: string; reason: RetirementReason }> = [];
  for (const row of candidates) {
    const reason = decideRetirement(
      {
        keyword: row.keyword,
        source: row.source,
        serp:
          row.fieldSize > 0
            ? {
                fieldSize: row.fieldSize,
                exactBrandTitleCount: row.exactBrandTitleCount,
                rankOneExactBrandTitle: row.rankOneExactBrandTitle,
                rankOneReviewShare: row.rankOneReviewShare,
              }
            : null,
        // The tri-state probe record is not persisted yet (a sibling change to
        // `keyword-autocomplete.ts` owns it). `never-probed` is the honest
        // value until then, and it can never fire a retirement — absence of a
        // probe is not evidence of absent demand.
        autocompleteProbe: "never-probed",
        score: {
          demand: row.demand,
          topAppReviews: row.topAppReviews,
          scanCount: row.scanCount,
        },
      },
      opts.rules,
      brandSegments,
    );
    // A keyword on the signature-hit watchlist is exempt from every rule: an
    // operator (or the screener) has flagged it as worth watching, which
    // outranks a heuristic. Mirrors the same exemption
    // `shouldDeactivateMinedKeyword`/`shouldDeactivateForHintAbsence` already
    // apply in `keyword-deactivation.ts`.
    if (reason !== null && !row.hasSignatureHit) {
      decisions.push({ keyword: row.keyword, reason });
    }
  }

  const retired = await retireKeywords(decisions, opts.nowSeconds);
  await markRetirementChecked(
    candidates.map((c) => c.keyword),
    opts.nowSeconds,
  );

  const byReason: Record<string, number> = {};
  for (const decision of decisions) {
    byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1;
  }

  logger.info("Keyword retirement pass complete", {
    evaluated: candidates.length,
    retired,
    byReason,
  });
  return { evaluated: candidates.length, retired, byReason };
}

export interface ZoneDerivationPassResult {
  readonly evaluated: number;
  /** Keywords that got a real zone. */
  readonly classified: number;
  /** Keywords honestly recorded as NULL — no incumbents, or below the confidence floor. */
  readonly unclassified: number;
}

/**
 * One bounded zone-derivation pass: reads the next `batchSize` active keywords
 * due for derivation with their SERP incumbents' real category labels, runs the
 * PURE `deriveGenreZone` over each, and writes the result — including the NULLs.
 *
 * Writing the NULLs is the point, twice over: it is the honest label for a
 * keyword whose field cannot be classified, AND it advances the cursor past
 * that keyword so the pass makes progress instead of re-deriving the same
 * unclassifiable head forever. The legacy `genre_zone` column is never touched.
 */
export async function runZoneDerivationPass(opts: {
  readonly batchSize: number;
  readonly nowSeconds: number;
}): Promise<ZoneDerivationPassResult> {
  const empty: ZoneDerivationPassResult = { evaluated: 0, classified: 0, unclassified: 0 };
  if (opts.batchSize <= 0) return empty;

  const rows = await selectZoneDerivationRows(opts.batchSize);
  if (rows.length === 0) return empty;

  const writes: DerivedZoneWrite[] = rows.map((row) => {
    const derived = deriveGenreZone(row.genres);
    return {
      keyword: row.keyword,
      zone: derived === null ? null : derived.zone,
      confidence: derived === null ? null : derived.confidence,
    };
  });

  await applyDerivedZones(writes, opts.nowSeconds);

  const classified = writes.filter((w) => w.zone !== null).length;
  logger.info("Keyword zone-derivation pass complete", {
    evaluated: rows.length,
    classified,
    unclassified: rows.length - classified,
  });
  return {
    evaluated: rows.length,
    classified,
    unclassified: rows.length - classified,
  };
}
