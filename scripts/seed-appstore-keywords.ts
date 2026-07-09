/**
 * One-shot: seed the appstore_keywords table from the built-in seed corpus.
 *
 * Idempotent — upsertKeywords does ON CONFLICT (keyword) DO UPDATE, so this
 * is safe to re-run (e.g. after the seed corpus is extended).
 *
 * Usage:
 *   bun run scripts/seed-appstore-keywords.ts
 */

import { loadConfig } from "../src/config/loader";
import { initDb, getDb } from "../src/store/db";
import { createLogger } from "../src/logger";
import { buildSeedCorpus } from "../src/sources/appstore/keyword-corpus";
import { upsertKeywords } from "../src/sources/appstore/keyword-store";

const log = createLogger("seed-appstore-keywords");

async function main(): Promise<void> {
  log.info("Seed script starting");

  const config = loadConfig();
  await initDb(config.postgres.url, { max: config.postgres.max });
  getDb();

  const corpus = buildSeedCorpus();
  const upserted = await upsertKeywords(corpus);

  log.info("Seed complete", { corpusSize: corpus.length, upserted });

  process.exit(0);
}

main().catch((err) => {
  log.error("Seed script failed", { error: err });
  process.exit(1);
});
