import { chunkText } from "../chunker";
import { getChunkProfileWithOverrides } from "../chunk-profiles";
import { NEWS_SOURCE_KIND_MAP } from "../types";
import type {
  AppRankingForIndex,
  AppReviewForIndex,
  ArticleForIndex,
  GithubRepoForIndex,
  IdeaForIndex,
  MemorySourceKind,
  ObservationForIndex,
  ProductForIndex,
  RedditPostForIndex,
  StoryForIndex,
  TweetForIndex,
} from "../types";

/**
 * Per-kind chunk-text builders shared by the memory backends.
 *
 * These mirror the EXACT text formatting + chunk profiles used by the Qdrant
 * indexer (`src/memory/indexer.ts`) so the mem0 backend stores byte-identical
 * chunk text. Each builder returns one `{ kind, chunks }` group; methods that
 * split by sub-source (news by sourceName, app data by store) return several
 * groups. Keeping these in one place avoids the two backends drifting apart.
 *
 * IMPORTANT: when the Qdrant indexer's formatting changes, update it here too.
 */

export interface ChunkGroup {
  readonly kind: MemorySourceKind;
  readonly chunks: readonly string[];
}

/** Reusable "chunk this item, falling back to the raw text" helper. */
function chunkItem(
  text: string,
  profile: { readonly maxTokens: number; readonly overlap: number },
): readonly string[] {
  const itemChunks = chunkText(text, profile);
  return itemChunks.length > 0 ? itemChunks : [text];
}

export async function buildNoteChunks(content: string): Promise<ChunkGroup[]> {
  const profile = await getChunkProfileWithOverrides("note");
  return [{ kind: "note", chunks: chunkText(content, profile) }];
}

export async function buildTweetChunks(
  tweets: readonly TweetForIndex[],
): Promise<ChunkGroup[]> {
  const profile = await getChunkProfileWithOverrides("x_post");
  const chunks = tweets.flatMap((t) =>
    chunkItem(`@${t.authorHandle} (${t.tweetTimestamp}): ${t.text}`, profile),
  );
  return [{ kind: "x_post", chunks }];
}

export async function buildArticleChunks(
  articles: readonly ArticleForIndex[],
): Promise<ChunkGroup[]> {
  const bySource = new Map<string, ArticleForIndex[]>();
  for (const a of articles) {
    const group = bySource.get(a.sourceName) ?? [];
    group.push(a);
    bySource.set(a.sourceName, group);
  }

  const groups: ChunkGroup[] = [];
  for (const [sourceName, group] of bySource) {
    const kind: MemorySourceKind =
      NEWS_SOURCE_KIND_MAP[sourceName] ?? "reuters_news";
    const profile = await getChunkProfileWithOverrides(kind);
    const contentMaxChars = profile.contentMaxChars ?? 400;
    const chunks = group.flatMap((a) => {
      const date = new Date(a.publishedAt * 1000).toISOString().slice(0, 16);
      const snippet = a.content ? ` — ${a.content.slice(0, contentMaxChars)}` : "";
      const text = `[${a.category}] ${a.title} (${a.sourceName}, ${date})${snippet}\n${a.url}`;
      return chunkItem(text, profile);
    });
    groups.push({ kind, chunks });
  }
  return groups;
}

export async function buildProductChunks(
  products: readonly ProductForIndex[],
): Promise<ChunkGroup[]> {
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
    return chunkItem(text, profile);
  });
  return [{ kind: "producthunt_product", chunks }];
}

export async function buildStoryChunks(
  stories: readonly StoryForIndex[],
): Promise<ChunkGroup[]> {
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
    return chunkItem(text, profile);
  });
  return [{ kind: "hackernews_story", chunks }];
}

export async function buildRedditChunks(
  posts: readonly RedditPostForIndex[],
): Promise<ChunkGroup[]> {
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
    return chunkItem(text, profile);
  });
  return [{ kind: "reddit_post", chunks }];
}

