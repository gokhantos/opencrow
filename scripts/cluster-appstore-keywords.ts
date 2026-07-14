/**
 * Manual batch job: cluster the App Store keyword corpus into "app concepts"
 * via LOCAL embeddings + greedy cosine, and persist the assignments into
 * `appstore_keyword_clusters` (migration 038). Served read-only afterwards by
 * `GET /appstore/opportunity-clusters` — there is NO per-request embedding, and
 * this does NOT run on scraper ticks (it is expensive: it embeds up to ~20k
 * keywords through the local Ollama provider).
 *
 * Embeds via a LOCAL Ollama provider constructed DIRECTLY
 * (`createLocalOllamaEmbeddingProvider`, nomic-embed-text) — deliberately
 * INDEPENDENT of the memory `features/embeddings` config, which on some machines
 * is set to OpenRouter (and would fail here with no key). This matches the
 * validated spike exactly. Reads only our own DB + local Ollama — no external
 * calls. Endpoint/model are overridable via flags/env but default to the local
 * Ollama so the job works out of the box.
 *
 * Usage:
 *   bun run scripts/cluster-appstore-keywords.ts
 *   bun run scripts/cluster-appstore-keywords.ts --threshold 0.76 --max 15000
 *   bun run scripts/cluster-appstore-keywords.ts --ollama-url http://127.0.0.1:11434/v1 --model nomic-embed-text
 *   OLLAMA_URL=http://host:11434/v1 bun run scripts/cluster-appstore-keywords.ts
 *
 * or via the package script:
 *   bun run appstore:cluster-keywords
 */

import { loadConfig } from "../src/config/loader";
import { initDb, getDb } from "../src/store/db";
import { createLogger } from "../src/logger";
import { getErrorMessage } from "../src/lib/error-serialization";
import {
  createLocalOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDINGS_MODEL,
  DEFAULT_OLLAMA_EMBEDDINGS_URL,
} from "../src/memory/embeddings";
import { createEmbeddingCache } from "../src/memory/embedding-cache";
import {
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_MAX_CANDIDATES,
  runKeywordClustering,
} from "../src/sources/appstore/keyword-clustering";
import {
  selectClusterCandidateRows,
  replaceClusterAssignments,
} from "../src/sources/appstore/keyword-store";

const log = createLogger("cluster-appstore-keywords");

/** Read a numeric `--flag <value>` from argv, or fall back to `fallback`. */
function numArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read a string `--flag <value>` from argv, or fall back to `fallback`. */
function strArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  return raw && !raw.startsWith("--") ? raw : fallback;
}

async function main(): Promise<void> {
  const threshold = numArg("--threshold", DEFAULT_CLUSTER_THRESHOLD);
  const maxCandidates = numArg("--max", DEFAULT_MAX_CANDIDATES);
  // Local Ollama by default; overridable so a remote Ollama host also works.
  const ollamaUrl = strArg(
    "--ollama-url",
    process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_EMBEDDINGS_URL,
  );
  const model = strArg("--model", DEFAULT_OLLAMA_EMBEDDINGS_MODEL);
  log.info("Clustering job starting", { threshold, maxCandidates, ollamaUrl, model });

  const config = loadConfig();
  await initDb(config.postgres.url, { max: config.postgres.max });
  getDb();

  // Direct local Ollama — independent of the memory `features/embeddings`
  // config (which may point at OpenRouter and lack a key on this machine).
  const embedder = createLocalOllamaEmbeddingProvider({ baseUrl: ollamaUrl, model });

  // A large cache so a re-run within the TTL reuses embeddings across the whole
  // candidate set instead of re-embedding.
  const cache = createEmbeddingCache(60 * 60 * 1000, DEFAULT_MAX_CANDIDATES + 1000);

  const result = await runKeywordClustering({
    embedder,
    loadCandidates: selectClusterCandidateRows,
    persist: replaceClusterAssignments,
    threshold,
    maxCandidates,
    cache,
  });

  log.info("Clustering job complete", { ...result });
  process.exit(0);
}

main().catch((err) => {
  log.error("Clustering job failed", { error: getErrorMessage(err) });
  process.exit(1);
});
