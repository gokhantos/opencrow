import { z } from "zod";
import { loadConfig, loadConfigWithOverrides } from "../../config/loader";
import { createLogger } from "../../logger";
import { closeDb, getDb, initDb } from "../../store/db";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import { MEMORY_SOURCE_KINDS } from "../types";
import type { MemorySourceKind } from "../types";
import { runBackfill, type BackfillOptions } from "./backfill";

const log = createLogger("mem0-backfill-cli");

/**
 * One-time, idempotent, resumable CLI to migrate existing Qdrant-indexed agent
 * memory (tracked in `memory_sources` + `memory_chunks`) into mem0, so flipping
 * `OPENCROW_MEMORY_BACKEND=mem0` does NOT cold-start every agent.
 *
 * Standalone migration tool — NOT wired into any startup/hot path. It reads
 * Postgres + the live config and writes ONLY to mem0 + `mem0_chunk_map`. It never
 * deletes or mutates Qdrant, `memory_sources`, or `memory_chunks`.
 *
 *   bun run src/memory/mem0-backfill/cli.ts [flags]
 *
 * Flags:
 *   --dry-run            Count what WOULD be written; write nothing.
 *   --limit N            Stop after N sources.
 *   --kinds a,b,c        Only these memory kinds (comma-separated).
 *   --agent <id>         Only this agent's sources.
 *   --batch-size N       Sources per page (default 50).
 *   --concurrency N      Concurrent source writes (default 3, max 8).
 */

const KIND_SET = new Set<string>(MEMORY_SOURCE_KINDS);

const cliSchema = z.object({
  dryRun: z.boolean().default(false),
  limit: z.number().int().positive().optional(),
  kinds: z.array(z.string()).optional(),
  agent: z.string().min(1).optional(),
  batchSize: z.number().int().min(1).max(500).default(50),
  // Keep concurrency modest: the mem0 sidecar is shared and slow even with
  // infer:false. Hard-cap at 8 to avoid overloading it for other sessions.
  concurrency: z.number().int().min(1).max(8).default(3),
});

type CliArgs = z.infer<typeof cliSchema>;

/** Parse `--flag value` / `--flag=value` / `--bool` argv into a raw record. */
function parseArgv(argv: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }

    switch (key) {
      case "dry-run":
        raw.dryRun = true;
        break;
      case "limit":
        if (value !== undefined) raw.limit = Number(value);
        break;
      case "kinds":
        if (value !== undefined) {
          raw.kinds = value.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
        }
        break;
      case "agent":
        if (value !== undefined) raw.agent = value;
        break;
      case "batch-size":
        if (value !== undefined) raw.batchSize = Number(value);
        break;
      case "concurrency":
        if (value !== undefined) raw.concurrency = Number(value);
        break;
      default:
        log.warn("Ignoring unknown flag", { flag: key });
    }
  }
  return raw;
}

/** Validate kinds against the closed enum, returning typed kinds (or undefined). */
function validateKinds(
  kinds: readonly string[] | undefined,
): readonly MemorySourceKind[] | undefined {
  if (kinds === undefined || kinds.length === 0) return undefined;
  const bad = kinds.filter((k) => !KIND_SET.has(k));
  if (bad.length > 0) {
    throw new Error(
      `Unknown --kinds value(s): ${bad.join(", ")}. ` +
        `Valid kinds: ${MEMORY_SOURCE_KINDS.join(", ")}`,
    );
  }
  return kinds as readonly MemorySourceKind[];
}

async function main(argv: readonly string[]): Promise<void> {
  const args: CliArgs = cliSchema.parse(parseArgv(argv));
  const kinds = validateKinds(args.kinds);

  // Load the SAME config the live backend reads, so scoping (shared/per-agent +
  // sharedUserId) and the mem0 endpoint match what a flipped backend will use.
  // The DB must be initialized BEFORE loadConfigWithOverrides(), which reads the
  // config_overrides table. The postgres URL comes from the env-only loadConfig(),
  // so it needs no DB itself.
  const baseConfig = loadConfig();
  const dbUrl = process.env.DATABASE_URL ?? baseConfig.postgres.url;
  await initDb(dbUrl, { max: 4 });

  const config = await loadConfigWithOverrides();

  const memSearch = config.memorySearch;
  if (memSearch === undefined) {
    throw new Error(
      "memorySearch is not configured — nothing to back up into mem0. " +
        "Enable memory search before backfilling.",
    );
  }

  const mem0 = config.sige?.mem0;
  if (mem0?.baseUrl === undefined) {
    throw new Error(
      "sige.mem0.baseUrl is not configured — cannot reach the mem0 sidecar. " +
        "Set the mem0 endpoint (env/secret) before backfilling.",
    );
  }

  try {
    const client = new Mem0Client({
      baseUrl: mem0.baseUrl,
      apiToken: mem0.apiToken,
    });

    const opts: BackfillOptions = {
      scoping: {
        shared: memSearch.shared,
        sharedUserId: memSearch.mem0SharedUserId,
      },
      kinds,
      agentId: args.agent,
      limit: args.limit,
      batchSize: args.batchSize,
      concurrency: args.concurrency,
      dryRun: args.dryRun,
    };

    const result = await runBackfill(getDb(), client, opts);

    log.info("Backfill finished", {
      ...result,
      dryRun: args.dryRun,
      shared: memSearch.shared,
      sharedUserId: memSearch.mem0SharedUserId,
    });
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((err) => {
    log.error("Backfill failed", { err });
    process.exitCode = 1;
  });
}
