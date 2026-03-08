/** Reddit feed scraper — fetch-based JSON API, no browser needed. */

import { createLogger } from "../../logger";

const log = createLogger("reddit-feed");

const BASE_URL = "https://www.reddit.com";
const POSTS_PER_PAGE = 25;
const MAX_PAGES = 2;
const MIN_DELAY_MS = 8000;
const MAX_DELAY_MS = 14000;
const FALLBACK_SUBREDDITS = [
  "programming",
  "technology",
  "startups",
  "webdev",
  "machinelearning",
  "cryptocurrency",
  "bitcoin",
  "ethereum",
  "defi",
  "CryptoTechnology",
];

export interface RawRedditPost {
  id: string;
  subreddit: string;
  title: string;
  url: string;
  selftext: string;
  author: string;
  score: number;
  num_comments: number;
  permalink: string;
  post_type: string;
  feed_source: string;
  domain: string;
  upvote_ratio: number;
  created_utc: number;
  top_comments: readonly string[];
  flair: string | null;
  thumbnail_url: string | null;
}

interface CookieEntry {
  name: string;
  value: string;
  domain?: string;
  [key: string]: unknown;
}

function buildCookieHeader(cookiesJson: string): string {
  try {
    const cookies = JSON.parse(cookiesJson) as CookieEntry[];
    if (!Array.isArray(cookies)) return "";
    return cookies
      .filter(
        (c) =>
          c.name &&
          c.value &&
          c.domain &&
          (c.domain.includes("reddit.com") || c.domain.includes(".reddit.com")),
      )
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  } catch {
    return "";
  }
}

async function fetchSubscribedSubreddits(
  headers: Record<string, string>,
): Promise<readonly string[]> {
  const subs: string[] = [];
  let after: string | null = null;

  for (let page = 0; page < 4; page++) {
    try {
      const params = after
        ? `?limit=100&raw_json=1&after=${after}`
        : "?limit=100&raw_json=1";
      const resp = await fetch(
        `${BASE_URL}/subreddits/mine/subscriber.json${params}`,
        { headers },
      );
      if (!resp.ok) break;

      const data = (await resp.json()) as {
        data?: {
          children?: Array<{ data: Record<string, unknown> }>;
          after?: string | null;
        };
      };

      const children = data?.data?.children ?? [];
      for (const child of children) {
        const name = String(child.data?.display_name ?? "");
        if (name) subs.push(name);
      }

      after = data?.data?.after ?? null;
      if (!after) break;
      await delay(MIN_DELAY_MS, MAX_DELAY_MS);
    } catch {
      break;
    }
  }

  return subs;
}

export async function scrapeRedditFeed(
  cookiesJson: string,
): Promise<readonly RawRedditPost[]> {
  const cookieHeader = buildCookieHeader(cookiesJson);
  const seenIds = new Set<string>();
  const allPosts: RawRedditPost[] = [];

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.5",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  // Home feed (authenticated)
  if (cookieHeader) {
    const homePosts = await scrapeFeed(
      `${BASE_URL}/.json?limit=${POSTS_PER_PAGE}&raw_json=1`,
      "home",
      headers,
      seenIds,
    );
    allPosts.push(...homePosts);
    log.info("Scraped home feed", { count: homePosts.length });
  }

  // Fetch user's subscribed subreddits, fall back to defaults
  let subreddits: readonly string[];
  if (cookieHeader) {
    const subscribed = await fetchSubscribedSubreddits(headers);
    if (subscribed.length > 0) {
      subreddits = subscribed;
      log.info("Using subscribed subreddits", { count: subscribed.length });
    } else {
      subreddits = FALLBACK_SUBREDDITS;
      log.info("No subscriptions found, using fallback subreddits");
    }
  } else {
    subreddits = FALLBACK_SUBREDDITS;
  }

  // Subreddit feeds
  for (const subreddit of subreddits) {
    await delay(MIN_DELAY_MS, MAX_DELAY_MS);
    const url = `${BASE_URL}/r/${subreddit}/hot.json?limit=${POSTS_PER_PAGE}&raw_json=1`;
    const posts = await scrapeFeed(url, subreddit, headers, seenIds);
    allPosts.push(...posts);
    log.info("Scraped subreddit", { subreddit, count: posts.length });
  }

  log.info("Scrape complete (pre-comments)", {
    source: "reddit",
    count: allPosts.length,
  });

  // Fetch top comments for posts that have comments, batched with concurrency 5
  const postsWithComments = allPosts.filter((p) => p.num_comments > 0);
  log.info("Fetching top comments", { count: postsWithComments.length });

  const enriched = await inBatches(
    allPosts,
    3,
    4000,
    async (post): Promise<RawRedditPost> => {
      if (post.num_comments === 0) return post;
      const top_comments = await fetchTopComments(post.permalink, headers);
      return { ...post, top_comments };
    },
  );

  log.info("Scrape complete", { source: "reddit", count: enriched.length });
  return enriched;
}

