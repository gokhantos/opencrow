import type { SQL } from "bun";
import { createLogger } from "../../logger";
import type { Mem0Client } from "../../sige/knowledge/mem0-client";
import { recordMem0Ids } from "../backend/mem0-chunk-map";
import { buildChunkMetadata } from "../backend/mem0-mapping";
import type { MemorySourceKind } from "../types";
import {
  countSources,
  isAlreadyBackfilled,
  readChunks,
  readSourcesPage,
  type BackfillSource,
} from "./dal";
import { resolveBackfillUserId, type BackfillScoping } from "./scoping";

const log = createLogger("mem0-backfill");

type Db = InstanceType<typeof SQL>;

/** Options driving one backfill run. */
export interface BackfillOptions {
  readonly scoping: BackfillScoping;
  /** Filter to these kinds (omit = all kinds). */
  readonly kinds?: readonly MemorySourceKind[];
  /** Filter to one agent (omit = all agents). */
  readonly agentId?: string;
  /** Stop after processing this many sources (omit = all). */
  readonly limit?: number;
  /** Sources fetched + processed per page. */
  readonly batchSize: number;
  /**
   * Max sources written concurrently. Keep modest (3–4): the mem0 sidecar is
   * shared with other sessions and slow even with infer:false.
   */
  readonly concurrency: number;
  /** Count-only: report what WOULD be written, write nothing. */
  readonly dryRun: boolean;
}

/** Aggregate outcome of a run. */
export interface BackfillResult {
  /** Sources considered (matched filters, within limit). */
  readonly processed: number;
  /** Sources newly written to mem0 this run. */
  readonly written: number;
  /** Sources skipped because already in mem0_chunk_map. */
  readonly skipped: number;
  /** Sources with zero chunks (nothing to write). */
  readonly empty: number;
  /** mem0 memories written across all sources. */
  readonly memories: number;
}

const ZERO_RESULT: BackfillResult = {
  processed: 0,
  written: 0,
  skipped: 0,
  empty: 0,
  memories: 0,
};

function addResults(a: BackfillResult, b: BackfillResult): BackfillResult {
  return {
    processed: a.processed + b.processed,
    written: a.written + b.written,
    skipped: a.skipped + b.skipped,
    empty: a.empty + b.empty,
    memories: a.memories + b.memories,
  };
}

/**
 * Backfill ONE source into mem0, mirroring the mem0 backend's `writeGroups`
 * write path EXACTLY:
 *   - same reserved metadata via `buildChunkMetadata` (source_type, source_id
 *     PRESERVED from the original row, agent_id, chunk_index, created_at, channel
 *     when present), with the source's stored caller metadata merged underneath;
 *   - `infer:false`, `enableGraph:false`;
 *   - the same `user_id` the live backend would resolve for this source;
 *   - records every returned mem0 id in `mem0_chunk_map` under the ORIGINAL
 *     source id, so delete-by-source/eviction works post-flip.
 *
 * Idempotency: a source already present in `mem0_chunk_map` is skipped (it was
 * backfilled or live-indexed already). `dryRun` writes nothing.
 *
 * Does NOT write a `memory_sources` row — the row already exists (that is what we
 * are reading from), so eviction/stats already see this source. Re-creating it
 * would be redundant.
 */
