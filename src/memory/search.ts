import { getDb } from "../store/db";
import { createLogger } from "../logger";
import type {
  EmbeddingProvider,
  MemoryChunk,
  MemorySearch,
  MemorySource,
  MemorySourceKind,
} from "./types";
import type { QdrantClient, QdrantFilter, QdrantSearchOptions } from "./qdrant";
import { ftsSearch } from "./fts";
import { expandQuery } from "./query-expansion";
import { applyTemporalDecay } from "./temporal-decay";
import { applyMmr } from "./mmr";
import { createEmbeddingCache } from "./embedding-cache";
import { getTemporalHalfLife } from "./temporal-profiles";

const log = createLogger("memory-search");

interface SearchConfig {
  readonly embeddingProvider: EmbeddingProvider | null;
  readonly qdrantClient: QdrantClient | null;
  readonly qdrantCollection: string;
  readonly defaultLimit?: number;
  readonly defaultMinScore?: number;
  readonly shared?: boolean;
  readonly vectorWeight?: number;
  readonly textWeight?: number;
  readonly mmrLambda?: number;
}

interface ChunkRow {
  id: string;
  source_id: string;
  content: string;
  chunk_index: number;
  token_count: number;
  created_at: number;
}

interface SourceRow {
  id: string;
  kind: string;
  agent_id: string;
  channel: string | null;
  chat_id: string | null;
  metadata_json: string;
  created_at: number;
}

function rowToSource(row: SourceRow): MemorySource {
  return {
    id: row.id,
    kind: row.kind as MemorySourceKind,
    agentId: row.agent_id,
    channel: row.channel,
    chatId: row.chat_id,
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at,
  };
}

