/**
 * Offline recall-comparison harness — CLI entry.
 *
 * Measures whether the mem0 memory backend returns search results comparable to
 * the Qdrant backend, BEFORE anyone flips `OPENCROW_MEMORY_BACKEND`. It is a
 * MANUALLY-RUN operator tool: it needs Postgres + Qdrant + the mem0 sidecar
 * live. It does NOT change the default flag, does NOT touch the production hot
 * path, and writes ONLY under a throwaway agentId that is torn down on exit.
 *
 * Usage:
 *   bun run src/memory/recall-harness/cli.ts \
 *     [--queries <file>] [--corpus <file>] [--k 10] \
 *     [--source=db --sample=N] [--report <file>] [--run-id <id>]
 *
 * Defaults: bundled fixtures in ./fixtures, k=10, source=fixture. The report is
 * written to ./recall-report-<runId>.json unless --report is given.
 */

import { join } from "node:path";
import { z } from "zod";
import { loadConfig, loadConfigWithOverrides } from "../../config/loader";
import { embeddingsConfigSchema } from "../../config/schema";
import { getSecret } from "../../config/secrets";
import { getOverride } from "../../store/config-overrides";
import { createLogger } from "../../logger";
import { bootstrap } from "../../process/bootstrap";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import type { MemoryBackendDeps } from "../backend/factory";
import { createEmbeddingProviderFromConfig } from "../embeddings";
import { createQdrantClient } from "../qdrant";
import {
  loadDbCorpus,
  loadFixtureCorpus,
  loadQuerySet,
  type CorpusItem,
} from "./corpus";
import { getDb } from "../../store/db";
import { runHarness, type HarnessReport } from "./runner";

const log = createLogger("recall-harness-cli");

const HARNESS_DIR = import.meta.dir;
const DEFAULT_CORPUS = join(HARNESS_DIR, "fixtures", "corpus.jsonl");
const DEFAULT_QUERIES = join(HARNESS_DIR, "fixtures", "queries.json");

const argsSchema = z.object({
  queries: z.string().default(DEFAULT_QUERIES),
  corpus: z.string().default(DEFAULT_CORPUS),
  k: z.coerce.number().int().min(1).default(10),
  source: z.enum(["fixture", "db"]).default("fixture"),
  sample: z.coerce.number().int().min(1).default(50),
  report: z.string().optional(),
  // Constrained to a safe slug: runId becomes part of a filename and the
  // throwaway agent namespace, so disallow path separators / traversal.
  runId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "runId must be alphanumeric, dash or underscore")
    .optional(),
});

type ParsedArgs = z.infer<typeof argsSchema>;

/** Parse `--key value`, `--key=value`, and bare `--flag` into a record. */
function parseArgv(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok || !tok.startsWith("--")) continue;
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = "true";
    }
  }
  return out;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const raw = parseArgv(argv);
  // Support both --run-id and --runId on the CLI surface.
  if (raw["run-id"] !== undefined && raw["runId"] === undefined) {
    raw["runId"] = raw["run-id"];
  }
  return argsSchema.parse(raw);
}

/**
 * Assemble the backend dependencies the SAME way `bootstrap` does — reusing the
 * embedding provider, Qdrant client, and a single Mem0Client — so the harness
 * exercises the real wiring rather than a parallel construction.
 */
async function buildDeps(): Promise<MemoryBackendDeps> {
  const mergedConfig = await loadConfigWithOverrides();
  if (mergedConfig.memorySearch === undefined) {
    throw new Error("memorySearch config is required to run the recall harness");
  }
  const memSearch = mergedConfig.memorySearch;

  const embeddingsOverride = await getOverride("features", "embeddings");
  const embeddingsConfig = embeddingsConfigSchema.parse(
    embeddingsOverride ?? mergedConfig.embeddings ?? {},
  );
  const apiKey =
    (await getSecret("OPENROUTER_API_KEY")) ??
    (await getSecret("VOYAGE_API_KEY")) ??
    undefined;
  const embeddingProvider = createEmbeddingProviderFromConfig(
    embeddingsConfig,
    apiKey,
  );

  const qdrantUrl = (await getSecret("QDRANT_URL")) ?? memSearch.qdrant.url;
  const qdrantCollection = memSearch.qdrant.collection;
  const qdrantClient = await createQdrantClient({
    url: qdrantUrl,
    apiKey: memSearch.qdrant.apiKey,
  });
  // Only assert the collection when vector search can actually run (an embedding
  // provider exists). With no provider the Qdrant leg degrades to FTS-only, and
  // calling ensureCollection here would throw on a pre-existing collection whose
  // dimension differs from this shell's configured `embeddings.dimensions` — a
  // config-divergence guard that is irrelevant when no vectors are produced.
  if (qdrantClient.available && embeddingProvider) {
    try {
      await qdrantClient.ensureCollection(
        qdrantCollection,
        embeddingsConfig.dimensions,
      );
    } catch (err) {
      log.warn(
        "Qdrant collection check failed — vector leg may be unavailable; continuing (FTS still runs)",
        { err: (err as Error).message },
      );
    }
  } else if (qdrantClient.available && !embeddingProvider) {
    log.warn(
      "No embedding provider — Qdrant reference results will be FTS-only (vector search disabled)",
    );
  }

  if (!mergedConfig.sige?.mem0) {
    throw new Error(
      "sige.mem0 config is required to run the recall harness (it provides the mem0 sidecar URL/token)",
    );
  }
  const mem0Client = new Mem0Client({
    baseUrl: mergedConfig.sige.mem0.baseUrl,
    apiToken: mergedConfig.sige.mem0.apiToken,
  });

  return {
    embeddingProvider,
    qdrantClient,
    qdrantCollection,
    defaultLimit: memSearch.defaultLimit,
    minScore: memSearch.minScore,
    vectorWeight: memSearch.vectorWeight,
    textWeight: memSearch.textWeight,
    mmrLambda: memSearch.mmrLambda,
    mem0Client,
    mem0SharedUserId: memSearch.mem0SharedUserId,
  };
}

