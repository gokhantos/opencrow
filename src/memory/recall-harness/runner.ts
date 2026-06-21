import { createHash } from "node:crypto";
import { createLogger } from "../../logger";
import { createMemoryBackend, type MemoryBackendDeps } from "../backend/factory";
import type { MemoryBackend } from "../backend/types";
import { buildNoteChunks } from "../backend/chunk-builders";
import { getDb } from "../../store/db";
import type { SearchResult } from "../types";
import { HARNESS_ITEM_ID_KEY, type CorpusItem } from "./corpus";
import {
  aggregateMetrics,
  computeQueryMetrics,
  type AggregateMetrics,
  type QueryMetrics,
} from "./metrics";

const log = createLogger("recall-harness-runner");

/**
 * Normalise + hash chunk text so the SAME chunk produced by either backend maps
 * to the same key. Both backends store verbatim chunk text, so a hash of the
 * (whitespace-collapsed, lowercased) content is a backend-agnostic join key —
 * the canonical match path, used when caller metadata is not surfaced (mem0
 * empties `source.metadata`; only the Qdrant path round-trips it).
 */
function chunkHash(content: string): string {
  const normalised = content.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}

export interface RunnerConfig {
  /** Throwaway run id — namespaces all writes and the report filename. */
  readonly runId: string;
  readonly corpus: readonly CorpusItem[];
  readonly queries: readonly string[];
  readonly k: number;
  /** Backend dependencies (embeddings, qdrant, mem0 client) — see bootstrap. */
  readonly deps: MemoryBackendDeps;
  /** Where to write the JSON report. */
  readonly reportPath: string;
}

interface BackendQueryResult {
  /** Cross-backend join ids in rank order. */
  readonly ids: readonly string[];
  /** Scores in the same rank order. */
  readonly scores: readonly number[];
  /** Results whose chunk could not be mapped to a corpus item. */
  readonly unmatched: number;
}

export interface HarnessReport {
  readonly runId: string;
  readonly agentId: string;
  readonly k: number;
  readonly corpusSize: number;
  readonly queryCount: number;
  /** True when the harness fell back to content-hash matching for a backend. */
  readonly matchedByContentHash: { readonly qdrant: boolean; readonly mem0: boolean };
  readonly perQuery: readonly QueryMetrics[];
  readonly aggregate: AggregateMetrics;
  readonly generatedAt: string;
}

/** The throwaway agentId all harness writes/reads use, derived from the run id. */
export function harnessAgentId(runId: string): string {
  return `__recall_harness__${runId}`;
}

/**
 * Build `chunkHash → harnessItemId` by chunking each corpus item with the EXACT
 * builder both backends use (`buildNoteChunks`). This is the join table the
 * content-hash match path consults. A hash collision across two items (identical
 * chunk text) keeps the first item id and logs — acceptable for a measurement
 * tool, and avoidable by using distinct fixture content.
 */
async function buildChunkIndex(
  corpus: readonly CorpusItem[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const item of corpus) {
    const groups = await buildNoteChunks(item.content);
    for (const group of groups) {
      for (const chunk of group.chunks) {
        const h = chunkHash(chunk);
        if (!index.has(h)) {
          index.set(h, item.harnessItemId);
        } else if (index.get(h) !== item.harnessItemId) {
          log.warn("Chunk hash collision across corpus items", {
            existing: index.get(h),
            duplicate: item.harnessItemId,
          });
        }
      }
    }
  }
  return index;
}

/**
 * Resolve one search result to its cross-backend join id.
 *
 * Preference order: (1) the round-tripped `harness_item_id` in
 * `source.metadata` (only the Qdrant backend surfaces this); (2) content-hash of
 * the chunk against the precomputed index (works for both backends). Returns
 * `{ id, viaMetadata }` or null when neither resolves.
 */
