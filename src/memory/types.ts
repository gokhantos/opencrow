export interface MemoryChunk {
  readonly id: string;
  readonly sourceId: string;
  readonly content: string;
  readonly chunkIndex: number;
  readonly tokenCount: number;
  readonly createdAt: number;
}

export interface MemorySource {
  readonly id: string;
  readonly kind: MemorySourceKind;
  readonly agentId: string;
  readonly channel: string | null;
  readonly chatId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

export type MemorySourceKind =
  | "conversation"
  | "note"
  | "document"
  | "x_post"
  | "reuters_news"
  | "cointelegraph_news"
  | "cryptopanic_news"
  | "investingnews_news"
  | "producthunt_product"
  | "hackernews_story"
  | "reddit_post"
  | "github_repo"
  | "observation"
  | "idea"
  | "appstore_review"
  | "appstore_app"
  | "playstore_review"
  | "playstore_app"
;

export const MEMORY_SOURCE_KINDS = [
  "conversation",
  "note",
  "document",
  "x_post",
  "reuters_news",
  "cointelegraph_news",
  "cryptopanic_news",
  "investingnews_news",
  "producthunt_product",
  "hackernews_story",
  "reddit_post",
  "github_repo",
  "observation",
  "idea",
  "appstore_review",
  "appstore_app",
  "playstore_review",
  "playstore_app",
] as const satisfies readonly MemorySourceKind[];

/** Map news source_name from scrapers to the corresponding memory kind. */
export const NEWS_SOURCE_KIND_MAP: Readonly<Record<string, MemorySourceKind>> = {
  reuters: "reuters_news",
  cointelegraph: "cointelegraph_news",
  cryptopanic: "cryptopanic_news",
  investing_news: "investingnews_news",
};

/** All news-related memory kinds. */
export const NEWS_KINDS: readonly MemorySourceKind[] = [
  "reuters_news",
  "cointelegraph_news",
  "cryptopanic_news",
  "investingnews_news",
];

export interface SearchResult {
  readonly chunk: MemoryChunk;
  readonly score: number;
  readonly source: MemorySource;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly minScore?: number;
  readonly kinds?: readonly MemorySourceKind[];
  readonly channel?: string;
}

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface TweetForIndex {
  readonly id: string;
  readonly text: string;
  readonly authorHandle: string;
  readonly tweetTimestamp: string;
}

export interface ArticleForIndex {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly sourceName: string;
  readonly category: string;
  readonly content: string | null;
  readonly publishedAt: number;
}

export interface ProductForIndex {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly url: string;
  readonly websiteUrl: string;
  readonly topics: readonly string[];
  readonly votesCount: number;
  readonly commentsCount: number;
  readonly rank: number | null;
  readonly featuredAt: number | null;
  readonly reviewsCount: number;
  readonly reviewsRating: number;
  readonly makers: readonly string[];
}

export interface StoryForIndex {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly siteLabel: string;
  readonly points: number;
  readonly author: string;
  readonly commentCount: number;
  readonly hnUrl: string;
  readonly rank: number;
  readonly description?: string;
  readonly topComments?: readonly string[];
}

export interface RedditPostForIndex {
  readonly id: string;
  readonly title: string;
  readonly subreddit: string;
  readonly url: string;
  readonly selftext: string;
  readonly author: string;
  readonly score: number;
  readonly numComments: number;
  readonly permalink: string;
  readonly topComments?: readonly string[];
  readonly flair?: string;
}

export interface GithubRepoForIndex {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly stars: number;
  readonly forks: number;
  readonly starsToday: number;
  readonly builtBy: readonly string[];
  readonly url: string;
  readonly period: string;
}

export interface ObservationForIndex {
  readonly id: string;
  readonly observationType: string;
  readonly title: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly concepts: readonly string[];
}

export interface IdeaForIndex {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly reasoning: string;
}

export interface AppReviewForIndex {
  readonly id: string;
  readonly appName: string;
  readonly title: string;
  readonly content: string;
  readonly rating: number;
  readonly store: "appstore" | "playstore";
  readonly firstSeenAt: number;
}

export interface AppRankingForIndex {
  readonly id: string;
  readonly name: string;
  readonly artist: string;
  readonly category: string;
  readonly price: string;
  readonly storeUrl: string;
  readonly description: string;
  readonly store: "appstore" | "playstore";
  readonly installs?: string;
  readonly updatedAt: number;
}



export interface MemoryIndexer {
  indexNote(
    agentId: string,
    content: string,
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexTweets(
    agentId: string,
    tweets: readonly TweetForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexArticles(
    agentId: string,
    articles: readonly ArticleForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexProducts(
    agentId: string,
    products: readonly ProductForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexStories(
    agentId: string,
    stories: readonly StoryForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexRedditPosts(
    agentId: string,
    posts: readonly RedditPostForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexGithubRepos(
    agentId: string,
    repos: readonly GithubRepoForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexObservations(
    agentId: string,
    observations: readonly ObservationForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexIdea(
    agentId: string,
    idea: IdeaForIndex,
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexAppReviews(
    agentId: string,
    reviews: readonly AppReviewForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexAppRankings(
    agentId: string,
    rankings: readonly AppRankingForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  deleteSourceChunks(sourceId: string): Promise<void>;
}

export interface MemorySearch {
  search(
    agentId: string,
    query: string,
    opts?: SearchOptions,
  ): Promise<readonly SearchResult[]>;
}

export interface MemoryManager {
  indexTweets(
    agentId: string,
    tweets: readonly TweetForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexArticles(
    agentId: string,
    articles: readonly ArticleForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexProducts(
    agentId: string,
    products: readonly ProductForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexStories(
    agentId: string,
    stories: readonly StoryForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexRedditPosts(
    agentId: string,
    posts: readonly RedditPostForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexGithubRepos(
    agentId: string,
    repos: readonly GithubRepoForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexObservations(
    agentId: string,
    observations: readonly ObservationForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexIdea(
    agentId: string,
    idea: IdeaForIndex,
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexAppReviews(
    agentId: string,
    reviews: readonly AppReviewForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  indexAppRankings(
    agentId: string,
    rankings: readonly AppRankingForIndex[],
    metadata?: Record<string, string>,
  ): Promise<string>;
  search(
    agentId: string,
    query: string,
    opts?: SearchOptions,
  ): Promise<readonly SearchResult[]>;
  getStats(agentId?: string): Promise<MemoryStats>;
}

export interface MemoryStats {
  readonly sourceCount: number;
  readonly chunkCount: number;
  readonly totalTokens: number;
}