async function scrapeFeed(
  baseUrl: string,
  feedSource: string,
  headers: Record<string, string>,
  seenIds: Set<string>,
): Promise<RawRedditPost[]> {
  const posts: RawRedditPost[] = [];
  let currentUrl = baseUrl;

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const resp = await fetch(currentUrl, { headers });
      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("retry-after") || "0");
        const backoffMs = Math.max(retryAfter * 1000, 30_000);
        log.warn("Reddit rate limited, backing off", {
          url: currentUrl,
          backoffMs,
        });
        await delay(backoffMs, backoffMs + 5000);
        break;
      }
      if (!resp.ok) {
        log.warn("Feed fetch failed", {
          url: currentUrl,
          status: resp.status,
        });
        break;
      }

      const data = (await resp.json()) as {
        data?: {
          children?: Array<{ kind: string; data: Record<string, unknown> }>;
          after?: string | null;
        };
      };

      const children = data?.data?.children;
      if (!children || children.length === 0) break;

      for (const child of children) {
        if (child.kind !== "t3") continue;
        const post = parsePost(child.data, feedSource);
        if (!post || post.stickied) continue;
        if (seenIds.has(post.id)) continue;
        seenIds.add(post.id);
        posts.push(toRawPost(post));
      }

      const after = data?.data?.after;
      if (!after) break;

      const sep = baseUrl.includes("?") ? "&" : "?";
      currentUrl = `${baseUrl}${sep}after=${after}`;

      if (page < MAX_PAGES - 1) {
        await delay(MIN_DELAY_MS, MAX_DELAY_MS);
      }
    } catch (err) {
      log.warn("Feed scrape error", {
        url: currentUrl,
        error: err,
      });
      break;
    }
  }

  return posts;
}

interface ParsedPost {
  id: string;
  subreddit: string;
  title: string;
  url: string;
  selftext: string;
  author: string;
  score: number;
  num_comments: number;
  permalink: string;
  post_type: string;
  feed_source: string;
  domain: string;
  upvote_ratio: number;
  created_utc: number;
  stickied: boolean;
  flair: string | null;
  thumbnail_url: string | null;
}

function parsePost(
  data: Record<string, unknown>,
  feedSource: string,
): ParsedPost | null {
  let postId = String(data.id ?? data.name ?? "");
  if (!postId) return null;
  if (postId.startsWith("t3_")) postId = postId.slice(3);

  const isSelf = Boolean(data.is_self);
  let permalink = String(data.permalink ?? "");
  if (permalink && !permalink.startsWith("http")) {
    permalink = `https://www.reddit.com${permalink}`;
  }

  const selftext = String(data.selftext ?? "").slice(0, 5000);

  const rawFlair = data.link_flair_text;
  const flair =
    rawFlair && typeof rawFlair === "string" && rawFlair.trim()
      ? rawFlair.trim()
      : null;

  const rawThumb = data.thumbnail;
  const thumbnail_url =
    rawThumb &&
    typeof rawThumb === "string" &&
    rawThumb.startsWith("http")
      ? rawThumb
      : null;

  return {
    id: postId,
    subreddit: String(data.subreddit ?? ""),
    title: String(data.title ?? ""),
    url: String(data.url ?? ""),
    selftext,
    author: String(data.author ?? "[deleted]"),
    score: Number(data.score ?? 0),
    num_comments: Number(data.num_comments ?? 0),
    permalink,
    post_type: isSelf ? "self" : "link",
    feed_source: feedSource,
    domain: String(data.domain ?? ""),
    upvote_ratio: Number(data.upvote_ratio ?? 0),
    created_utc: Number(data.created_utc ?? 0),
    stickied: Boolean(data.stickied),
    flair,
    thumbnail_url,
  };
}

function toRawPost(p: ParsedPost): RawRedditPost {
  const { stickied: _, ...rest } = p;
  return { ...rest, top_comments: [] };
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^>.*$/gm, "") // blockquotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/~~([^~]+)~~/g, "$1") // ~~strikethrough~~
    .replace(/`[^`]+`/g, "") // inline code
    .replace(/#{1,6}\s/g, "") // headings
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTopComments(
  permalink: string,
  headers: Record<string, string>,
  limit = 3,
): Promise<readonly string[]> {
  try {
    const url = `https://www.reddit.com${permalink.replace(/^https?:\/\/www\.reddit\.com/, "")}.json?limit=${limit}&depth=1&sort=top&raw_json=1`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) return [];

    const data = (await resp.json()) as unknown[];
    const listing = data[1] as {
      data?: { children?: Array<{ kind: string; data: Record<string, unknown> }> };
    } | undefined;

    const children = listing?.data?.children ?? [];
    const comments: string[] = [];

    for (const child of children) {
      if (child.kind !== "t1") continue;
      const body = String(child.data.body ?? "").trim();
      if (!body || body === "[deleted]" || body === "[removed]") continue;
      const cleaned = stripMarkdown(body).slice(0, 500);
      if (cleaned.length > 20) {
        comments.push(cleaned);
      }
      if (comments.length >= limit) break;
    }

    return comments;
  } catch {
    return [];
  }
}

async function inBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  delayBetweenMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await delay(delayBetweenMs, delayBetweenMs + 500);
    }
  }
  return results;
}

function delay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