function fmt(n: number | null, digits = 3): string {
  return n === null ? "n/a" : n.toFixed(digits);
}

/** Print the headline aggregate + a per-query table to stdout. */
function printSummary(report: HarnessReport): void {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push("");
  lines.push("═".repeat(72));
  lines.push("  RECALL COMPARISON — mem0 (candidate) vs Qdrant (reference)");
  lines.push("═".repeat(72));
  lines.push(
    `  HEADLINE: mean overlap@${report.k} = ${fmt(a.meanOverlapAtK)}  |  ` +
      `mean recall@${report.k} = ${fmt(a.meanRecallAtK)}`,
  );
  lines.push(
    `  median overlap@${report.k} = ${fmt(a.medianOverlapAtK)}  |  ` +
      `median recall@${report.k} = ${fmt(a.medianRecallAtK)}`,
  );
  lines.push(
    `  mean rank displacement = ${fmt(a.meanRankDisplacement, 2)}  |  ` +
      `mean Spearman ρ = ${fmt(a.meanSpearman)}`,
  );
  lines.push(
    `  qdrant-only hits = ${a.totalReferenceOnly}  |  mem0-only hits = ${a.totalCandidateOnly}`,
  );
  lines.push(
    `  corpus=${report.corpusSize}  queries=${report.queryCount}  agentId=${report.agentId}`,
  );
  lines.push(
    `  match path: qdrant=${report.matchedByContentHash.qdrant ? "content-hash" : "metadata"}  ` +
      `mem0=${report.matchedByContentHash.mem0 ? "content-hash" : "metadata"}`,
  );
  lines.push("─".repeat(72));
  lines.push("  per-query  overlap  recall  rankΔ   ρ      q-only m-only");
  for (const q of report.perQuery) {
    lines.push(
      `  ${q.query.slice(0, 28).padEnd(28)} ` +
        `${q.overlapAtK.toFixed(2)}    ${q.recallAtK.toFixed(2)}    ` +
        `${fmt(q.meanRankDisplacement, 1).padStart(4)}  ${fmt(q.spearman, 2).padStart(5)}  ` +
        `${String(q.referenceOnly.length).padStart(4)}  ${String(q.candidateOnly.length).padStart(4)}`,
    );
  }
  lines.push("─".repeat(72));
  lines.push(
    "  NOTE: the acceptable-parity threshold for cutover is a HUMAN judgment;",
  );
  lines.push(
    "  this harness only measures, it does not decide. Inspect the JSON report.",
  );
  lines.push("═".repeat(72));
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const runId = args.runId ?? `${Date.now()}`;

  // Bootstrap DB only (skip memory/observation wiring — we build backends here).
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "recall-harness",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 3,
  });

  const deps = await buildDeps();

  if (!deps.qdrantClient?.available) {
    log.warn(
      "Qdrant is not available — reference results will be empty; check QDRANT_URL / the qdrant container",
    );
  }
  if (deps.mem0Client?.isUnavailable()) {
    log.warn("mem0 client reports unavailable — candidate results may be empty");
  }

  const corpus: readonly CorpusItem[] =
    args.source === "db"
      ? await loadDbCorpus(getDb(), args.sample)
      : await loadFixtureCorpus(args.corpus);

  if (corpus.length === 0) {
    log.error("Corpus is empty — nothing to measure; aborting");
    process.exit(2);
  }

  const queries = await loadQuerySet(args.queries);
  const reportPath =
    args.report ??
    join(process.cwd(), `recall-report-${runId}.json`);

  log.info("Starting recall harness", {
    runId,
    source: args.source,
    corpus: corpus.length,
    queries: queries.length,
    k: args.k,
    reportPath,
  });

  const report = await runHarness({
    runId,
    corpus,
    queries,
    k: args.k,
    deps,
    reportPath,
  });

  printSummary(report);
  // Exit explicitly: the Qdrant recovery probe + DB pool keep the loop alive.
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("Recall harness failed", { err });
    process.exit(1);
  });
}
