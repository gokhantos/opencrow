import { getDb } from "../store/db";
import { chunkText } from "./chunker";
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
  MemoryIndexer,
  MemorySourceKind,
  TweetForIndex,
} from "./types";
import { NEWS_SOURCE_KIND_MAP } from "./types";
import type { QdrantClient, QdrantPoint } from "./qdrant";
import { updateChunkFts } from "./fts";
import { getChunkProfileWithOverrides } from "./chunk-profiles";

const log = createLogger("memory-indexer");

interface IndexerConfig {
  readonly embeddingProvider: EmbeddingProvider | null;
  readonly qdrantClient: QdrantClient | null;
  readonly qdrantCollection: string;
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createMemoryIndexer(config: IndexerConfig): MemoryIndexer {
  async function insertChunks(
    sourceId: string,
    agentId: string,
    kind: MemorySourceKind,
    texts: readonly string[],
  ): Promise<void> {
    const db = getDb();

    // Compute content hashes for dedup
    const hashes = await Promise.all(texts.map(hashText));

    // Check which hashes already exist
    const existingRows = await db`
      SELECT content_hash FROM memory_chunks
      WHERE content_hash IN ${db(hashes)}
    `;
    const existingHashes = new Set(
      existingRows.map((r: { content_hash: string }) => r.content_hash),
    );

    // Filter to only new (non-duplicate) chunks
    const newIndices: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (!existingHashes.has(hashes[i]!)) {
        newIndices.push(i);
      }
    }

    if (newIndices.length === 0) {
      log.debug("All chunks deduplicated, skipping", {
        sourceId,
        total: texts.length,
      });
      return;
    }

    if (newIndices.length < texts.length) {
      log.debug("Deduplicated chunks", {
        sourceId,
        total: texts.length,
        new: newIndices.length,
        skipped: texts.length - newIndices.length,
      });
    }

    // Filter out tiny chunks that are semantically meaningless
    const MIN_CHUNK_TOKENS = 10;
    const filteredIndices = newIndices.filter(
      (i) => countTokens(texts[i]!) >= MIN_CHUNK_TOKENS,
    );

    if (filteredIndices.length < newIndices.length) {
      log.debug("Filtered tiny chunks", {
        sourceId,
        removed: newIndices.length - filteredIndices.length,
        kept: filteredIndices.length,
      });
    }

    if (filteredIndices.length === 0) {
      log.debug("All chunks too small, skipping", { sourceId });
      return;
    }

    const newTexts = filteredIndices.map((i) => texts[i]!);
    const newHashes = filteredIndices.map((i) => hashes[i]!);

    let embeddings: Float32Array[] | null = null;
    if (config.embeddingProvider) {
      try {
        embeddings = await config.embeddingProvider.embed(newTexts);
      } catch (error) {
        log.error("Embedding failed, storing without vectors", { error });
      }
    }

    // Track which chunks were actually inserted (not skipped by ON CONFLICT)
    interface ChunkResult {
      readonly id: string;
      readonly textIndex: number;
    }
    const insertedChunks: ChunkResult[] = [];
    const now = Math.floor(Date.now() / 1000);

    await db.begin(async (tx) => {
      for (let i = 0; i < newTexts.length; i++) {
        const id = crypto.randomUUID();
        const text = newTexts[i]!;
        const tokenCount = countTokens(text);
        const contentHash = newHashes[i]!;

        // ON CONFLICT DO NOTHING + RETURNING: only get id back if row was inserted
        const rows = await tx`
          INSERT INTO memory_chunks (id, source_id, content, chunk_index, token_count, created_at, content_hash)
          VALUES (${id}, ${sourceId}, ${text}, ${filteredIndices[i]!}, ${tokenCount}, ${now}, ${contentHash})
          ON CONFLICT (content_hash) DO NOTHING
          RETURNING id
        `;

        if (rows.length > 0) {
          insertedChunks.push({ id, textIndex: i });
        }
      }
    });

    if (insertedChunks.length === 0) {
      log.debug("All chunks deduplicated at insert time", { sourceId });
      return;
    }

    // Upsert vectors to Qdrant — only for actually inserted chunks,
    // with semantic dedup to skip near-duplicates (same story, different source).
    if (embeddings && config.qdrantClient?.available) {
      try {
        const SEMANTIC_DEDUP_THRESHOLD = 0.95;
        const candidates: Array<{
          id: string;
          vector: number[];
          payload: Record<string, string | number>;
        }> = [];

        for (const { id: chunkId, textIndex } of insertedChunks) {
          const vec = embeddings[textIndex];
          if (vec) {
            candidates.push({
              id: chunkId,
              vector: Array.from(vec),
              payload: {
                sourceId,
                agentId,
                chunkIndex: filteredIndices[textIndex]!,
                kind,
                createdAt: now,
              },
            });
          }
        }

        // Check all candidates against existing vectors for near-duplicates (parallel)
        const dedupResults = await Promise.all(
          candidates.map(async (candidate) => {
            try {
              const similar = await config.qdrantClient!.searchPoints(
                config.qdrantCollection,
                candidate.vector,
                1,
                { scoreThreshold: SEMANTIC_DEDUP_THRESHOLD },
              );
              return { candidate, isDuplicate: similar.length > 0 };
            } catch {
              return { candidate, isDuplicate: false };
            }
          }),
        );
        const points = dedupResults
          .filter((r) => !r.isDuplicate)
          .map((r) => r.candidate);
        const dedupSkipped = dedupResults.filter((r) => r.isDuplicate).length;

        if (dedupSkipped > 0) {
          log.info("Semantic dedup skipped near-duplicate vectors", {
            sourceId,
            skipped: dedupSkipped,
            kept: points.length,
          });
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
    await Promise.all(
      insertedChunks.map(({ id, textIndex }) =>
        updateChunkFts(id, newTexts[textIndex]!),
      ),
    );

    log.debug("Indexed chunks", {
      sourceId,
      count: insertedChunks.length,
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
        VALUES (${sourceId}, 'x_post', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = await getChunkProfileWithOverrides("x_post");
      const chunks = tweets.flatMap((t) => {
        const text = `@${t.authorHandle} (${t.tweetTimestamp}): ${t.text}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "x_post", chunks);
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
      const now = Math.floor(Date.now() / 1000);

      // Group articles by source so each gets the correct kind
      const bySource = new Map<string, ArticleForIndex[]>();
      for (const a of articles) {
        const group = bySource.get(a.sourceName) ?? [];
        group.push(a);
        bySource.set(a.sourceName, group);
      }

      let firstSourceId = "";

      for (const [sourceName, group] of bySource) {
        const kind: MemorySourceKind =
          NEWS_SOURCE_KIND_MAP[sourceName] ?? "reuters_news";
        const sourceId = crypto.randomUUID();
        if (!firstSourceId) firstSourceId = sourceId;

        const articleIds = group.map((a) => a.id).join(",");
        const metadataJson = JSON.stringify({
          ...(metadata ?? {}),
          articleIds,
          articleCount: String(group.length),
          sourceName,
        });

        await db`
          INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
          VALUES (${sourceId}, ${kind}, ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
        `;

        const profile = await getChunkProfileWithOverrides(kind);
        const contentMaxChars = profile.contentMaxChars ?? 400;
        const chunks = group.flatMap((a) => {
          const date = new Date(a.publishedAt * 1000).toISOString().slice(0, 16);
          const snippet = a.content ? ` — ${a.content.slice(0, contentMaxChars)}` : "";
          const text = `[${a.category}] ${a.title} (${a.sourceName}, ${date})${snippet}\n${a.url}`;
          const itemChunks = chunkText(text, profile);
          return itemChunks.length > 0 ? itemChunks : [text];
        });
        if (chunks.length > 0) {
          await insertChunks(sourceId, agentId, kind, chunks);
        }

        log.info("Indexed news", {
          agentId,
          sourceName,
          kind,
          articleCount: group.length,
          chunks: chunks.length,
        });
      }

      return firstSourceId;
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
        VALUES (${sourceId}, 'producthunt_product', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = await getChunkProfileWithOverrides("producthunt_product");
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
        await insertChunks(sourceId, agentId, "producthunt_product", chunks);
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
        VALUES (${sourceId}, 'hackernews_story', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = await getChunkProfileWithOverrides("hackernews_story");
      const commentMaxChars = profile.commentMaxChars ?? 800;
      const chunks = stories.flatMap((s) => {
        const site = s.siteLabel ? ` (${s.siteLabel})` : "";
        const descLine = s.description ? `\nDescription: ${s.description}` : "";
        const commentsLine =
          s.topComments && s.topComments.length > 0
            ? `\nTop comments:\n${s.topComments.map((c, i) => `  ${i + 1}. ${c.slice(0, commentMaxChars)}`).join("\n")}`
            : "";
        const text = `#${s.rank} ${s.title}${site} — ${s.points} pts, ${s.commentCount} comments, by ${s.author}\n${s.url}\nHN: ${s.hnUrl}${descLine}${commentsLine}`;
        const itemChunks = chunkText(text, profile);
        return itemChunks.length > 0 ? itemChunks : [text];
      });
      if (chunks.length > 0) {
        await insertChunks(sourceId, agentId, "hackernews_story", chunks);
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

      const profile = await getChunkProfileWithOverrides("reddit_post");
      const contentMaxChars = profile.contentMaxChars ?? 5000;
      const commentMaxChars = profile.commentMaxChars ?? 800;
      const chunks = posts.flatMap((p) => {
        const flairLabel = p.flair ? ` [${p.flair}]` : "";
        const selftext = p.selftext ? `\n${p.selftext.slice(0, contentMaxChars)}` : "";
        const commentsLine =
          p.topComments && p.topComments.length > 0
            ? `\nTop comments:\n${p.topComments.map((c) => `- ${c.slice(0, commentMaxChars)}`).join("\n")}`
            : "";
        const text = `Reddit r/${p.subreddit}${flairLabel}: ${p.title}${selftext}${commentsLine}\nScore: ${p.score} | Comments: ${p.numComments} | By: u/${p.author}\nURL: ${p.url}`;
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

      const repoProfile = await getChunkProfileWithOverrides("github_repo");
      const repoContentMaxChars = repoProfile.contentMaxChars ?? 1500;
      const chunks = repos.flatMap((r) => {
        const lang = r.language ? ` (${r.language})` : "";
        const contributors =
          r.builtBy.length > 0
            ? `\nBuilt by: ${r.builtBy.slice(0, 5).join(", ")}`
            : "";
        const desc = r.description ? `\n${r.description.slice(0, repoContentMaxChars)}` : "";
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

    async indexObservations(
      agentId,
      observations: readonly ObservationForIndex[],
      metadata,
    ) {
      const db = getDb();
      const sourceId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const observationIds = observations.map((o) => o.id);
      const metadataJson = JSON.stringify({
        ...(metadata ?? {}),
        observationIds,
        observationCount: String(observations.length),
      });

      await db`
        INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
        VALUES (${sourceId}, 'observation', ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
      `;

      const profile = await getChunkProfileWithOverrides("observation");
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

      const noteProfile = await getChunkProfileWithOverrides("note");
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

      const profile = await getChunkProfileWithOverrides("idea");
      const ideaContentMaxChars = profile.contentMaxChars ?? 1500;
      const text = `[${idea.category}] ${idea.title}\n${idea.summary}\n${idea.reasoning.slice(0, ideaContentMaxChars)}`;
      const chunks = chunkText(text, profile);
      const finalChunks = chunks.length > 0 ? chunks : [text];

      await insertChunks(sourceId, agentId, "idea", finalChunks);

      log.info("Indexed idea", { agentId, ideaId: idea.id });
      return sourceId;
    },

    async indexAppReviews(
      agentId,
      reviews: readonly AppReviewForIndex[],
      metadata,
    ) {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

      // Group by store for separate kinds
      const byStore = new Map<"appstore" | "playstore", AppReviewForIndex[]>();
      for (const r of reviews) {
        const group = byStore.get(r.store) ?? [];
        group.push(r);
        byStore.set(r.store, group);
      }

      let firstSourceId = "";

      for (const [store, group] of byStore) {
        const kind: MemorySourceKind = `${store}_review`;
        const sourceId = crypto.randomUUID();
        if (!firstSourceId) firstSourceId = sourceId;

        const reviewIds = group.map((r) => r.id).join(",");
        const metadataJson = JSON.stringify({
          ...(metadata ?? {}),
          reviewIds,
          reviewCount: String(group.length),
          store,
        });

        await db`
          INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
          VALUES (${sourceId}, ${kind}, ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
        `;

        const profile = await getChunkProfileWithOverrides(kind);
        const chunks = group.flatMap((r) => {
          const text = `[${r.store}] ${r.appName} Review (${r.rating}/5): ${r.title}\n${r.content}`;
          const itemChunks = chunkText(text, profile);
          return itemChunks.length > 0 ? itemChunks : [text];
        });
        if (chunks.length > 0) {
          await insertChunks(sourceId, agentId, kind, chunks);
        }

        log.info("Indexed app reviews", {
          agentId,
          store,
          kind,
          reviewCount: group.length,
          chunks: chunks.length,
        });
      }

      return firstSourceId;
    },

    async indexAppRankings(
      agentId,
      rankings: readonly AppRankingForIndex[],
      metadata,
    ) {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

      // Group by store for separate kinds
      const byStore = new Map<"appstore" | "playstore", AppRankingForIndex[]>();
      for (const r of rankings) {
        const group = byStore.get(r.store) ?? [];
        group.push(r);
        byStore.set(r.store, group);
      }

      let firstSourceId = "";

      for (const [store, group] of byStore) {
        const kind: MemorySourceKind = `${store}_app`;
        const sourceId = crypto.randomUUID();
        if (!firstSourceId) firstSourceId = sourceId;

        const rankingIds = group.map((r) => r.id).join(",");
        const metadataJson = JSON.stringify({
          ...(metadata ?? {}),
          rankingIds,
          rankingCount: String(group.length),
          store,
        });

        await db`
          INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
          VALUES (${sourceId}, ${kind}, ${agentId}, ${null}, ${null}, ${metadataJson}, ${now})
        `;

        const profile = await getChunkProfileWithOverrides(kind);
        const chunks = group.flatMap((r) => {
          const installs = r.installs ? ` | Installs: ${r.installs}` : "";
          const text = `[${r.store}] ${r.name} by ${r.artist} | Category: ${r.category} | Price: ${r.price}${installs}\n${r.description}\n${r.storeUrl}`;
          const itemChunks = chunkText(text, profile);
          return itemChunks.length > 0 ? itemChunks : [text];
        });
        if (chunks.length > 0) {
          await insertChunks(sourceId, agentId, kind, chunks);
        }

        log.info("Indexed app rankings", {
          agentId,
          store,
          kind,
          rankingCount: group.length,
          chunks: chunks.length,
        });
      }

      return firstSourceId;
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