function rowToChunk(row: ChunkRow): MemoryChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    content: row.content,
    chunkIndex: row.chunk_index,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuids(ids: readonly string[]): void {
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid UUID in memory query: ${id}`);
    }
  }
}

export function createMemorySearch(config: SearchConfig): MemorySearch {
  const defaultLimit = config.defaultLimit ?? 5;
  const defaultMinScore = config.defaultMinScore ?? 0.3;
  const vectorWeight = config.vectorWeight ?? 0.7;
  const textWeight = config.textWeight ?? 0.3;
  const mmrLambda = config.mmrLambda ?? 0.7;
  const queryEmbeddingCache = createEmbeddingCache();

  function buildQdrantFilter(
    agentId: string,
    kinds?: readonly MemorySourceKind[],
  ): QdrantFilter | undefined {
    const conditions: { key: string; match: { value: string } }[] = [];

    // Scope to agent unless shared mode
    if (!config.shared) {
      conditions.push({ key: "agentId", match: { value: agentId } });
    }

    // Filter by kind directly in Qdrant
    if (kinds && kinds.length === 1) {
      conditions.push({ key: "kind", match: { value: kinds[0]! } });
    }

    return conditions.length > 0 ? { must: conditions } : undefined;
  }

  async function vectorSearch(
    agentId: string,
    query: string,
    limit: number,
    minScore: number,
    kinds?: readonly MemorySourceKind[],
  ): Promise<Map<string, number>> {
    if (!config.embeddingProvider) return new Map();
    if (!config.qdrantClient?.available) return new Map();

    // Check cache first to avoid redundant embedding API calls
    let queryEmbedding = queryEmbeddingCache.get(query);
    if (!queryEmbedding) {
      try {
        const [embedded] = await config.embeddingProvider.embed([query]);
        if (!embedded) return new Map();
        queryEmbeddingCache.set(query, embedded);
        queryEmbedding = embedded;
      } catch {
        // Embedding timeout — degrade gracefully to FTS-only
        return new Map();
      }
    }

    const filter = buildQdrantFilter(agentId, kinds);

    // If multiple kinds, over-fetch to allow app-level filtering for multi-kind queries.
    // Single kind or no kind filter is handled in Qdrant directly.
    const needsAppKindFilter = kinds && kinds.length > 1;
    const fetchLimit = needsAppKindFilter ? Math.ceil(limit * 1.3) : limit;

    const opts: QdrantSearchOptions = {
      filter,
      scoreThreshold: minScore,
    };

    const results = await config.qdrantClient.searchPoints(
      config.qdrantCollection,
      Array.from(queryEmbedding),
      fetchLimit,
      opts,
    );

    const scores = new Map<string, number>();
    for (const hit of results) {
      scores.set(String(hit.id), hit.score);
    }

    return scores;
  }

  async function batchLoadChunksAndSources(
    chunkIds: readonly string[],
  ): Promise<Map<string, { chunk: MemoryChunk; source: MemorySource }>> {
    if (chunkIds.length === 0) return new Map();
    const db = getDb();

    // Validate IDs are UUIDs before interpolating into PostgreSQL array literal
    assertUuids(chunkIds);

    // Load all chunks in one query
    // Use PostgreSQL array literal format — Bun.sql misformats JS arrays in ANY()
    const chunkPgArray = `{${chunkIds.join(",")}}`;
    const chunkRows = (await db`
      SELECT id, source_id, content, chunk_index, token_count, created_at
      FROM memory_chunks WHERE id = ANY(${chunkPgArray}::text[])
    `) as ChunkRow[];

    if (chunkRows.length === 0) return new Map();

    // Deduplicate source IDs and load all sources in one query
    const sourceIds = [...new Set(chunkRows.map((r) => r.source_id))];
    assertUuids(sourceIds);

    const sourcePgArray = `{${sourceIds.join(",")}}`;
    const sourceRows = (await db`
      SELECT id, kind, agent_id, channel, chat_id, metadata_json, created_at
      FROM memory_sources WHERE id = ANY(${sourcePgArray}::text[])
    `) as SourceRow[];

    const sourceMap = new Map(sourceRows.map((r) => [r.id, rowToSource(r)]));

    const result = new Map<
      string,
      { chunk: MemoryChunk; source: MemorySource }
    >();
    for (const chunkRow of chunkRows) {
      const source = sourceMap.get(chunkRow.source_id);
      if (source) {
        result.set(chunkRow.id, { chunk: rowToChunk(chunkRow), source });
      }
    }
    return result;
  }

  return {
    async search(agentId, query, opts) {
      const limit = opts?.limit ?? defaultLimit;
      const minScore = opts?.minScore ?? defaultMinScore;
      const kinds = opts?.kinds;
      const channelFilter = opts?.channel;
      const now = Math.floor(Date.now() / 1000);

      // 1. Parallel hybrid search: vector + FTS concurrently
      const { ftsQuery } = expandQuery(query);
      const [vectorScores, ftsResults] = await Promise.all([
        vectorSearch(agentId, query, Math.ceil(limit * 1.3), minScore, kinds),
        ftsSearch(agentId, ftsQuery, Math.ceil(limit * 1.3), { shared: config.shared }),
      ]);

      // Build a map of FTS scores keyed by chunk ID
      const ftsScoreMap = new Map<string, number>();
      for (const hit of ftsResults) {
        ftsScoreMap.set(hit.chunkId, hit.rank);
      }

      // 2. Merge scores: collect all unique chunk IDs from both sources
      const allChunkIds = new Set([
        ...vectorScores.keys(),
        ...ftsScoreMap.keys(),
      ]);

      if (allChunkIds.size === 0) {
        log.debug("Search completed with no results (vector + FTS)", {
          agentId,
          query: query.slice(0, 50),
        });
        return [];
      }

      // Normalize FTS scores to 0-1 range for merging with vector scores
      let maxFts = 0;
      for (const rank of ftsScoreMap.values()) {
        if (rank > maxFts) maxFts = rank;
      }

      const mergedScores = new Map<string, number>();
      for (const chunkId of allChunkIds) {
        const vScore = vectorScores.get(chunkId) ?? 0;
        const fScore =
          maxFts > 0 ? (ftsScoreMap.get(chunkId) ?? 0) / maxFts : 0;
        mergedScores.set(chunkId, vectorWeight * vScore + textWeight * fScore);
      }

      // Load all chunks and sources
      const loaded = await batchLoadChunksAndSources([...allChunkIds]);

      // 3. Build results with merged scores
      const multiKindSet = kinds && kinds.length > 1 ? new Set(kinds) : null;
      const singleKind = kinds && kinds.length === 1 ? kinds[0] : null;

      let results = [];
      for (const [chunkId, score] of mergedScores) {
        const entry = loaded.get(chunkId);
        if (!entry) continue;

        // Kind filtering for multi-kind (single kind already filtered by Qdrant/FTS)
        if (multiKindSet && !multiKindSet.has(entry.source.kind)) continue;
        if (singleKind && entry.source.kind !== singleKind) continue;

        // 4. Channel scope: conversation memories from other channels are excluded
        if (
          channelFilter &&
          entry.source.kind === "conversation" &&
          entry.source.channel &&
          entry.source.channel !== channelFilter
        ) {
          continue;
        }

        // 5. Temporal decay (per-kind half-life)
        const decayedScore = applyTemporalDecay(
          score,
          entry.chunk.createdAt,
          now,
          getTemporalHalfLife(entry.source.kind),
        );

        results.push({
          chunk: entry.chunk,
          source: entry.source,
          score: decayedScore,
        });
      }

      // 6. Sort by decayed score
      results.sort((a, b) => b.score - a.score);

      // 7. MMR deduplication
      results = [...applyMmr(results, mmrLambda, limit)];

      log.debug("Hybrid search completed", {
        agentId,
        query: query.slice(0, 50),
        vectorHits: vectorScores.size,
        ftsHits: ftsResults.length,
        merged: allChunkIds.size,
        results: results.length,
      });

      return results;
    },
  };
}
