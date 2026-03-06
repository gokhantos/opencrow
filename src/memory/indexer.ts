import { getDb } from "../store/db";
import { chunkText } from "./chunker";
import { createLogger } from "../logger";
import type {
  ArticleForIndex,
  ProductForIndex,
  RedditPostForIndex,
  StoryForIndex,
  HFModelForIndex,
  GithubRepoForIndex,
  ArxivPaperForIndex,
  ScholarPaperForIndex,
  ObservationForIndex,
  IdeaForIndex,
  EmbeddingProvider,
  MemoryIndexer,
  MemorySourceKind,
  TweetForIndex,
} from "./types";
import type { QdrantClient, QdrantPoint } from "./qdrant";
import { updateChunkFts } from "./fts";
import { getChunkProfile } from "./chunk-profiles";

const log = createLogger("memory-indexer");

interface IndexerConfig {
  readonly embeddingProvider: EmbeddingProvider | null;
  readonly qdrantClient: QdrantClient | null;
  readonly qdrantCollection: string;
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createMemoryIndexer(config: IndexerConfig): MemoryIndexer {
  async function insertChunks(
    sourceId: string,
    agentId: string,
    kind: MemorySourceKind,
    texts: readonly string[],
  ): Promise<void> {
    const db = getDb();

    let embeddings: Float32Array[] | null = null;
    if (config.embeddingProvider) {
      try {
        embeddings = await config.embeddingProvider.embed(texts);
      } catch (error) {
        log.error("Embedding failed, storing without vectors", { error });
      }
    }

    const chunkIds: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    await db.begin(async (tx) => {
      for (let i = 0; i < texts.length; i++) {
        const id = crypto.randomUUID();
        chunkIds.push(id);
        const text = texts[i]!;
        const tokenCount = countTokens(text);

        await tx`
          INSERT INTO memory_chunks (id, source_id, content, chunk_index, token_count, created_at)
          VALUES (${id}, ${sourceId}, ${text}, ${i}, ${tokenCount}, ${now})
        `;
      }
    });

    // Upsert vectors to Qdrant with kind + createdAt in payload
    if (embeddings && config.qdrantClient?.available) {
      try {
        const points: QdrantPoint[] = [];
        for (let i = 0; i < chunkIds.length; i++) {
          const vec = embeddings[i];
          if (vec) {
            points.push({
              id: chunkIds[i]!,
              vector: Array.from(vec),
              payload: {
                sourceId,
                agentId,
                chunkIndex: i,
                kind,
                createdAt: now,
              },
            });
          }
        }
        if (points.length > 0) {
          await config.qdrantClient.upsertPoints(
            config.qdrantCollection,
            points,
          );
        }
      } catch (error) {
        log.error("Qdrant upsert failed, vectors not stored", { error });
      }
    }

    // Update FTS columns non-blocking (failures are silent)
    await Promise.all(chunkIds.map((id, i) => updateChunkFts(id, texts[i]!)));

    log.debug("Indexed chunks", {
      sourceId,
      count: texts.length,
    });
  }

  return {
    async indexTweets(agentId, tweets: readonly TweetForIndex[], metadata) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const tweetIds = tweets.map((t) => t.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        tweetIds,
        tweetCount: String(tweets.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'tweet', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("tweet");
      const chunks = tweets.flatMap((t) => {
        const text = `@${t.authorHandle} (${t.tweetTimestamp}): ${t.text}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "tweet", chunks);
      }

      log.info("Indexed tweets", {
        agentId,
        tweetCount: tweets.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexArticles(
      agentId,
      articles: readonly ArticleForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const articleIds = articles.map((a) => a.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        articleIds,
        articleCount: String(articles.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'article', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("article");
      const chunks = articles.flatMap((a) => {
        const date = new Date(a.publishedAt * 1000).toISOString().slice(0, 16);
        const snippet = a.content ? ` — ${a.content.slice(0, 200)}` : "";
        const text = `[${a.category}] ${a.title} (${a.sourceName}, ${date})${snippet}\n${a.url}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "article", chunks);
      }

      log.info("Indexed articles", {
        agentId,
        articleCount: articles.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexProducts(
      agentId,
      products: readonly ProductForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const productIds = products.map((p) => p.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        productIds,
        productCount: String(products.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'product', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("product");
      const chunks = products.flatMap((p) => {
        const rank = p.rank ? `#${p.rank}` : "unranked";
        const topics = p.topics.length > 0 ? p.topics.join(", ") : "none";
        const stats = `${p.votesCount} votes, ${p.commentsCount} comments`;
        const makersLine =
          p.makers.length > 0 ? `\nMakers: ${p.makers.join(", ")}` : "";
        const reviewsLine =
          p.reviewsCount > 0
            ? `\nReviews: ${p.reviewsCount} (${p.reviewsRating.toFixed(1)} stars)`
            : "";
        const text = `${p.name} (${rank}, ${stats}): ${p.tagline}\n${p.description}\nTopics: ${topics}${makersLine}${reviewsLine}\nPH: ${p.url} | Website: ${p.websiteUrl}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "product", chunks);
      }

      log.info("Indexed products", {
        agentId,
        productCount: products.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexStories(agentId, stories: readonly StoryForIndex[], metadata) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const storyIds = stories.map((s) => s.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        storyIds,
        storyCount: String(stories.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'story', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("story");
      const chunks = stories.flatMap((s) => {
        const site = s.siteLabel ? ` (${s.siteLabel})` : "";
        const text = `#${s.rank} ${s.title}${site} — ${s.points} pts, ${s.commentCount} comments, by ${s.author}\n${s.url}\nHN: ${s.hnUrl}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "story", chunks);
      }

      log.info("Indexed stories", {
        agentId,
        storyCount: stories.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexRedditPosts(
      agentId,
      posts: readonly RedditPostForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const postIds = posts.map((p) => p.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        postIds,
        postCount: String(posts.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'reddit_post', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("reddit_post");
      const chunks = posts.flatMap((p) => {
        const selftext = p.selftext ? `\n${p.selftext.slice(0, 2000)}` : "";
        const text = `Reddit r/${p.subreddit}: ${p.title}${selftext}\nScore: ${p.score} | Comments: ${p.numComments} | By: u/${p.author}\nURL: ${p.url}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "reddit_post", chunks);
      }

      log.info("Indexed reddit posts", {
        agentId,
        postCount: posts.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexHFModels(agentId, models: readonly HFModelForIndex[], metadata) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const modelIds = models.map((m) => m.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        modelIds,
        modelCount: String(models.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'hf_model', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const hfProfile = getChunkProfile("hf_model");
      const chunks = models.flatMap((m) => {
        const tags =
          m.tags.length > 0 ? ` [${m.tags.slice(0, 8).join(", ")}]` : "";
        const desc = m.description ? `\n${m.description.slice(0, 500)}` : "";
        const text = `HuggingFace: ${m.id} (${m.pipelineTag || "unknown"})${tags}\nDownloads: ${m.downloads} | Likes: ${m.likes} | Trending: ${m.trendingScore}\nLibrary: ${m.libraryName} | Author: ${m.author}${desc}`;
        const itemChunks = chunkText(text, hfProfile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "hf_model", chunks);
      }

      log.info("Indexed HF models", {
        agentId,
        modelCount: models.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexGithubRepos(
      agentId,
      repos: readonly GithubRepoForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const repoIds = repos.map((r) => r.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        repoIds,
        repoCount: String(repos.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'github_repo', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const repoProfile = getChunkProfile("github_repo");
      const chunks = repos.flatMap((r) => {
        const lang = r.language ? ` (${r.language})` : "";
        const contributors =
          r.builtBy.length > 0
            ? `\nBuilt by: ${r.builtBy.slice(0, 5).join(", ")}`
            : "";
        const desc = r.description ? `\n${r.description.slice(0, 500)}` : "";
        const periodLabel = r.period === "weekly" ? "this week" : "today";
        const text = `GitHub: ${r.id}${lang}\nStars: ${r.stars} (+${r.starsToday} ${periodLabel}) | Forks: ${r.forks}${contributors}${desc}\n${r.url}`;
        const itemChunks = chunkText(text, repoProfile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "github_repo", chunks);
      }

      log.info("Indexed GitHub repos", {
        agentId,
        repoCount: repos.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexArxivPapers(
      agentId,
      papers: readonly ArxivPaperForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const paperIds = papers.map((p) => p.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        paperIds,
        paperCount: String(papers.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'arxiv_paper', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("arxiv_paper");
      const chunks = papers.flatMap((p) => {
        const authors =
          p.authors.length > 0
            ? `\nAuthors: ${p.authors.slice(0, 10).join(", ")}`
            : "";
        const cats =
          p.categories.length > 0
            ? `\nCategories: ${p.categories.join(", ")}`
            : "";
        const text = `arXiv [${p.primaryCategory}] ${p.title}${authors}${cats}\n${p.abstract.slice(0, 1500)}\nPDF: ${p.pdfUrl}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "arxiv_paper", chunks);
      }

      log.info("Indexed arXiv papers", {
        agentId,
        paperCount: papers.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexScholarPapers(
      agentId,
      papers: readonly ScholarPaperForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const paperIds = papers.map((p) => p.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        paperIds,
        paperCount: String(papers.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'scholar_paper', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("scholar_paper");
      const chunks = papers.flatMap((p) => {
        const authors =
          p.authors.length > 0
            ? `\nAuthors: ${p.authors.slice(0, 10).join(", ")}`
            : "";
        const venue = p.venue ? `, ${p.venue}` : "";
        const tldr = p.tldr ? `\nTL;DR: ${p.tldr}` : "";
        const text = `${p.title} (${p.year}${venue})${authors}\nCitations: ${p.citationCount} | References: ${p.referenceCount}${tldr}\n${p.abstract.slice(0, 1500)}\nURL: ${p.url}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "scholar_paper", chunks);
      }

      log.info("Indexed Scholar papers", {
        agentId,
        paperCount: papers.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexObservations(
      agentId,
      observations: readonly ObservationForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const observationIds = observations.map((o) => o.id).join(",");
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        observationIds,
        observationCount: String(observations.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'observation', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = getChunkProfile("observation");
      const chunks = observations.flatMap((o) => {
        const facts =
          o.facts.length > 0 ? `\nFacts: ${o.facts.join("; ")}` : "";
        const concepts =
          o.concepts.length > 0 ? `\nTags: ${o.concepts.join(", ")}` : "";
        const text = `[${o.observationType}] ${o.title}\n${o.summary}${facts}${concepts}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "observation", chunks);
      }

      log.info("Indexed observations", {
        agentId,
        observationCount: observations.length,
        chunks: chunks.length,
      });
      return sourceId;
    },

    async indexNote(agentId, content, metadata) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const metadataJson = JSON.stringify(metadata ?? {});

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'note', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const noteProfile = getChunkProfile("note");
      const chunks = chunkText(content, noteProfile);
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "note", chunks);
      }

      log.info("Indexed note", { agentId, chunks: chunks.length });
      return sourceId;
    },

    async indexIdea(agentId, idea: IdeaForIndex, metadata) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        ideaId: idea.id,
        title: idea.title,
        category: idea.category,
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'idea', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const text = `[${idea.category}] ${idea.title}\n${idea.summary}\n${idea.reasoning.slice(0, 500)}`;
      const profile = getChunkProfile("idea");
      const chunks = chunkText(text, profile);
      const finalChunks = chunks.length > 0 ? chunks : [text];

      await insertChunks(sourceId, agentId, "idea", finalChunks);

      log.info("Indexed idea", { agentId, ideaId: idea.id });
      return sourceId;
    },

    async deleteSourceChunks(sourceId) {
      const db = getDb();
      await db`DELETE FROM memory_sources WHERE id = ${sourceId}`;

      // Also remove vectors from Qdrant
      if (config.qdrantClient?.available) {
        config.qdrantClient
          .deletePoints(config.qdrantCollection, {
            must: [{ key: "sourceId", match: { value: sourceId } }],
          })
          .catch((error) =>
            log.error("Qdrant delete failed", { sourceId, error }),
          );
      }

      log.debug("Deleted source and chunks", { sourceId });
    },
  };
}
