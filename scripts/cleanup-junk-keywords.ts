/**
 * One-time cleanup: remove junk keywords lingering in the live
 * `appstore_keywords` corpus from before the generator in
 * `src/sources/appstore/keyword-corpus.ts` was de-junked (it used to cross
 * every noun with every modifier in MODIFIERS; it now only crosses each
 * noun with its own curated allowlist — see `n()` there).
 *
 * Junk is identified two ways:
 *   (a) test-pollution rows, e.g. `zzz test gap` — any source, matched by
 *       a `zzz` prefix.
 *   (b)/(c) `source='seed'` rows whose keyword the CURRENT de-junked
 *       generator would not produce (reconstructed from `buildSeedCorpus()`,
 *       the single source of truth for what's valid). This also catches
 *       double-modifier garbage like "tv show tracker tracker" or
 *       "trip planner planner", since those were never in the valid set
 *       either — the repeated-modifier regex is reported separately purely
 *       as a diagnostic breakdown, not as an independent deletion trigger,
 *       so a legitimate noun that happens to end in a modifier word (e.g.
 *       "time tracker widget", a valid combo) can never be wrongly deleted:
 *       it is protected by being present in the reconstructed valid set.
 *
 * `source='autocomplete'/'mined'/'manual'/'pipeline'` rows are NEVER
 * touched — those are legitimately discovered, not generator junk.
 *
 * SAFE TO RUN: dry-run is the default and only reports what would be
 * deleted. Pass --apply to execute the DELETE. Idempotent — re-running
 * --apply after a clean pass deletes 0 rows. Deletes from both
 * `appstore_keywords` and its orphaned `appstore_keyword_scans` rows (no FK
 * cascade between the two tables) inside one transaction.
 *
 * Usage:
 *   bun run scripts/cleanup-junk-keywords.ts            # dry run (report only)
 *   bun run scripts/cleanup-junk-keywords.ts --apply    # execute the DELETE
 */

import { initDb, getDb } from "../src/store/db";
import { createLogger } from "../src/logger";
import { getErrorMessage } from "../src/lib/error-serialization";
import { buildSeedCorpus } from "../src/sources/appstore/keyword-corpus";

const log = createLogger("cleanup-junk-keywords");

/** Diagnostic-only: flags rows ending in the same modifier word twice. */
const REPEATED_MODIFIER_RE = /\b(tracker|planner|widget)\s+\1\b/i;

const SAMPLE_SIZE = 25;

interface KeywordRow {
  readonly keyword: string;
  readonly source: string;
}

type JunkReason = "test-pollution" | "seed-mismatch";

interface JunkRow extends KeywordRow {
  readonly reason: JunkReason;
  readonly repeatedModifier: boolean;
}

function isTestPollution(keyword: string): boolean {
  return keyword.toLowerCase().startsWith("zzz");
}

/**
 * Classify every live row as junk or keep, using the reconstructed valid
 * seed set as the source of truth for `source='seed'` rows and a `zzz`
 * prefix check for test pollution regardless of source. Conservative by
 * construction: anything not matched by either rule is left alone,
 * including every non-seed source.
 */
function classifyRows(
  rows: readonly KeywordRow[],
  validSeedKeywords: ReadonlySet<string>,
): readonly JunkRow[] {
  const junk: JunkRow[] = [];
  for (const row of rows) {
    const repeatedModifier = REPEATED_MODIFIER_RE.test(row.keyword);
    if (isTestPollution(row.keyword)) {
      junk.push({ ...row, reason: "test-pollution", repeatedModifier });
      continue;
    }
    if (row.source === "seed" && !validSeedKeywords.has(row.keyword)) {
      junk.push({ ...row, reason: "seed-mismatch", repeatedModifier });
    }
  }
  return junk;
}

async function deleteJunkRows(keywords: readonly string[]): Promise<void> {
  const db = getDb();
  await db.begin(async (tx) => {
    await tx`DELETE FROM appstore_keyword_scans WHERE keyword IN ${tx(keywords)}`;
    await tx`DELETE FROM appstore_keywords WHERE keyword IN ${tx(keywords)}`;
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  log.info("Cleanup script starting", { mode: apply ? "apply" : "dry-run" });

  await initDb(process.env.DATABASE_URL);
  const db = getDb();

  const validSeedKeywords = new Set(buildSeedCorpus().map((row) => row.keyword));

  const allRows = (await db`
    SELECT keyword, source FROM appstore_keywords
  `) as unknown as KeywordRow[];

  const junkRows = classifyRows(allRows, validSeedKeywords);
  const testPollutionCount = junkRows.filter((r) => r.reason === "test-pollution").length;
  const seedMismatchCount = junkRows.filter((r) => r.reason === "seed-mismatch").length;
  const repeatedModifierCount = junkRows.filter((r) => r.repeatedModifier).length;

  log.info("Junk scan complete", {
    totalRows: allRows.length,
    junkRows: junkRows.length,
    testPollution: testPollutionCount,
    seedMismatch: seedMismatchCount,
    repeatedModifierSubset: repeatedModifierCount,
    validSeedCorpusSize: validSeedKeywords.size,
    remainingIfApplied: allRows.length - junkRows.length,
  });

  const sample = junkRows.slice(0, SAMPLE_SIZE).map((r) => {
    const suffix = r.repeatedModifier ? "/repeated-modifier" : "";
    return `${r.keyword} [${r.source}/${r.reason}${suffix}]`;
  });
  log.info("Sample of junk rows", { sampleSize: sample.length, sample });

  if (junkRows.length === 0) {
    log.info("No junk found — nothing to do");
    process.exit(0);
  }

  if (!apply) {
    log.info("DRY RUN — no rows deleted. Re-run with --apply to execute the DELETE.", {
      wouldDelete: junkRows.length,
    });
    process.exit(0);
  }

  const keywordsToDelete = junkRows.map((r) => r.keyword);
  log.info("Executing DELETE ...", { count: keywordsToDelete.length });

  try {
    await deleteJunkRows(keywordsToDelete);
  } catch (error) {
    log.error("Delete transaction failed, rolled back", { error: getErrorMessage(error) });
    throw new Error(
      `Failed to delete junk keywords (${keywordsToDelete.length} rows staged): ${getErrorMessage(error)}`,
    );
  }

  log.info("Cleanup complete", {
    deleted: keywordsToDelete.length,
    remaining: allRows.length - keywordsToDelete.length,
  });
  process.exit(0);
}

main().catch((err) => {
  log.error("Cleanup script failed", { error: err });
  process.exit(1);
});
