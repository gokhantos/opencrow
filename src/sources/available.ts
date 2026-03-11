export interface ScraperMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export const AVAILABLE_SCRAPERS: readonly ScraperMeta[] = [
  {
    id: "hackernews",
    name: "Hacker News",
    description: "HN stories and comments",
  },
  {
    id: "reddit",
    name: "Reddit",
    description: "Subreddit posts and discussions",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Trending repositories and releases",
  },
  {
    id: "github-search",
    name: "GitHub Search",
    description: "Most-starred actively maintained repositories via GitHub API",
  },
  {
    id: "producthunt",
    name: "Product Hunt",
    description: "New product launches and upvotes",
  },
  {
    id: "appstore",
    name: "App Store",
    description: "iOS app store reviews and rankings",
  },
  {
    id: "playstore",
    name: "Play Store",
    description: "Android app store reviews and rankings",
  },
  {
    id: "news",
    name: "News",
    description: "General news articles from configured sources",
  },
  {
    id: "x",
    name: "X (Twitter)",
    description: "Tweets, bookmarks, timeline, and interactions",
  },
  {
    id: "ideas",
    name: "Ideas",
    description: "Idea pipeline and signal processing",
  },
] as const;

export const SCRAPER_IDS = AVAILABLE_SCRAPERS.map((s) => s.id) as string[];
