import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../../store/db";
import { loadConfigWithOverrides } from "../../config/loader";
import type { MemoryBackendDeps } from "../backend/factory";
import { createQdrantClient } from "../qdrant";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import type { CorpusItem } from "./corpus";
import { countResidualRows, harnessAgentId, runHarness } from "./runner";

/**
 * End-to-end smoke for the recall harness against the LIVE local stack
 * (Postgres + Qdrant + mem0 sidecar). It runs a tiny corpus through both
 * backends and asserts the headline invariant: teardown leaves ZERO harness
 * rows for the throwaway agentId. It does NOT assert a parity threshold —
 * parity is a human judgment — only that the harness runs and cleans up.
 *
 * Requires a real DB + Qdrant + mem0. Run via `bun run test:integration`
 * (which starts Postgres). When Qdrant or the mem0 sidecar is unreachable
 * (e.g. in CI which only provides Postgres), the suite SKIPS rather than
 * fails — so it keeps providing value locally without breaking CI.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencrow@127.0.0.1:5432/opencrow";

// ── Service reachability probe ────────────────────────────────────────────────
// Probe mem0 and Qdrant with a 300 ms timeout each.  Any network error or
// non-2xx response is treated as "unreachable".  The probe URLs mirror the
// schema defaults so they work out-of-the-box on the local dev stack without
// requiring extra env vars.

const MEM0_BASE_URL =
  process.env.OPENCROW_SIGE_MEM0_URL ?? "http://127.0.0.1:8050";
const QDRANT_BASE_URL = "http://127.0.0.1:6333";
const PROBE_TIMEOUT_MS = 300;

async function probeUrl(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Top-level await is supported in Bun test files (ESNext modules).
// Both probes run in parallel; skip if either is unreachable.
const [mem0Up, qdrantUp] = await Promise.all([
  probeUrl(`${MEM0_BASE_URL}/health`),
  probeUrl(`${QDRANT_BASE_URL}/healthz`),
]);
const fullStackUp = mem0Up && qdrantUp;

if (!fullStackUp) {
  const missing: string[] = [];
  if (!mem0Up) missing.push(`mem0 (${MEM0_BASE_URL})`);
  if (!qdrantUp) missing.push(`Qdrant (${QDRANT_BASE_URL})`);
  process.stderr.write(
    `[runner.integration.test] SKIPPING smoke suite — unreachable: ${missing.join(", ")}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!fullStackUp)("recall harness integration smoke", () => {
  beforeAll(async () => {
    await initDb(DATABASE_URL, { max: 3 });
  });

  afterAll(async () => {
    // Defensive sweep in case the harness teardown was interrupted.
    const { getDb } = await import("../../store/db");
    const db = getDb();
    await db`DELETE FROM memory_sources WHERE agent_id LIKE '__recall_harness__%'`;
  });

  test("dual-write + measure + teardown leaves zero harness rows", async () => {
    // Override-aware loader: memorySearch is materialised from defaults/overrides
    // there (the bare loadConfig() may omit it).
    const config = await loadConfigWithOverrides();
    const memSearch = config.memorySearch;
    if (!memSearch) {
      throw new Error("memorySearch config missing — cannot run smoke");
    }

    const qdrantClient = await createQdrantClient({
      url: memSearch.qdrant.url,
      apiKey: memSearch.qdrant.apiKey,
    });
    // No ensureCollection here: the smoke runs with NO embedding provider, so the
    // Qdrant leg is FTS-only and never touches vectors. Asserting the collection
    // dimension would couple this test to whatever the live collection happens to
    // be (e.g. 768 vs the configured 512) — irrelevant to write + teardown.

    const mem0Client = config.sige?.mem0
      ? new Mem0Client({
          baseUrl: config.sige.mem0.baseUrl,
          apiToken: config.sige.mem0.apiToken,
        })
      : null;

    // Embedding provider is optional for the smoke — without it the Qdrant
    // vector leg degrades to FTS-only, which still exercises the write/teardown
    // path. We only need the harness to run and clean up.
    const deps: MemoryBackendDeps = {
      embeddingProvider: null,
      qdrantClient,
      qdrantCollection: memSearch.qdrant.collection,
      defaultLimit: 5,
      minScore: 0,
      mem0Client,
      mem0SharedUserId: memSearch.mem0SharedUserId,
    };

    const runId = `itest-${Date.now()}`;
    const agentId = harnessAgentId(runId);

    const corpus: readonly CorpusItem[] = [
      {
        harnessItemId: "smoke-1",
        content:
          "PostgreSQL connection pooling reduces per-request backend startup overhead under high concurrency.",
        metadata: { harness_item_id: "smoke-1", topic: "databases" },
      },
      {
        harnessItemId: "smoke-2",
        content:
          "Vector search uses approximate nearest neighbor over HNSW graphs to retrieve similar embeddings quickly.",
        metadata: { harness_item_id: "smoke-2", topic: "vector-search" },
      },
    ];

    const reportPath = join(tmpdir(), `recall-smoke-${runId}.json`);

    const report = await runHarness({
      runId,
      corpus,
      queries: ["postgres connection pooling", "nearest neighbor vector search"],
      k: 5,
      deps,
      reportPath,
    });

    // The harness produced a structured report for every query.
    expect(report.perQuery.length).toBe(2);
    expect(report.corpusSize).toBe(2);
    expect(report.agentId).toBe(agentId);

    // The headline invariant: teardown removed all harness bookkeeping rows.
    const residual = await countResidualRows(agentId);
    expect(residual.sources).toBe(0);
    expect(residual.chunkMap).toBe(0);
  }, 60_000);
});
