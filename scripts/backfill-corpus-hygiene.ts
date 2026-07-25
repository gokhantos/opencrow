/**
 * Backfill driver for the two corpus-hygiene passes (migration 057):
 * PERMANENT keyword retirement (`keyword-retirement.ts`) and HONEST derived
 * genre zones (`keyword-zones.ts`).
 *
 * The scanner runs both passes continuously off its own ~6h cadence gates
 * (`scraper.ts`'s `runKeywordRetirementIfDue` / `runZoneDerivationIfDue`), so
 * this script exists for two things the sweep can't do:
 *
 *   1. DRY RUN (the default) — report what the enabled rules would do to the
 *      head of each pass's cursor WITHOUT writing anything, so an operator can
 *      review before flipping `appstoreJunkDeactivation.retirement.enabled` on.
 *   2. DRAIN — walk the WHOLE corpus in one sitting (`--apply`) instead of
 *      waiting ~6h per `batchSize` chunk.
 *
 * SAFE TO RUN: dry-run is the default and writes nothing at all — not even a
 * cursor stamp. `--apply` runs the exact same passes the scanner runs, which
 * are bounded, resumable and IDEMPOTENT: retirement never restamps an
 * already-retired keyword (preserving the first retirement's audit trail),
 * re-deriving a zone rewrites the same value, and neither pass ever touches the
 * legacy `genre_zone` column or a `source: 'manual'`/`'seed'` row's active
 * state. Nothing is ever DELETED — retirement only ever adds a timestamp and a
 * reason, and un-retiring is one UPDATE (see migration 057).
 *
 * NOTE on the dry-run report: because a dry run writes no cursor stamps, it can
 * only inspect the CURRENT HEAD of each cursor — it is a `--limit`-sized SAMPLE
 * of the pass's next batch, not a whole-corpus projection. That is stated in the
 * output so the numbers are never mistaken for corpus totals.
 *
 * IMPORTANT: nothing this script enables keys on the `opportunity` or `demand`
 * score. The score-based retirement rule is read from config and ships
 * DISABLED; see `keyword-retirement.ts`'s `shouldRetireByScore` for why.
 *
 * Usage:
 *   bun run scripts/backfill-corpus-hygiene.ts                       # dry run, both lanes
 *   bun run scripts/backfill-corpus-hygiene.ts --lane=zones          # dry run, zones only
 *   bun run scripts/backfill-corpus-hygiene.ts --lane=retirement
 *   bun run scripts/backfill-corpus-hygiene.ts --apply               # drain both lanes
 *   bun run scripts/backfill-corpus-hygiene.ts --apply --limit=5000  # bigger chunks
 */

import { loadConfig } from "../src/config/loader";
import { getErrorMessage } from "../src/lib/error-serialization";
import { createLogger } from "../src/logger";
import { buildBrandSegmentSet } from "../src/sources/appstore/keyword-brand";
import {
  runRetirementPass,
  runZoneDerivationPass,
} from "../src/sources/appstore/keyword-hygiene";
import {
  decideRetirement,
  type RetirementRules,
} from "../src/sources/appstore/keyword-retirement";
import {
  getDerivedZoneDistribution,
  getRetirementStats,
  getScannedAppNames,
  selectRetirementCandidateRows,
  selectZoneDerivationRows,
} from "../src/sources/appstore/keyword-store";
import { deriveGenreZone } from "../src/sources/appstore/keyword-zones";
import { initDb } from "../src/store/db";

const log = createLogger("backfill-corpus-hygiene");

const SAMPLE_SIZE = 20;
/** Safety bound on `--apply` chunks per lane — `maxChunks * limit` far exceeds the corpus. */
const MAX_CHUNKS = 500;

type Lane = "zones" | "retirement" | "both";

interface Args {
  readonly apply: boolean;
  readonly lane: Lane;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const laneArg = argv.find((a) => a.startsWith("--lane="))?.slice("--lane=".length);
  const lane: Lane = laneArg === "zones" || laneArg === "retirement" ? laneArg : "both";
  const limitArg = argv.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
  const parsedLimit = limitArg === undefined ? Number.NaN : Number.parseInt(limitArg, 10);
  return {
    apply: argv.includes("--apply"),
    lane,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 2_000,
  };
}

