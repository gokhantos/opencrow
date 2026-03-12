import { getDb } from "../store/db";
import { createMemoryIndexer } from "./indexer";
import { createMemorySearch } from "./search";
import { createLogger } from "../logger";
import type {
  ArticleForIndex,
  ProductForIndex,
  RedditPostForIndex,
  StoryForIndex,
  GithubRepoForIndex,
  ObservationForIndex,
  IdeaForIndex,
  AppReviewForIndex,
  AppRankingForIndex,
  EmbeddingProvider,
  EvictionResult,
  MemoryManager,
  MemoryStats,
  SearchOptions,
  SearchResult,
  TweetForIndex,
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
  const indexer = createMemoryIndexer({
    embeddingProvider: config.embeddingProvider,
    qdrantClient: config.qdrantClient,
    qdrantCollection: config.qdrantCollection,
  });

  const search = createMemorySearch({
    embeddingProvider: config.embeddingProvider,
    qdrantClient: config.qdrantClient,
    qdrantCollection: config.qdrantCollection,
    shared: config.shared,
    defaultLimit: config.defaultLimit,
    defaultMinScore: config.minScore,
    vectorWeight: config.vectorWeight,
    textWeight: config.textWeight,
    mmrLambda: config.mmrLambda,
  });

  return {
    async indexTweets(
      agentId: string,
      tweets: readonly TweetForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexTweets(agentId, tweets, metadata);
      } catch (error) {
        log.error("Failed to index tweets", { agentId, error });
        throw error;
      }
    },

    async indexArticles(
      agentId: string,
      articles: readonly ArticleForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexArticles(agentId, articles, metadata);
      } catch (error) {
        log.error("Failed to index articles", { agentId, error });
        throw error;
      }
    },

    async indexProducts(
      agentId: string,
      products: readonly ProductForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexProducts(agentId, products, metadata);
      } catch (error) {
        log.error("Failed to index products", { agentId, error });
        throw error;
      }
    },

    async indexStories(
      agentId: string,
      stories: readonly StoryForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexStories(agentId, stories, metadata);
      } catch (error) {
        log.error("Failed to index stories", { agentId, error });
        throw error;
      }
    },

    async indexRedditPosts(
      agentId: string,
      posts: readonly RedditPostForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexRedditPosts(agentId, posts, metadata);
      } catch (error) {
        log.error("Failed to index reddit posts", { agentId, error });
        throw error;
      }
    },

    async indexGithubRepos(
      agentId: string,
      repos: readonly GithubRepoForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexGithubRepos(agentId, repos, metadata);
      } catch (error) {
        log.error("Failed to index GitHub repos", { agentId, error });
        throw error;
      }
    },

    async indexObservations(
      agentId: string,
      observations: readonly ObservationForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexObservations(agentId, observations, metadata);
      } catch (error) {
        log.error("Failed to index observations", { agentId, error });
        throw error;
      }
    },

    async indexIdea(
      agentId: string,
      idea: IdeaForIndex,
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexIdea(agentId, idea, metadata);
      } catch (error) {
        log.error("Failed to index idea", { agentId, error });
        throw error;
      }
    },

    async indexAppReviews(
      agentId: string,
      reviews: readonly AppReviewForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexAppReviews(agentId, reviews, metadata);
      } catch (error) {
        log.error("Failed to index app reviews", { agentId, error });
        throw error;
      }
    },

    async indexAppRankings(
      agentId: string,
      rankings: readonly AppRankingForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexAppRankings(agentId, rankings, metadata);
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
      return search.search(agentId, query, opts);
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

        if (config.qdrantClient?.available) {
          for (const sourceId of sourceIds) {
            config.qdrantClient
              .deletePoints(config.qdrantCollection, {
                must: [{ key: "sourceId", match: { value: sourceId } }],
              })
              .catch((err) =>
                log.error("Qdrant eviction delete failed", { sourceId, err }),
              );
          }
        }

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