async function backfillSource(
  db: Db,
  client: Mem0Client,
  source: BackfillSource,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  if (await isAlreadyBackfilled(db, source.id)) {
    log.debug("Skipping already-backfilled source", { sourceId: source.id });
    return { ...ZERO_RESULT, processed: 1, skipped: 1 };
  }

  const chunks = await readChunks(db, source.id);
  if (chunks.length === 0) {
    return { ...ZERO_RESULT, processed: 1, empty: 1 };
  }

  const userId = resolveBackfillUserId(opts.scoping, source);
  // The Qdrant indexer always stored channel/chat_id as null on memory_sources;
  // pass through whatever is on the row so non-null channels (if any ever exist)
  // round-trip into mem0 metadata exactly as the live path would.
  const channel = source.channel ?? undefined;

  if (opts.dryRun) {
    // Count what WOULD be written; touch nothing.
    return {
      ...ZERO_RESULT,
      processed: 1,
      written: 1,
      memories: chunks.length,
    };
  }

  const mem0Ids: string[] = [];
  for (const chunk of chunks) {
    const metadata = buildChunkMetadata({
      kind: source.kind,
      sourceId: source.id,
      agentId: source.agentId,
      chunkIndex: chunk.chunkIndex,
      createdAt: source.createdAt,
      channel,
      callerMetadata: { ...source.metadata },
    });

    const result = await client.addMemory({
      content: chunk.content,
      userId,
      infer: false,
      enableGraph: false,
      metadata,
    });
    for (const mem of result.memories) {
      mem0Ids.push(mem.id);
    }
  }

  if (mem0Ids.length > 0) {
    await recordMem0Ids(db, source.id, mem0Ids);
  }

  log.debug("Backfilled source", {
    sourceId: source.id,
    kind: source.kind,
    userId,
    chunks: chunks.length,
    memories: mem0Ids.length,
  });

  return {
    ...ZERO_RESULT,
    processed: 1,
    written: 1,
    memories: mem0Ids.length,
  };
}

/** Process an array of sources with a bounded concurrency cap. */
async function processWithConcurrency(
  db: Db,
  client: Mem0Client,
  sources: readonly BackfillSource[],
  opts: BackfillOptions,
): Promise<BackfillResult> {
  let acc = ZERO_RESULT;
  for (let i = 0; i < sources.length; i += opts.concurrency) {
    const slice = sources.slice(i, i + opts.concurrency);
    const results = await Promise.all(
      slice.map((s) => backfillSource(db, client, s, opts)),
    );
    for (const r of results) acc = addResults(acc, r);
  }
  return acc;
}

/**
 * Run the backfill over all matching sources, paging deterministically by
 * (created_at, id) so a re-run resumes safely (idempotency makes already-written
 * sources cheap no-ops). Logs per-batch progress and timing.
 *
 * Reads `memory_sources`/`memory_chunks`; writes ONLY mem0 (via the client) and
 * `mem0_chunk_map`. Never deletes or mutates Qdrant or the source/chunk tables.
 */
export async function runBackfill(
  db: Db,
  client: Mem0Client,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const total = await countSources(db, {
    kinds: opts.kinds,
    agentId: opts.agentId,
  });
  const target = opts.limit !== undefined ? Math.min(opts.limit, total) : total;

  log.info("Backfill starting", {
    matchingSources: total,
    target,
    kinds: opts.kinds ?? "all",
    agentId: opts.agentId ?? "all",
    shared: opts.scoping.shared,
    sharedUserId: opts.scoping.sharedUserId,
    batchSize: opts.batchSize,
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
  });

  let acc = ZERO_RESULT;
  let offset = 0;

  while (acc.processed < target) {
    const remaining = target - acc.processed;
    const pageSize = Math.min(opts.batchSize, remaining);
    const page = await readSourcesPage(db, {
      kinds: opts.kinds,
      agentId: opts.agentId,
      limit: pageSize,
      offset,
    });
    if (page.length === 0) break;

    const startedAt = Date.now();
    const batch = await processWithConcurrency(db, client, page, opts);
    acc = addResults(acc, batch);

    log.info("Backfill batch done", {
      offset,
      batch: page.length,
      written: batch.written,
      skipped: batch.skipped,
      empty: batch.empty,
      memories: batch.memories,
      elapsedMs: Date.now() - startedAt,
      progress: `${acc.processed}/${target}`,
    });

    offset += page.length;
  }

  log.info("Backfill complete", {
    processed: acc.processed,
    written: acc.written,
    skipped: acc.skipped,
    empty: acc.empty,
    memories: acc.memories,
    dryRun: opts.dryRun,
  });

  return acc;
}
