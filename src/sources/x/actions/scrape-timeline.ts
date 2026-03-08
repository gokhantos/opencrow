/** Scrape tweets from X home timeline and top posts via GraphQL interception. */

import type { Page } from "playwright";
import type { TimelineScrapeOutcome, TimelineTweetFromPython } from "../timeline/types";
import {
  launchXBrowser,
  validateCookies,
  createGraphQLInterceptor,
  extractEntries,
  parseTweetEntry,
  delay,
  HOME_URL,
  TOP_POSTS_URL,
  TIMELINE_OPERATIONS,
  type ParsedTweet,
} from "../shared";
import { createLogger } from "../../../logger";

const log = createLogger("x-scrape-timeline");

function tweetToDict(tweet: ParsedTweet, source: string): TimelineTweetFromPython {
  return {
    source,
    tweet_id: tweet.id,
    author_username: tweet.authorUsername,
    author_display_name: tweet.authorDisplayName,
    author_verified: tweet.authorVerified,
    author_followers: tweet.authorFollowers,
    text: tweet.text.slice(0, 500),
    likes: tweet.likes,
    retweets: tweet.retweets,
    replies: tweet.replies,
    views: tweet.views,
    bookmarks: tweet.bookmarks,
    quotes: tweet.quotes,
    has_media: tweet.hasMedia,
    tweet_created_at: tweet.createdAt,
  };
}

async function scrapePage(
  page: Page,
  url: string,
  operations: Set<string> | null,
  maxPages: number,
): Promise<Record<string, unknown>[]> {
  const { handler, responses } = createGraphQLInterceptor(operations);
  page.on("response", handler);

  try {
    log.info("Navigating", { url });
    await page.goto(url, { waitUntil: "domcontentloaded" });

    for (let i = 0; i < 40; i++) {
      await delay(500, 500);
      if (responses.length > 0) break;
    }

    if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
      log.warn("Redirected to login", { url });
      return [];
    }

    await delay(1000, 2000);

    for (let i = 0; i < maxPages; i++) {
      const scrollAmount = 500 + Math.random() * 300;
      await page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
      await delay(1500, 3000);

      if (Math.random() < 0.3) {
        await page.mouse.move(200 + Math.random() * 600, 200 + Math.random() * 400);
        await delay(300, 800);
      }
    }

    await delay(1000, 2000);
  } finally {
    page.removeListener("response", handler);
  }

  return responses;
}

export async function scrapeTimeline(
  authToken: string,
  ct0: string,
  maxPages: number = 3,
  sources: string = "home,top_posts",
  languages: string | null = null,
): Promise<TimelineScrapeOutcome> {
  const validation = validateCookies(authToken, ct0);
  if (!validation.valid) {
    return { ok: false, reason: "error", detail: `Invalid cookies: ${validation.error}` };
  }

  const sourceSet = new Set(sources.split(",").map((s) => s.trim()));
  const langSet = languages
    ? new Set(languages.split(",").map((l) => l.trim().toLowerCase()))
    : null;
  const session = await launchXBrowser(authToken, ct0);

  try {
    const allTweets: TimelineTweetFromPython[] = [];
    const seenIds = new Set<string>();
    const page = await session.context.newPage();

    try {
      if (sourceSet.has("home")) {
        log.info("Scraping home timeline", { maxPages });
        const responses = await scrapePage(page, HOME_URL, TIMELINE_OPERATIONS, maxPages);
        for (const body of responses) {
          for (const entry of extractEntries(body)) {
            const tweet = parseTweetEntry(entry);
            if (tweet && !seenIds.has(tweet.id) && (!langSet || langSet.has(tweet.language))) {
              seenIds.add(tweet.id);
              allTweets.push(tweetToDict(tweet, "home"));
            }
          }
        }
        log.info("Home timeline scraped", { count: allTweets.length });
      }

      if (sourceSet.has("top_posts")) {
        const before = allTweets.length;
        log.info("Scraping top posts", { maxPages });
        const responses = await scrapePage(page, TOP_POSTS_URL, null, maxPages);
        for (const body of responses) {
          for (const entry of extractEntries(body)) {
            const tweet = parseTweetEntry(entry);
            if (tweet && !seenIds.has(tweet.id) && (!langSet || langSet.has(tweet.language))) {
              seenIds.add(tweet.id);
              allTweets.push(tweetToDict(tweet, "top_posts"));
            }
          }
        }
        log.info("Top posts scraped", { count: allTweets.length - before });
      }
    } finally {
      await page.close();
    }

    log.info("Scrape complete", { total: allTweets.length });
    return { ok: true, tweets: allTweets };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", detail: msg };
  } finally {
    await session.cleanup();
  }
}
