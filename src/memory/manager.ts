import { getDb } from "../store/db";
import { createLogger } from "../logger";
import { createMemoryBackend } from "./backend/factory";
import type { MemoryBackend, MemoryBackendKind } from "./backend/types";
import type {
  EmbeddingProvider,
  EvictionResult,
  MemoryManager,
  MemoryStats,
  SearchOptions,
  SearchResult,
} from "./types";
import type { QdrantClient } from "./qdrant";

const log = createLogger("memory-manager");

interface ManagerConfig {
  readonly embeddingProvider: EmbeddingProvider | null;
  readonly qdrantClient: QdrantClient | null;
  readonly qdrantCollection: string;
  readonly shared?: boolean;
  readonly defaultLimit?: number;
  readonly minScore?: number;
  readonly vectorWeight?: number;
  readonly textWeight?: number;
  readonly mmrLambda?: number;
  /**
   * Which storage backend to use. Defaults to `qdrant` (the live backend), so
   * existing construction sites that omit it keep identical behavior.
   */
  readonly backend?: MemoryBackendKind;
  /**
   * mem0 backend dependencies. Only consumed when `backend === "mem0"`; the
   * qdrant path ignores them, so omitting them keeps existing behavior. The
   * client reuses SIGE's circuit-broken Mem0Client (never a second HTTP client).
   */
  readonly mem0Client?: import("../sige/knowledge/mem0-client").Mem0Client | null;
  readonly mem0SharedUserId?: string;
}

interface StatsRow {
  source_count: number;
  chunk_count: number;
  total_tokens: number;
}

interface StaleSourceRow {
  id: string;
  chunk_count: number;
}

export function createMemoryManager(config: ManagerConfig): MemoryManager {
  const backend: MemoryBackend = createMemoryBackend(
    config.backend ?? "qdrant",
    {
      embeddingProvider: config.embeddingProvider,
      qdrantClient: config.qdrantClient,
      qdrantCollection: config.qdrantCollection,
      shared: config.shared,
      defaultLimit: config.defaultLimit,
      minScore: config.minScore,
      vectorWeight: config.vectorWeight,
      textWeight: config.textWeight,
      mmrLambda: config.mmrLambda,
      mem0Client: config.mem0Client,
      mem0SharedUserId: config.mem0SharedUserId,
    },
  );

  return {
    async indexTweets(agentId, tweets, metadata): Promise<string> {
      try {
        return await backend.indexTweets(agentId, tweets, metadata);
      } catch (error) {
        log.error("Failed to index tweets", { agentId, error });
        throw error;
      }
    },

    async indexArticles(agentId, articles, metadata): Promise<string> {
      try {
        return await backend.indexArticles(agentId, articles, metadata);
      } catch (error) {
        log.error("Failed to index articles", { agentId, error });
        throw error;
      }
    },

    async indexProducts(agentId, products, metadata): Promise<string> {
      try {
        return await backend.indexProducts(agentId, products, metadata);
      } catch (error) {
        log.error("Failed to index products", { agentId, error });
        throw error;
      }
    },

    async indexStories(agentId, stories, metadata): Promise<string> {
      try {
        return await backend.indexStories(agentId, stories, metadata);
      } catch (error) {
        log.error("Failed to index stories", { agentId, error });
        throw error;
      }
    },

    async indexRedditPosts(agentId, posts, metadata): Promise<string> {
      try {
        return await backend.indexRedditPosts(agentId, posts, metadata);
      } catch (error) {
        log.error("Failed to index reddit posts", { agentId, error });
        throw error;
      }
    },

    async indexGithubRepos(agentId, repos, metadata): Promise<string> {
      try {
        return await backend.indexGithubRepos(agentId, repos, metadata);
      } catch (error) {
        log.error("Failed to index GitHub repos", { agentId, error });
        throw error;
      }
    },

    async indexObservations(agentId, observations, metadata): Promise<string> {
      try {
        return await backend.indexObservations(agentId, observations, metadata);
      } catch (error) {
        log.error("Failed to index observations", { agentId, error });
        throw error;
      }
    },

    async indexIdea(agentId, idea, metadata): Promise<string> {
      try {
        return await backend.indexIdea(agentId, idea, metadata);
      } catch (error) {
        log.error("Failed to index idea", { agentId, error });
        throw error;
      }
    },

    async indexAppReviews(agentId, reviews, metadata): Promise<string> {
      try {
        return await backend.indexAppReviews(agentId, reviews, metadata);
      } catch (error) {
        log.error("Failed to index app reviews", { agentId, error });
        throw error;
      }
    },

    async indexAppRankings(agentId, rankings, metadata): Promise<string> {
      try {
        return await backend.indexAppRankings(agentId, rankings, metadata);
      } catch (error) {
        log.error("Failed to index app rankings", { agentId, error });
        throw error;
      }
    },

    async search(
      agentId: string,
      query: string,
      opts?: SearchOptions,
    ): Promise<readonly SearchResult[]> {
      return backend.search(agentId, query, opts);
    },

    async getStats(agentId?: string): Promise<MemoryStats> {
      const db = getDb();

      let rows;
      if (agentId) {
        rows = await db`
          SELECT
            COUNT(DISTINCT ms.id) as source_count,
            COUNT(mc.id) as chunk_count,
            COALESCE(SUM(mc.token_count), 0) as total_tokens
          FROM memory_sources ms
          LEFT JOIN memory_chunks mc ON mc.source_id = ms.id
          WHERE ms.agent_id = ${agentId}
        `;
      } else {
        rows = await db`
          SELECT
            COUNT(DISTINCT ms.id) as source_count,
            COUNT(mc.id) as chunk_count,
            COALESCE(SUM(mc.token_count), 0) as total_tokens
          FROM memory_sources ms
          LEFT JOIN memory_chunks mc ON mc.source_id = ms.id
        `;
      }

      const row = rows[0] as StatsRow | undefined;

      return {
        sourceCount: Number(row?.source_count ?? 0),
        chunkCount: Number(row?.chunk_count ?? 0),
        totalTokens: Number(row?.total_tokens ?? 0),
      };
    },

    async evict(evictConfig: {
      readonly ttlDays: number;
      readonly batchSize: number;
    }): Promise<EvictionResult> {
      const db = getDb();
      const cutoffEpoch =
        Math.floor(Date.now() / 1000) - evictConfig.ttlDays * 86400;

      let sourcesDeleted = 0;
      let chunksDeleted = 0;

      try {
        const staleRows = await db<StaleSourceRow[]>`
          SELECT ms.id, COUNT(mc.id)::int AS chunk_count
          FROM memory_sources ms
          LEFT JOIN memory_chunks mc ON mc.source_id = ms.id
          WHERE ms.created_at < ${cutoffEpoch}
          GROUP BY ms.id
          LIMIT ${evictConfig.batchSize}
        `;

        if (staleRows.length === 0) {
          return { sourcesDeleted: 0, chunksDeleted: 0 };
        }

        const sourceIds = staleRows.map((r) => r.id);
        chunksDeleted = staleRows.reduce(
          (sum, r) => sum + Number(r.chunk_count),
          0,
        );

        await db`DELETE FROM memory_sources WHERE id IN ${db(sourceIds)}`;
        sourcesDeleted = sourceIds.length;

        await backend.deleteSourceVectors(sourceIds);

        log.info("Memory eviction completed", {
          sourcesDeleted,
          chunksDeleted,
          ttlDays: evictConfig.ttlDays,
          cutoffEpoch,
        });
      } catch (err) {
        log.error("Memory eviction failed", { err });
        throw err;
      }

      return { sourcesDeleted, chunksDeleted };
    },
  };
}