export async function buildGithubChunks(
  repos: readonly GithubRepoForIndex[],
): Promise<ChunkGroup[]> {
  const profile = await getChunkProfileWithOverrides("github_repo");
  const repoContentMaxChars = profile.contentMaxChars ?? 1500;
  const chunks = repos.flatMap((r) => {
    const lang = r.language ? ` (${r.language})` : "";
    const contributors =
      r.builtBy.length > 0
        ? `\nBuilt by: ${r.builtBy.slice(0, 5).join(", ")}`
        : "";
    const desc = r.description ? `\n${r.description.slice(0, repoContentMaxChars)}` : "";
    const periodLabel = r.period === "weekly" ? "this week" : "today";
    const text = `GitHub: ${r.id}${lang}\nStars: ${r.stars} (+${r.starsToday} ${periodLabel}) | Forks: ${r.forks}${contributors}${desc}\n${r.url}`;
    return chunkItem(text, profile);
  });
  return [{ kind: "github_repo", chunks }];
}

export async function buildObservationChunks(
  observations: readonly ObservationForIndex[],
): Promise<ChunkGroup[]> {
  const profile = await getChunkProfileWithOverrides("observation");
  const chunks = observations.flatMap((o) => {
    const facts = o.facts.length > 0 ? `\nFacts: ${o.facts.join("; ")}` : "";
    const concepts =
      o.concepts.length > 0 ? `\nTags: ${o.concepts.join(", ")}` : "";
    const text = `[${o.observationType}] ${o.title}\n${o.summary}${facts}${concepts}`;
    return chunkItem(text, profile);
  });
  return [{ kind: "observation", chunks }];
}

export async function buildIdeaChunks(
  idea: IdeaForIndex,
): Promise<ChunkGroup[]> {
  const profile = await getChunkProfileWithOverrides("idea");
  const ideaContentMaxChars = profile.contentMaxChars ?? 1500;
  const text = `[${idea.category}] ${idea.title}\n${idea.summary}\n${idea.reasoning.slice(0, ideaContentMaxChars)}`;
  return [{ kind: "idea", chunks: chunkItem(text, profile) }];
}

export async function buildAppReviewChunks(
  reviews: readonly AppReviewForIndex[],
): Promise<ChunkGroup[]> {
  const byStore = new Map<"appstore" | "playstore", AppReviewForIndex[]>();
  for (const r of reviews) {
    const group = byStore.get(r.store) ?? [];
    group.push(r);
    byStore.set(r.store, group);
  }

  const groups: ChunkGroup[] = [];
  for (const [store, group] of byStore) {
    const kind: MemorySourceKind = `${store}_review`;
    const profile = await getChunkProfileWithOverrides(kind);
    const chunks = group.flatMap((r) => {
      const text = `[${r.store}] ${r.appName} Review (${r.rating}/5): ${r.title}\n${r.content}`;
      return chunkItem(text, profile);
    });
    groups.push({ kind, chunks });
  }
  return groups;
}

export async function buildAppRankingChunks(
  rankings: readonly AppRankingForIndex[],
): Promise<ChunkGroup[]> {
  const byStore = new Map<"appstore" | "playstore", AppRankingForIndex[]>();
  for (const r of rankings) {
    const group = byStore.get(r.store) ?? [];
    group.push(r);
    byStore.set(r.store, group);
  }

  const groups: ChunkGroup[] = [];
  for (const [store, group] of byStore) {
    const kind: MemorySourceKind = `${store}_app`;
    const profile = await getChunkProfileWithOverrides(kind);
    const chunks = group.flatMap((r) => {
      const installs = r.installs ? ` | Installs: ${r.installs}` : "";
      const text = `[${r.store}] ${r.name} by ${r.artist} | Category: ${r.category} | Price: ${r.price}${installs}\n${r.description}\n${r.storeUrl}`;
      return chunkItem(text, profile);
    });
    groups.push({ kind, chunks });
  }
  return groups;
}
