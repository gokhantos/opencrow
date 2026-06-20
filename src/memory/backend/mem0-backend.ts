import { createLogger } from "../../logger";
import type { Mem0Client } from "../../sige/knowledge/mem0-client";
import { getDb } from "../../store/db";
import {
  buildAppRankingChunks,
  buildAppReviewChunks,
  buildArticleChunks,
  buildGithubChunks,
  buildIdeaChunks,
  buildNoteChunks,
  buildObservationChunks,
  buildProductChunks,
  buildRedditChunks,
  buildStoryChunks,
  buildTweetChunks,
  type ChunkGroup,
} from "./chunk-builders";
import {
  deleteMem0Map,
  getMem0Ids,
  recordMem0Ids,
} from "./mem0-chunk-map";
import { buildChunkMetadata, mem0HitToSearchResult } from "./mem0-mapping";
import { insertMemorySource } from "./memory-sources-dal";
import type { MemoryBackend } from "./types";
import type { Mem0Memory } from "../../sige/knowledge/mem0-client";
import type { SearchOptions, SearchResult } from "../types";

const log = createLogger("memory-backend-mem0");

/**
 * Configuration for the mem0-backed memory backend.
 *
 * Unlike the Qdrant backend, this one stores chunks AS mem0 memories (one
 * memory per chunk, `infer:false` so they are verbatim, `enable_graph:false` so
 * no relation extraction runs) and reconstructs results from mem0 metadata —
 * there are no Postgres chunk/source rows in this path. The only Postgres state
 * is the `mem0_chunk_map` table, used to delete a source's memories by id.
 */
export interface Mem0BackendConfig {
  readonly mem0Client: Mem0Client;
  /** user_id for the shared scraped pool when `shared` is true. */
  readonly sharedUserId: string;
  /** Mirror the Qdrant backend's shared/per-agent scoping axis. */
  readonly shared?: boolean;
  readonly defaultLimit?: number;
  readonly minScore?: number;
}

/**
 * Resolve the mem0 `user_id` write/read axis. In shared mode (the scraped pool)
 * every agent reads/writes the same `sharedUserId`; otherwise each agent is
 * scoped to its own `agentId`. This is the SAME axis the Qdrant backend's
 * `shared` flag selects (agent filter on vs off), kept deliberately distinct
 * from SIGE's `sige-global`/`sige-ideas` userIds.
 */
function resolveUserId(
  config: Mem0BackendConfig,
  agentId: string,
): string {
  return config.shared ? config.sharedUserId : agentId;
}