function resolveId(
  result: SearchResult,
  chunkIndex: ReadonlyMap<string, string>,
): { readonly id: string; readonly viaMetadata: boolean } | null {
  const fromMeta = result.source.metadata[HARNESS_ITEM_ID_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) {
    return { id: fromMeta, viaMetadata: true };
  }
  const byHash = chunkIndex.get(chunkHash(result.chunk.content));
  if (byHash) return { id: byHash, viaMetadata: false };
  return null;
}

/** Run one query against a backend and resolve results to join ids. */
async function queryBackend(
  backend: MemoryBackend,
  agentId: string,
  query: string,
  k: number,
  chunkIndex: ReadonlyMap<string, string>,
): Promise<BackendQueryResult & { readonly anyViaMetadata: boolean }> {
  const results = await backend.search(agentId, query, { limit: k, minScore: 0 });
  const ids: string[] = [];
  const scores: number[] = [];
  let unmatched = 0;
  let anyViaMetadata = false;
  for (const r of results) {
    const resolved = resolveId(r, chunkIndex);
    if (!resolved) {
      unmatched += 1;
      continue;
    }
    if (resolved.viaMetadata) anyViaMetadata = true;
    ids.push(resolved.id);
    scores.push(r.score);
  }
  return { ids, scores, unmatched, anyViaMetadata };
}

/**
 * Dual-write the corpus into a backend as notes under the throwaway agentId,
 * returning every sourceId produced (for teardown). Each item is written with
 * its metadata (carrying `harness_item_id`) so the Qdrant path can round-trip it.
 */
async function writeCorpus(
  backend: MemoryBackend,
  agentId: string,
  corpus: readonly CorpusItem[],
): Promise<readonly string[]> {
  const sourceIds: string[] = [];
  for (const item of corpus) {
    const sourceId = await backend.indexNote(
      agentId,
      item.content,
      { ...item.metadata },
    );
    sourceIds.push(sourceId);
  }
  return sourceIds;
}

/**
 * Delete the harness's Postgres bookkeeping rows for the throwaway agent.
 * Backend vector/memory deletion is handled by `deleteSourceVectors`; this
 * clears the `memory_sources` rows (both backends write them) and any
 * `memory_chunks` rows (Qdrant path) keyed by the harness agentId. The
 * `mem0_chunk_map` rows are removed via `deleteSourceVectors` on the mem0
 * backend, but we also sweep by sourceId here as a belt-and-braces net.
 */
async function deletePostgresRows(
  agentId: string,
  sourceIds: readonly string[],
): Promise<void> {
  const db = getDb();
  // memory_chunks has no agent_id column; delete by the harness source ids.
  if (sourceIds.length > 0) {
    const pgArray = `{${sourceIds.join(",")}}`;
    await db`DELETE FROM memory_chunks WHERE source_id = ANY(${pgArray}::text[])`;
    await db`DELETE FROM mem0_chunk_map WHERE source_id = ANY(${pgArray}::text[])`;
  }
  await db`DELETE FROM memory_sources WHERE agent_id = ${agentId}`;
}

/**
 * Confirm teardown left zero harness rows. Returns the residual counts so the
 * caller (and integration test) can assert a clean run. Best-effort: a DB error
 * here is logged, not thrown, so it never masks the harness result.
 */
export async function countResidualRows(agentId: string): Promise<{
  readonly sources: number;
  readonly chunkMap: number;
}> {
  const db = getDb();
  const sourceRows = (await db`
    SELECT COUNT(*)::int AS n FROM memory_sources WHERE agent_id = ${agentId}
  `) as Array<{ n: number }>;
  // mem0_chunk_map has no agent_id; count rows whose source is a harness source.
  const mapRows = (await db`
    SELECT COUNT(*)::int AS n FROM mem0_chunk_map m
    WHERE EXISTS (
      SELECT 1 FROM memory_sources s
      WHERE s.id = m.source_id AND s.agent_id = ${agentId}
    )
  `) as Array<{ n: number }>;
  return {
    sources: sourceRows[0]?.n ?? 0,
    chunkMap: mapRows[0]?.n ?? 0,
  };
}

