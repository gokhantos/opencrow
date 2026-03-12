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
    id: "cryptopanic",
    name: "CryptoPanic",
    description: "Crypto news aggregator",
  },
  {
    id: "cointelegraph",
    name: "CoinTelegraph",
    description: "Cryptocurrency and blockchain news",
  },
  {
    id: "reuters",
    name: "Reuters",
    description: "Global financial and business news",
  },
  {
    id: "investing_news",
    name: "Investing News",
    description: "Investment and market news articles",
  },
  {
    id: "investing_calendar",
    name: "Investing Calendar",
    description: "Economic calendar events and schedules",
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
