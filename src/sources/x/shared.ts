/** Shared utilities for X/Twitter scrapers — browser, cookies, GraphQL, tweet parsing. */

import { chromium, type BrowserContext, type Response } from "playwright";
import { createLogger } from "../../logger";

const log = createLogger("x-shared");

// URLs & GraphQL
export const BASE_URL = "https://x.com";
export const HOME_URL = `${BASE_URL}/home`;
export const BOOKMARKS_URL = `${BASE_URL}/i/bookmarks`;
export const GRAPHQL_API_PREFIX = `${BASE_URL}/i/api/graphql`;
export const TOP_POSTS_URL = "https://x.com/i/jf/creators/inspiration/top_posts";

export const TIMELINE_OPERATIONS = new Set([
  "HomeTimeline",
  "HomeLatestTimeline",
  "UserTweets",
  "UserTweetsAndReplies",
  "UserMedia",
  "Likes",
]);

export const BOOKMARK_OPERATIONS = new Set([
  "Bookmarks",
  "BookmarksTimeline",
  "BookmarkFolderTimeline",
]);

export const PROFILE_OPERATIONS = new Set(["UserByScreenName"]);

// Stealth script
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(params);
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
`;

// Cookie helpers
export function validateCookies(
  authToken: string,
  ct0: string,
): { valid: true } | { valid: false; error: string } {
  if (!authToken || authToken.length < 10) {
    return { valid: false, error: "auth_token is missing or too short" };
  }
  if (!ct0 || ct0.length < 10) {
    return { valid: false, error: "ct0 is missing or too short" };
  }
  return { valid: true };
}

export function toPlaywrightCookies(authToken: string, ct0: string) {
  return [
    {
      name: "auth_token",
      value: authToken,
      domain: ".x.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None" as const,
    },
    {
      name: "ct0",
      value: ct0,
      domain: ".x.com",
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax" as const,
    },
  ];
}

// Browser session
export interface XBrowserSession {
  readonly context: BrowserContext;
  readonly cleanup: () => Promise<void>;
}

export async function launchXBrowser(
  authToken: string,
  ct0: string,
): Promise<XBrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "dark",
  });
  await context.addInitScript(STEALTH_SCRIPT);
  await context.addCookies(toPlaywrightCookies(authToken, ct0));

  return {
    context,
    cleanup: async () => {
      await context.close();
      await browser.close();
    },
  };
}

// GraphQL response interception
export function extractOperation(url: string): string | null {
  if (!url.includes(GRAPHQL_API_PREFIX)) return null;
  const path = url.split(GRAPHQL_API_PREFIX)[1];
  const parts = path?.replace(/^\//, "").split("/");
  if (!parts || parts.length < 2) return null;
  return parts[1]!.split("?")[0]!;
}

export function createGraphQLInterceptor(
  operations: Set<string> | null,
): {
  handler: (response: Response) => void;
  responses: Record<string, unknown>[];
} {
  const responses: Record<string, unknown>[] = [];

  const handler = (response: Response) => {
    if (response.status() !== 200) return;
    const op = extractOperation(response.url());
    if (!op) return;

    if (operations === null || operations.has(op)) {
      response
        .json()
        .then((body) => responses.push(body as Record<string, unknown>))
        .catch((err) => log.debug("Failed to parse X API response JSON", err));
    }
  };

  return { handler, responses };
}

// GraphQL entry extraction
export function extractEntries(
  responseBody: Record<string, unknown>,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const data = (responseBody.data ?? {}) as Record<string, unknown>;

  for (const instrList of walkForInstructions(data)) {
    for (const instruction of instrList) {
      const type = (instruction as Record<string, unknown>).type;
      if (type === "TimelineAddEntries" || type === "TimelineAddToModule") {
        const e = (instruction as Record<string, unknown>).entries;
        if (Array.isArray(e)) entries.push(...e);
      }
    }
  }
  return entries;
}

function walkForInstructions(
  obj: unknown,
  depth = 0,
): Record<string, unknown>[][] {
  const results: Record<string, unknown>[][] = [];
  if (depth > 10 || typeof obj !== "object" || obj === null) return results;
  const dict = obj as Record<string, unknown>;

  if (Array.isArray(dict.instructions)) {
    results.push(dict.instructions as Record<string, unknown>[]);
  }

  for (const value of Object.values(dict)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      results.push(...walkForInstructions(value, depth + 1));
    }
  }
  return results;
}

// Tweet parsing from GraphQL entries
export interface ParsedTweet {
  id: string;
  text: string;
  authorUsername: string;
  authorDisplayName: string;
  authorVerified: boolean;
  authorFollowers: number;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  bookmarks: number;
  quotes: number;
  hasMedia: boolean;
  createdAt: number | null;
  language: string;
  mediaUrls: string[];
}

export function parseTweetEntry(
  entry: Record<string, unknown>,
): ParsedTweet | null {
  try {
    const content = (entry.content ?? {}) as Record<string, unknown>;
    const itemContent = (content.itemContent ?? {}) as Record<string, unknown>;
    if (itemContent.itemType !== "TimelineTweet") return null;

    const tweetResults = (itemContent.tweet_results ?? {}) as Record<
      string,
      unknown
    >;
    let result = (tweetResults.result ?? {}) as Record<string, unknown>;
    return parseTweetResult(result);
  } catch {
    return null;
  }
}

function parseTweetResult(
  result: Record<string, unknown>,
): ParsedTweet | null {
  if (result.__typename === "TweetWithVisibilityResults") {
    result = (result.tweet ?? {}) as Record<string, unknown>;
  }
  if (result.__typename === "TweetTombstone") return null;

  const core = (result.core ?? {}) as Record<string, unknown>;
  const userResults = (core.user_results ?? {}) as Record<string, unknown>;
  const userResult = (userResults.result ?? {}) as Record<string, unknown>;
  const legacyUser = (userResult.legacy ?? {}) as Record<string, unknown>;
  const userCore = (userResult.core ?? {}) as Record<string, unknown>;
  const legacy = (result.legacy ?? {}) as Record<string, unknown>;

  if (!legacy || Object.keys(legacy).length === 0) return null;

  const entities = (legacy.entities ?? {}) as Record<string, unknown>;
  const mediaArr = (entities.media ?? []) as Array<Record<string, unknown>>;
  const mediaUrls = mediaArr
    .map((m) => String(m.media_url_https ?? ""))
    .filter(Boolean);

  let createdAt: number | null = null;
  const rawDate = legacy.created_at;
  if (typeof rawDate === "string") {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) createdAt = Math.floor(d.getTime() / 1000);
  }

  const viewsObj = (result.views ?? {}) as Record<string, unknown>;
  const viewCount = parseInt(String(viewsObj.count ?? "0"), 10) || 0;

  return {
    id: String(legacy.id_str ?? result.rest_id ?? ""),
    text: String(legacy.full_text ?? ""),
    authorUsername:
      String(userCore.screen_name ?? "") ||
      String(legacyUser.screen_name ?? ""),
    authorDisplayName:
      String(userCore.name ?? "") || String(legacyUser.name ?? ""),
    authorVerified: Boolean(userResult.is_blue_verified),
    authorFollowers: Number(legacyUser.followers_count ?? 0),
    likes: Number(legacy.favorite_count ?? 0),
    retweets: Number(legacy.retweet_count ?? 0),
    replies: Number(legacy.reply_count ?? 0),
    views: viewCount,
    bookmarks: Number(legacy.bookmark_count ?? 0),
    quotes: Number(legacy.quote_count ?? 0),
    hasMedia: mediaUrls.length > 0,
    createdAt,
    language: String(legacy.lang ?? ""),
    mediaUrls,
  };
}

// Delay helper
export function delay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
