import { createLogger } from "../../logger";
import { createMemoryIndexer } from "../indexer";
import { createMemorySearch } from "../search";
import type { QdrantClient } from "../qdrant";
import type { EmbeddingProvider } from "../types";
import type { MemoryBackend } from "./types";

const log = createLogger("memory-backend-qdrant");

/**
 * Configuration for the Qdrant-backed memory backend. Mirrors the storage-facing
 * subset of the manager's config — the knobs the indexer and hybrid search
 * helpers consume.
 */
export interface QdrantBackendConfig {
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

/**
 * The default, live memory backend: Postgres rows + Qdrant vectors + Postgres
 * FTS. This is a thin composition over the existing `createMemoryIndexer` and
 * `createMemorySearch` helpers plus direct Qdrant point deletion — it does NOT
 * reimplement any storage logic, it just presents that logic behind the
 * {@link MemoryBackend} seam so a future backend can be swapped in.
 *
 * Behavior is byte-for-byte identical to the pre-seam manager: the indexer and
 * search instances are constructed with exactly the same config they received
 * before.
 */
export function createQdrantBackend(
  config: QdrantBackendConfig,
): MemoryBackend {
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
    // --- Indexing (delegated verbatim to the existing indexer) ---
    indexNote: (agentId, content, metadata) =>
      indexer.indexNote(agentId, content, metadata),
    indexTweets: (agentId, tweets, metadata) =>
      indexer.indexTweets(agentId, tweets, metadata),
    indexArticles: (agentId, articles, metadata) =>
      indexer.indexArticles(agentId, articles, metadata),
    indexProducts: (agentId, products, metadata) =>
      indexer.indexProducts(agentId, products, metadata),
    indexStories: (agentId, stories, metadata) =>
      indexer.indexStories(agentId, stories, metadata),
    indexRedditPosts: (agentId, posts, metadata) =>
      indexer.indexRedditPosts(agentId, posts, metadata),
    indexGithubRepos: (agentId, repos, metadata) =>
      indexer.indexGithubRepos(agentId, repos, metadata),
    indexObservations: (agentId, observations, metadata) =>
      indexer.indexObservations(agentId, observations, metadata),
    indexIdea: (agentId, idea, metadata) =>
      indexer.indexIdea(agentId, idea, metadata),
    indexAppReviews: (agentId, reviews, metadata) =>
      indexer.indexAppReviews(agentId, reviews, metadata),
    indexAppRankings: (agentId, rankings, metadata) =>
      indexer.indexAppRankings(agentId, rankings, metadata),
    deleteSourceChunks: (sourceId) => indexer.deleteSourceChunks(sourceId),

    // --- Retrieval (delegated verbatim to the existing hybrid search) ---
    search: (agentId, query, opts) => search.search(agentId, query, opts),

    // --- Store-specific vector deletion (used during eviction) ---
    async deleteSourceVectors(sourceIds) {
      if (!config.qdrantClient?.available) return;
      for (const sourceId of sourceIds) {
        config.qdrantClient
          .deletePoints(config.qdrantCollection, {
            must: [{ key: "sourceId", match: { value: sourceId } }],
          })
          .catch((err) =>
            log.error("Qdrant eviction delete failed", { sourceId, err }),
          );
      }
    },
  };
}