export function createMem0Backend(config: Mem0BackendConfig): MemoryBackend {
  const defaultLimit = config.defaultLimit ?? 5;
  const defaultMinScore = config.minScore ?? 0.3;

  /**
   * Write every chunk of every group as an individual mem0 memory and record
   * the returned mem0 ids in `mem0_chunk_map`. Returns the generated sourceId.
   * A single source row is conceptually represented by all (sourceId, mem0Id)
   * pairs; multiple groups (news/app data) share one sourceId, matching the
   * Qdrant indexer which returns the first group's sourceId per call.
   *
   * Also persists ONE `memory_sources` bookkeeping row keyed by the same
   * sourceId, so `MemoryManager.evict()` (TTL by created_at) and `getStats()`
   * (count by agent_id) work uniformly with the Qdrant path — without it, mem0
   * memories grow unbounded and stats report zero. The row records the FIRST
   * group's kind: multi-kind calls (news by source, app data by store) collapse
   * into one sourceId here, mirroring the existing single-sourceId mem0 design;
   * eviction is unaffected by which kind is stored since it keys on created_at.
   * No `memory_chunks` rows are written — those back the Qdrant/FTS path only,
   * and the manager's LEFT JOIN tolerates their absence.
   *
   * Default `infer:false` for ALL kinds — parity with the Qdrant path's verbatim
   * chunks; this also avoids mem0's extraction LLM cost.
   */
  async function writeGroups(
    agentId: string,
    groups: readonly ChunkGroup[],
    callerMetadata?: Record<string, string>,
  ): Promise<string> {
    const db = getDb();
    const userId = resolveUserId(config, agentId);
    const channel = callerMetadata?.channel;
    const sourceId = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    // Persist the bookkeeping source row first (before any mem0 write) so the
    // manager can find + evict this source even if a later mem0 write fails.
    // Skip empty calls (no groups/chunks) to avoid orphan rows the qdrant path
    // would only create with a real sourceId returned to a caller.
    const firstKind = groups.find((g) => g.chunks.length > 0)?.kind;
    if (firstKind !== undefined) {
      const metadataJson = JSON.stringify(callerMetadata ?? {});
      await insertMemorySource(db, {
        id: sourceId,
        kind: firstKind,
        agentId,
        channel: channel ?? null,
        chatId: null,
        metadataJson,
        createdAt,
      });
    }

    const mem0Ids: string[] = [];
    let chunkIndex = 0;

    for (const group of groups) {
      for (const chunk of group.chunks) {
        const metadata = buildChunkMetadata({
          kind: group.kind,
          sourceId,
          agentId,
          chunkIndex,
          createdAt,
          channel,
          callerMetadata,
        });
        chunkIndex += 1;

        const result = await config.mem0Client.addMemory({
          content: chunk,
          userId,
          infer: false,
          enableGraph: false,
          metadata,
        });
        for (const mem of result.memories) {
          mem0Ids.push(mem.id);
        }
      }
    }

    if (mem0Ids.length > 0) {
      await recordMem0Ids(db, sourceId, mem0Ids);
    }

    log.debug("Indexed source via mem0", {
      agentId,
      sourceId,
      groups: groups.length,
      chunks: chunkIndex,
      memories: mem0Ids.length,
    });

    return sourceId;
  }

  /**
   * Look up a source's mem0 ids, delete each memory, then clear the map rows.
   *
   * `deleteSource` controls the `memory_sources` bookkeeping row:
   *   - caller-driven `deleteSourceChunks` passes `true` so it mirrors the
   *     Qdrant path, which deletes the source row (chunks cascade);
   *   - the eviction path (`deleteSourceVectors`) passes `false` because the
   *     manager has ALREADY deleted the `memory_sources` rows before calling.
   */
  async function deleteBySource(
    sourceId: string,
    deleteSource: boolean,
  ): Promise<void> {
    const db = getDb();
    const ids = await getMem0Ids(db, sourceId);
    for (const id of ids) {
      await config.mem0Client.deleteMemory(id);
    }
    await deleteMem0Map(db, sourceId);
    if (deleteSource) {
      await db`DELETE FROM memory_sources WHERE id = ${sourceId}`;
    }
    log.debug("Deleted source via mem0", { sourceId, memories: ids.length });
  }

  return {
    // --- Indexing: chunk via shared builders, write each chunk as a memory ---
    indexNote: async (agentId, content, metadata) =>
      writeGroups(agentId, await buildNoteChunks(content), metadata),
    indexTweets: async (agentId, tweets, metadata) =>
      writeGroups(agentId, await buildTweetChunks(tweets), metadata),
    indexArticles: async (agentId, articles, metadata) =>
      writeGroups(agentId, await buildArticleChunks(articles), metadata),
    indexProducts: async (agentId, products, metadata) =>
      writeGroups(agentId, await buildProductChunks(products), metadata),
    indexStories: async (agentId, stories, metadata) =>
      writeGroups(agentId, await buildStoryChunks(stories), metadata),
    indexRedditPosts: async (agentId, posts, metadata) =>
      writeGroups(agentId, await buildRedditChunks(posts), metadata),
    indexGithubRepos: async (agentId, repos, metadata) =>
      writeGroups(agentId, await buildGithubChunks(repos), metadata),
    indexObservations: async (agentId, observations, metadata) =>
      writeGroups(agentId, await buildObservationChunks(observations), metadata),
    indexIdea: async (agentId, idea, metadata) =>
      writeGroups(agentId, await buildIdeaChunks(idea), metadata),
    indexAppReviews: async (agentId, reviews, metadata) =>
      writeGroups(agentId, await buildAppReviewChunks(reviews), metadata),
    indexAppRankings: async (agentId, rankings, metadata) =>
      writeGroups(agentId, await buildAppRankingChunks(rankings), metadata),

    // deleteSourceChunks may throw (caller-driven deletion). Removes the
    // memory_sources bookkeeping row too, matching the Qdrant backend.
    deleteSourceChunks: (sourceId) => deleteBySource(sourceId, true),

    // --- Retrieval ---
    search: (agentId, query, opts) => searchMem0(config, agentId, query, opts, {
      defaultLimit,
      defaultMinScore,
    }),

    // --- Eviction vector deletion: best-effort / non-throwing per source ---
    // The manager already deleted the memory_sources rows; only mem0 memories
    // + map rows remain to clear, so pass deleteSource:false.
    async deleteSourceVectors(sourceIds) {
      for (const sourceId of sourceIds) {
        deleteBySource(sourceId, false).catch((err) =>
          log.error("mem0 eviction delete failed", { sourceId, err }),
        );
      }
    },
  };
}