/**
 * Run the full recall comparison. Builds BOTH backends from the same deps, dual-
 * writes the corpus under a throwaway agentId, runs every query against both,
 * matches results across backends, computes metrics, writes a JSON report, and
 * ALWAYS tears down its writes from both backends (try/finally) so an aborted run
 * never leaves harness data in the prod stores.
 */
export async function runHarness(config: RunnerConfig): Promise<HarnessReport> {
  const agentId = harnessAgentId(config.runId);
  // shared:false so the harness scopes reads/writes to its throwaway agentId on
  // BOTH backends (Qdrant agent filter on; mem0 user_id = agentId) — this is the
  // namespace isolation that keeps prod memory clean.
  const isolatedDeps: MemoryBackendDeps = { ...config.deps, shared: false };

  const qdrant = createMemoryBackend("qdrant", isolatedDeps);
  const mem0 = createMemoryBackend("mem0", isolatedDeps);

  const chunkIndex = await buildChunkIndex(config.corpus);

  let qdrantSourceIds: readonly string[] = [];
  let mem0SourceIds: readonly string[] = [];

  try {
    log.info("Dual-writing corpus into both backends", {
      agentId,
      items: config.corpus.length,
    });
    qdrantSourceIds = await writeCorpus(qdrant, agentId, config.corpus);
    mem0SourceIds = await writeCorpus(mem0, agentId, config.corpus);

    const perQuery: QueryMetrics[] = [];
    let qdrantViaMeta = false;
    let mem0ViaMeta = false;

    for (const query of config.queries) {
      const [refRes, candRes] = await Promise.all([
        queryBackend(qdrant, agentId, query, config.k, chunkIndex),
        queryBackend(mem0, agentId, query, config.k, chunkIndex),
      ]);
      if (refRes.anyViaMetadata) qdrantViaMeta = true;
      if (candRes.anyViaMetadata) mem0ViaMeta = true;

      perQuery.push(
        computeQueryMetrics({
          query,
          referenceIds: refRes.ids,
          candidateIds: candRes.ids,
          referenceScores: refRes.scores,
          candidateScores: candRes.scores,
          k: config.k,
        }),
      );

      if (refRes.unmatched > 0 || candRes.unmatched > 0) {
        log.debug("Unmatched results for query", {
          query: query.slice(0, 60),
          qdrantUnmatched: refRes.unmatched,
          mem0Unmatched: candRes.unmatched,
        });
      }
    }

    const report: HarnessReport = {
      runId: config.runId,
      agentId,
      k: config.k,
      corpusSize: config.corpus.length,
      queryCount: config.queries.length,
      matchedByContentHash: {
        // If a backend never surfaced metadata, every match came via content hash.
        qdrant: !qdrantViaMeta,
        mem0: !mem0ViaMeta,
      },
      perQuery,
      aggregate: aggregateMetrics(perQuery),
      generatedAt: new Date().toISOString(),
    };

    await Bun.write(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    log.info("Report written", { reportPath: config.reportPath });
    return report;
  } finally {
    // Teardown ALWAYS runs — a failed/aborted run must not leave harness data.
    log.info("Tearing down harness writes", { agentId });
    const allSourceIds = [...qdrantSourceIds, ...mem0SourceIds];
    try {
      await qdrant.deleteSourceVectors(qdrantSourceIds);
      await mem0.deleteSourceVectors(mem0SourceIds);
      await deletePostgresRows(agentId, allSourceIds);
      const residual = await countResidualRows(agentId);
      if (residual.sources > 0 || residual.chunkMap > 0) {
        log.warn("Teardown left residual harness rows", residual);
      } else {
        log.info("Teardown clean — zero residual harness rows");
      }
    } catch (err) {
      log.error("Teardown failed — manual cleanup may be required", {
        agentId,
        err,
      });
    }
  }
}
