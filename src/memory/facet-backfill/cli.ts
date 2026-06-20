/**
 * Facet backfill — CLI entry.
 *
 * Re-runs signal-facet extraction over `opencrow_memory` points that are
 * missing enrichment facets and patches the result back. A MANUALLY-RUN
 * operator tool: it needs Postgres + Qdrant live and (for a non-dry run) the
 * facet-extraction model reachable. It does NOT change any feature flag and
 * touches only points that lack facets (idempotent + resumable).
 *
 * Usage:
 *   bun run src/memory/facet-backfill/cli.ts [flags]
 *
 * Flags:
 *   --dry-run             Count the backlog only — no extraction, no writes.
 *   --batch-size <n>      Sources per enrich/patch batch (default 16).
 *   --limit <n>           Stop after N sources (0 = all; default 0).
 *   --scroll-page <n>     Qdrant scroll page size (default 256).
 *   --kind <kind>         Restrict to a single source kind (server-side filter).
 *
 * Always start with `--dry-run` to size the backlog before spending tokens.
 */

import { z } from "zod";
import { loadConfig, loadConfigWithOverrides } from "../../config/loader";
import { getSecret } from "../../config/secrets";
import { createLogger } from "../../logger";
import { bootstrap } from "../../process/bootstrap";
import { getDb } from "../../store/db";
import { createQdrantClient } from "../qdrant";
import { MEMORY_SOURCE_KINDS, type MemorySourceKind } from "../types";
import {
  type BackfillDeps,
  type BackfillResult,
  makeEnricher,
  makeSourceTextFetcher,
  runFacetBackfill,
} from "./backfill";

const log = createLogger("facet-backfill-cli");

const argsSchema = z.object({
  dryRun: z.coerce.boolean().default(false),
  batchSize: z.coerce.number().int().min(1).max(256).default(16),
  limit: z.coerce.number().int().min(0).default(0),
  scrollPage: z.coerce.number().int().min(1).max(1024).default(256),
  kind: z
    .enum(MEMORY_SOURCE_KINDS as unknown as [string, ...string[]])
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
  // Map kebab-case CLI flags onto the camelCase schema keys.
  const normalized: Record<string, string> = { ...raw };
  if (raw["dry-run"] !== undefined) normalized.dryRun = raw["dry-run"];
  if (raw["batch-size"] !== undefined) normalized.batchSize = raw["batch-size"];
  if (raw["scroll-page"] !== undefined) normalized.scrollPage = raw["scroll-page"];
  return argsSchema.parse(normalized);
}

/**
 * Build the backfill dependencies from config the SAME way `bootstrap` builds
 * the live memory wiring — so the backfill reads/writes the exact collection
 * the app does.
 */
async function buildDeps(): Promise<BackfillDeps> {
  const mergedConfig = await loadConfigWithOverrides();
  if (mergedConfig.memorySearch === undefined) {
    throw new Error("memorySearch config is required to run the facet backfill");
  }
  const memSearch = mergedConfig.memorySearch;

  const qdrantUrl = (await getSecret("QDRANT_URL")) ?? memSearch.qdrant.url;
  const qdrantCollection = memSearch.qdrant.collection;
  const qdrantClient = await createQdrantClient({
    url: qdrantUrl,
    apiKey: memSearch.qdrant.apiKey,
  });

  const rankingEnabled =
    mergedConfig.pipelines.ideas.smart.signalRanking === true;

  return {
    qdrantClient,
    qdrantCollection,
    fetchSourceText: makeSourceTextFetcher(getDb()),
    enrich: makeEnricher(rankingEnabled),
  };
}

function printSummary(result: BackfillResult): void {
  const lines: string[] = [];
  lines.push("");
  lines.push("─".repeat(60));
  lines.push(`  FACET BACKFILL — ${result.dryRun ? "DRY RUN" : "APPLIED"}`);
  lines.push("─".repeat(60));
  lines.push(`  scanned points        : ${result.scannedPoints}`);
  lines.push(`  candidate sources     : ${result.candidateSources}`);
  lines.push(`  candidate points      : ${result.candidatePoints}`);
  if (!result.dryRun) {
    lines.push(`  enriched sources      : ${result.enrichedSources}`);
    lines.push(`  patched sources       : ${result.patchedSources}`);
    lines.push(`  patched points        : ${result.patchedPoints}`);
    lines.push(`  skipped (no text)     : ${result.skippedNoText}`);
    lines.push(`  skipped (no facets)   : ${result.skippedNoFacets}`);
  }
  lines.push("─".repeat(60));
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  // Bootstrap DB only — we build the Qdrant/enrich wiring ourselves below.
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "facet-backfill",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 3,
  });

  const deps = await buildDeps();

  if (!deps.qdrantClient.available) {
    log.error(
      "Qdrant is not available — cannot scroll the collection; check QDRANT_URL / the qdrant service",
    );
    process.exit(2);
  }

  log.info("Starting facet backfill", {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    limit: args.limit,
    scrollPage: args.scrollPage,
    kind: args.kind ?? "all",
    collection: deps.qdrantCollection,
  });

  const result = await runFacetBackfill(deps, {
    batchSize: args.batchSize,
    limit: args.limit,
    scrollPageSize: args.scrollPage,
    dryRun: args.dryRun,
    kind: args.kind as MemorySourceKind | undefined,
  });

  printSummary(result);

  // Exit explicitly: the Qdrant recovery probe + DB pool keep the loop alive.
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("Facet backfill failed", { err });
    process.exit(1);
  });
}