/**
 * mem0 hybrid retrieval. Encodes `agent_id` (skipped in shared mode, exactly
 * like the Qdrant search path) plus `source_type ∈ kinds` into server-side
 * `filters`, then ALWAYS re-applies kinds/channel/minScore client-side as the
 * net (server-side filter support is version-dependent — see Mem0Client.search).
 */
async function searchMem0(
  config: Mem0BackendConfig,
  agentId: string,
  query: string,
  opts: SearchOptions | undefined,
  defaults: { readonly defaultLimit: number; readonly defaultMinScore: number },
): Promise<readonly SearchResult[]> {
  const limit = opts?.limit ?? defaults.defaultLimit;
  const minScore = opts?.minScore ?? defaults.defaultMinScore;
  const kinds = opts?.kinds;
  const channel = opts?.channel;
  const userId = resolveUserId(config, agentId);

  const filters: Record<string, unknown> = {};
  if (!config.shared) {
    filters.agent_id = agentId;
  }
  // Single-kind equality is the only shape the OSS server reliably honours;
  // multi-kind / channel are handled by the client-side net below.
  if (kinds && kinds.length === 1) {
    filters.source_type = kinds[0];
  }

  let memories: readonly Mem0Memory[];
  try {
    const res = await config.mem0Client.search({
      query,
      userId,
      // Over-fetch so the client-side filters still leave enough results.
      limit: Math.ceil(limit * 1.3),
      enableGraph: false,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
    });
    memories = res.memories;
  } catch (err) {
    // mem0 unreachable / breaker open → degrade to no results, never throw.
    log.debug("mem0 search failed, returning no results", { agentId, err });
    return [];
  }

  const kindSet = kinds && kinds.length > 0 ? new Set(kinds) : null;
  const results: SearchResult[] = [];
  for (const hit of memories) {
    const mapped = mem0HitToSearchResult(hit);
    if (!mapped) continue;

    // Client-side net (server filters are version-dependent / best-effort).
    if (kindSet && !kindSet.has(mapped.source.kind)) continue;
    if (mapped.score < minScore) continue;
    if (
      channel &&
      mapped.source.kind === "conversation" &&
      mapped.source.channel &&
      mapped.source.channel !== channel
    ) {
      continue;
    }

    results.push(mapped);
  }

  results.sort((a, b) => b.score - a.score);
  const limited = results.slice(0, limit);

  log.debug("mem0 search completed", {
    agentId,
    query: query.slice(0, 50),
    hits: memories.length,
    results: limited.length,
  });

  return limited;
}
