/** HackerNews front page scraper — Firebase REST API. */

import { createLogger } from "../../logger";

const log = createLogger("hn-front-page");

const API_BASE = "https://hacker-news.firebaseio.com/v0";
const MAX_STORIES = 60;
const COMMENT_LIMIT = 3;
const META_TIMEOUT_MS = 5000;
const CONCURRENCY = 10;
const META_CONCURRENCY = 5;

export interface RawStory {
  readonly id: string;
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly points: number;
  readonly author: string;
  readonly time: number;
  readonly comment_count: number;
  readonly hn_url: string;
  readonly description: string;
  readonly top_comments: readonly string[];
}

interface HNItem {
  readonly id: number;
  readonly type: string;
  readonly title?: string;
  readonly url?: string;
  readonly score?: number;
  readonly by?: string;
  readonly time?: number;
  readonly descendants?: number;
  readonly kids?: readonly number[];
  readonly text?: string;
  readonly deleted?: boolean;
  readonly dead?: boolean;
}

async function fetchTopStoryIds(count: number): Promise<readonly number[]> {
  const res = await fetch(`${API_BASE}/topstories.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch top stories: ${res.status}`);
  }
  const ids = (await res.json()) as number[];
  return ids.slice(0, count);
}

async function fetchItem(id: number): Promise<HNItem | null> {
  try {
    const res = await fetch(`${API_BASE}/item/${id}.json`);
    if (!res.ok) return null;
    const item = (await res.json()) as HNItem | null;
    return item;
  } catch {
    return null;
  }
}

async function inBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  let results: readonly R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results = [...results, ...batchResults];
  }
  return results;
}

async function fetchStoriesInBatches(
  ids: readonly number[],
): Promise<readonly HNItem[]> {
  const items = await inBatches(ids, CONCURRENCY, fetchItem);
  return items.filter(
    (item): item is HNItem => item !== null && item.type === "story",
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTopComments(
  kids: readonly number[] | undefined,
  limit: number,
): Promise<readonly string[]> {
  if (!kids || kids.length === 0) return [];
  const ids = kids.slice(0, limit);
  const items = await Promise.all(ids.map(fetchItem));
  return items.reduce<readonly string[]>((acc, item) => {
    if (!item || item.deleted || item.dead || !item.text) return acc;
    const text = stripHtml(item.text);
    return text ? [...acc, text] : acc;
  }, []);
}

const MAX_META_BYTES = 50_000;

async function readFirstChunk(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (result.length < MAX_META_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return result.slice(0, MAX_META_BYTES);
}

async function fetchMetaDescription(url: string): Promise<string> {
  if (!url) return "";
  try {
    if (new URL(url).hostname.includes("news.ycombinator.com")) return "";
  } catch {
    return "";
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return "";
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) return "";
      const chunk = await readFirstChunk(res);

      const nameMatch = chunk.match(
        /<meta\s+name=["']description["']\s+content=["']([^"']*)/i,
      );
      if (nameMatch?.[1]) return nameMatch[1].trim();

      const ogMatch = chunk.match(
        /<meta\s+property=["']og:description["']\s+content=["']([^"']*)/i,
      );
      if (ogMatch?.[1]) return ogMatch[1].trim();

      const nameMatchAlt = chunk.match(
        /<meta\s+content=["']([^"']*)['"]\s+name=["']description["']/i,
      );
      if (nameMatchAlt?.[1]) return nameMatchAlt[1].trim();

      return "";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}

export async function scrapeHNFrontPage(opts?: {
  maxStories?: number;
  commentLimit?: number;
}): Promise<readonly RawStory[]> {
  const maxStories = opts?.maxStories ?? MAX_STORIES;
  const commentLimit = opts?.commentLimit ?? COMMENT_LIMIT;
  log.info("Fetching HN top story IDs", { count: maxStories });
  const ids = await fetchTopStoryIds(maxStories);

  log.info("Fetching story details", { count: ids.length });
  const storyItems = await fetchStoriesInBatches(ids);

  log.info("Fetching meta descriptions and top comments", {
    count: storyItems.length,
  });

  const [descriptions, topComments] = await Promise.all([
    inBatches(storyItems, META_CONCURRENCY, (item) =>
      fetchMetaDescription(item.url ?? ""),
    ),
    inBatches(storyItems, CONCURRENCY, (item) =>
      fetchTopComments(item.kids, commentLimit),
    ),
  ]);

  const stories: RawStory[] = storyItems.map((item, i) => ({
    id: String(item.id),
    rank: i + 1,
    title: item.title ?? "",
    url: item.url ?? "",
    points: item.score ?? 0,
    author: item.by ?? "",
    time: item.time ?? 0,
    comment_count: item.descendants ?? 0,
    hn_url: `https://news.ycombinator.com/item?id=${item.id}`,
    description: descriptions[i] ?? "",
    top_comments: topComments[i] ?? [],
  }));

  log.info("Scrape complete", { source: "hackernews", count: stories.length });
  return stories;
}
