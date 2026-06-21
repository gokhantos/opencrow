/**
 * Maintenance script: purge echo-chamber and crypto reddit_posts rows.
 *
 * This is a ONE-TIME cleanup to remove existing rows that were ingested before
 * the denylist was added. After deploy, new scrape cycles will not ingest these
 * subreddits, so this only needs to run once.
 *
 * SAFE TO RUN: uses a DRY_RUN=true default. Pass DRY_RUN=false to execute the
 * DELETE. Always previews row counts first regardless of dry-run mode.
 *
 * Usage:
 *   bun scripts/purge-echo-chamber-reddit.ts            # dry run (count only)
 *   DRY_RUN=false bun scripts/purge-echo-chamber-reddit.ts  # execute DELETE
 *
 * Expected row counts (as of corpus snapshot 2026-06-21, 5,637 total rows):
 *   Would delete: 3,717 rows (66%)
 *   Remaining:    1,920 rows (end-user/vertical-pain + misc subs)
 */

import { loadConfig } from "../src/config/loader";
import { initDb, getDb } from "../src/store/db";
import { createLogger } from "../src/logger";

const log = createLogger("purge-echo-chamber-reddit");

// Denylist from the schema defaults — keep in sync with DEFAULT_REDDIT_DENYLIST
// in src/config/schema.ts. Lowercased for case-insensitive comparison.
const DENYLIST_LOWER: string[] = [
  "vibecoding",
  "claudecode",
  "claudeai",
  "chatgpt",
  "anthropic",
  "deepseek",
  "promptengineering",
  "vibecodedevs",
  "aiagents",
  "midjourney",
  "openclaw",
  "localllama",
  "machinelearning",
  "artificialintelligence",
  "openai",
  "singularity",
  "chatgptcoding",
  "cursor",
  "chatgptpro",
  "cryptocurrency",
  "bitcoin",
  "ethereum",
  "defi",
  "cryptotechnology",
  "cryptomarkets",
];

async function main(): Promise<void> {
  const dryRun = process.env["DRY_RUN"] !== "false";

  log.info("Purge script starting", { dryRun });

  const config = loadConfig();
  await initDb(config.postgres.url, { max: config.postgres.max });
  const db = getDb();

  // Preview: count rows that would be deleted
  const preview = await db`
    SELECT COUNT(*)::int AS would_delete
    FROM reddit_posts
    WHERE lower(subreddit) = ANY(${db.array(DENYLIST_LOWER)})
  `;
  const wouldDelete = (preview[0] as { would_delete: number } | undefined)?.would_delete ?? 0;

  const totalResult = await db`SELECT COUNT(*)::int AS n FROM reddit_posts`;
  const totalRows = (totalResult[0] as { n: number } | undefined)?.n ?? 0;

  log.info("Purge preview", {
    totalRows,
    wouldDelete,
    remaining: totalRows - wouldDelete,
    denylistSize: DENYLIST_LOWER.length,
  });

  // Per-subreddit breakdown
  const breakdown = await db`
    SELECT lower(subreddit) AS sub, COUNT(*)::int AS n
    FROM reddit_posts
    WHERE lower(subreddit) = ANY(${db.array(DENYLIST_LOWER)})
    GROUP BY lower(subreddit)
    ORDER BY n DESC
  `;

  log.info("Rows per denied subreddit", {
    breakdown: (breakdown as Array<{ sub: string; n: number }>).map(
      (r) => `${r.sub}: ${r.n}`,
    ),
  });

  if (dryRun) {
    log.info(
      "DRY RUN — no rows deleted. Set DRY_RUN=false to execute the DELETE.",
      { wouldDelete },
    );
    process.exit(0);
  }

  // Execute the DELETE
  log.info("Executing DELETE ...", { denylistSize: DENYLIST_LOWER.length });

  await db`
    DELETE FROM reddit_posts
    WHERE lower(subreddit) = ANY(${db.array(DENYLIST_LOWER)})
  `;

  log.info("Purge complete", { deleted: wouldDelete, remaining: totalRows - wouldDelete });

  process.exit(0);
}

main().catch((err) => {
  log.error("Purge script failed", { error: err });
  process.exit(1);
});
