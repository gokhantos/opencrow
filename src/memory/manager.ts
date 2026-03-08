import { getDb } from "../store/db";
import { createMemoryIndexer } from "./indexer";
import { createMemorySearch } from "./search";
import { createLogger } from "../logger";
import type {
  ArticleForIndex,
  ProductForIndex,
  RedditPostForIndex,
  StoryForIndex,
  HFModelForIndex,
  GithubRepoForIndex,
  ArxivPaperForIndex,
  ObservationForIndex,
  IdeaForIndex,
  AppReviewForIndex,
  AppRankingForIndex,
  TrendForIndex,
  DefiProtocolForIndex,
  DexTokenForIndex,
  EmbeddingProvider,
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

    async indexHFModels(
      agentId: string,
      models: readonly HFModelForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexHFModels(agentId, models, metadata);
      } catch (error) {
        log.error("Failed to index HF models", { agentId, error });
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

    async indexArxivPapers(
      agentId: string,
      papers: readonly ArxivPaperForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexArxivPapers(agentId, papers, metadata);
      } catch (error) {
        log.error("Failed to index arXiv papers", { agentId, error });
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

    async indexTrends(
      agentId: string,
      trends: readonly TrendForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexTrends(agentId, trends, metadata);
      } catch (error) {
        log.error("Failed to index trends", { agentId, error });
        throw error;
      }
    },

    async indexDefiProtocols(
      agentId: string,
      protocols: readonly DefiProtocolForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexDefiProtocols(agentId, protocols, metadata);
      } catch (error) {
        log.error("Failed to index DeFi protocols", { agentId, error });
        throw error;
      }
    },

    async indexDexTokens(
      agentId: string,
      tokens: readonly DexTokenForIndex[],
      metadata?: Record<string, string>,
    ): Promise<string> {
      try {
        return await indexer.indexDexTokens(agentId, tokens, metadata);
      } catch (error) {
        log.error("Failed to index DEX tokens", { agentId, error });
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
  };
}