function rulesFromConfig(): RetirementRules {
  const cfg = loadConfig().appstoreJunkDeactivation.retirement;
  return {
    structuralJunk: cfg.structuralJunk,
    brandLexical: cfg.brandLexical,
    brandSerpShape: cfg.brandSerpShape,
    autocompleteProbedAbsent: cfg.autocompleteProbedAbsent,
    scoreBased: cfg.scoreBased,
  };
}

async function dryRunRetirement(limit: number, rules: RetirementRules): Promise<void> {
  const candidates = await selectRetirementCandidateRows(limit);
  const brandSegments = buildBrandSegmentSet(await getScannedAppNames(2000));

  const byReason = new Map<string, string[]>();
  for (const row of candidates) {
    if (row.hasSignatureHit) continue;
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
        autocompleteProbe: "never-probed",
        score: { demand: row.demand, topAppReviews: row.topAppReviews, scanCount: row.scanCount },
      },
      rules,
      brandSegments,
    );
    if (reason === null) continue;
    const existing = byReason.get(reason) ?? [];
    existing.push(row.keyword);
    byReason.set(reason, existing);
  }

  const wouldRetire = [...byReason.values()].reduce((sum, ks) => sum + ks.length, 0);
  log.info("DRY RUN retirement — sample of the cursor head, NOT a corpus total", {
    rules,
    sampled: candidates.length,
    wouldRetire,
    byReason: Object.fromEntries([...byReason].map(([reason, ks]) => [reason, ks.length])),
  });
  for (const [reason, keywords] of byReason) {
    log.info(`  sample: ${reason}`, { keywords: keywords.slice(0, SAMPLE_SIZE) });
  }
}

async function dryRunZones(limit: number): Promise<void> {
  const rows = await selectZoneDerivationRows(limit);
  const byZone = new Map<string, number>();
  let unclassified = 0;
  const samples: string[] = [];

  for (const row of rows) {
    const derived = deriveGenreZone(row.genres);
    if (derived === null) {
      unclassified++;
      continue;
    }
    byZone.set(derived.zone, (byZone.get(derived.zone) ?? 0) + 1);
    if (samples.length < SAMPLE_SIZE) {
      samples.push(`${row.keyword} -> ${derived.zone} (${derived.confidence.toFixed(2)})`);
    }
  }

  log.info("DRY RUN zone derivation — sample of the cursor head, NOT a corpus total", {
    sampled: rows.length,
    classified: rows.length - unclassified,
    unclassified,
    byZone: Object.fromEntries(byZone),
  });
  log.info("  samples", { samples });
}

async function drainRetirement(limit: number, rules: RetirementRules): Promise<void> {
  let totalEvaluated = 0;
  let totalRetired = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const result = await runRetirementPass({
      batchSize: limit,
      rules,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    totalEvaluated += result.evaluated;
    totalRetired += result.retired;
    // A short batch means the cursor reached the end of the eligible pool.
    if (result.evaluated < limit) break;
  }
  log.info("APPLY retirement complete", { totalEvaluated, totalRetired });
  log.info("Retirement totals now", await getRetirementStats());
}

async function drainZones(limit: number): Promise<void> {
  let totalEvaluated = 0;
  let totalClassified = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const result = await runZoneDerivationPass({
      batchSize: limit,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    totalEvaluated += result.evaluated;
    totalClassified += result.classified;
    if (result.evaluated < limit) break;
  }
  log.info("APPLY zone derivation complete", { totalEvaluated, totalClassified });
  log.info("Derived-zone distribution now", await getDerivedZoneDistribution());
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  await initDb();
  const rules = rulesFromConfig();

  if (!args.apply) {
    log.info("DRY RUN — nothing will be written. Pass --apply to execute.", { args });
  }

  if (args.lane === "retirement" || args.lane === "both") {
    if (args.apply) await drainRetirement(args.limit, rules);
    else await dryRunRetirement(args.limit, rules);
  }
  if (args.lane === "zones" || args.lane === "both") {
    if (args.apply) await drainZones(args.limit);
    else await dryRunZones(args.limit);
  }
}

main().catch((err) => {
  log.error("backfill-corpus-hygiene failed", { error: getErrorMessage(err) });
  process.exit(1);
});
