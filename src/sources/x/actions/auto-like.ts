/** Auto-like tweets from home timeline via GraphQL interception + DOM clicks. */

import type { Page } from "playwright";
import type {
  AutolikeOutcome,
  ScrapedTweetFromPython,
  LikedTweetFromPython,
} from "../interactions/types";
import {
  launchXBrowser,
  validateCookies,
  createGraphQLInterceptor,
  extractEntries,
  parseTweetEntry,
  delay,
  HOME_URL,
  TIMELINE_OPERATIONS,
  type ParsedTweet,
} from "../shared";
import { createLogger } from "../../../logger";

const log = createLogger("x-auto-like");

function tweetToScraped(t: ParsedTweet): ScrapedTweetFromPython {
  return {
    tweet_id: t.id,
    author_username: t.authorUsername,
    author_display_name: t.authorDisplayName,
    author_verified: t.authorVerified,
    author_followers: t.authorFollowers,
    text: t.text.slice(0, 500),
    likes: t.likes,
    retweets: t.retweets,
    replies: t.replies,
    views: t.views,
    bookmarks: t.bookmarks,
    quotes: t.quotes,
    has_media: t.hasMedia,
    tweet_created_at: t.createdAt,
  };
}

async function likeTweetOnPage(page: Page, tweet: ParsedTweet): Promise<boolean> {
  const tweetUrl = `https://x.com/${tweet.authorUsername}/status/${tweet.id}`;
  await page.goto(tweetUrl, { waitUntil: "domcontentloaded" });
  await delay(1500, 3000);

  const likeBtn = await page.$('button[data-testid="like"]');
  if (!likeBtn) {
    const unlikeBtn = await page.$('button[data-testid="unlike"]');
    if (unlikeBtn) {
      log.info("Already liked", { tweetId: tweet.id });
      return false;
    }
    log.warn("Like button not found", { tweetId: tweet.id });
    return false;
  }

  const box = await likeBtn.boundingBox();
  if (box) {
    await page.mouse.move(
      box.x + box.width / 2 + (Math.random() * 6 - 3),
      box.y + box.height / 2 + (Math.random() * 6 - 3),
    );
    await delay(200, 500);
  }

  await likeBtn.click();
  await delay(500, 1000);

  const unlikeBtn = await page.$('button[data-testid="unlike"]');
  return unlikeBtn !== null;
}

export async function autoLike(
  authToken: string,
  ct0: string,
  maxLikes: number = 5,
  alreadyLikedIds: string[] = [],
  languages: string | null = null,
): Promise<AutolikeOutcome> {
  const validation = validateCookies(authToken, ct0);
  if (!validation.valid) {
    return { ok: false, reason: "error", detail: `Invalid cookies: ${validation.error}` };
  }

  const alreadyLikedSet = new Set(alreadyLikedIds);
  const session = await launchXBrowser(authToken, ct0);

  try {
    const { handler, responses } = createGraphQLInterceptor(TIMELINE_OPERATIONS);
    const page = await session.context.newPage();
    page.on("response", handler);

    try {
      // Navigate to home timeline
      log.info("Navigating to home");
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });

      for (let i = 0; i < 40; i++) {
        await delay(500, 500);
        if (responses.length > 0) break;
      }

      if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
        return { ok: false, reason: "error", detail: "Cookies expired - redirected to login" };
      }

      // Scroll to get more tweets
      await delay(1000, 2000);
      await page.evaluate("window.scrollBy(0, 600)");
      await delay(1500, 3000);
      await page.evaluate("window.scrollBy(0, 600)");
      await delay(1000, 2000);

      // Parse captured tweets
      const allTweets: ParsedTweet[] = [];
      const seenIds = new Set<string>();
      for (const body of responses) {
        for (const entry of extractEntries(body)) {
          const tweet = parseTweetEntry(entry);
          if (tweet && !seenIds.has(tweet.id)) {
            seenIds.add(tweet.id);
            allTweets.push(tweet);
          }
        }
      }

      const scraped = allTweets.map(tweetToScraped);
      log.info("Tweets scraped", { count: scraped.length });

      if (allTweets.length === 0) {
        return { ok: true, scraped: [], liked: [] };
      }

      // Filter eligible tweets
      let eligible = allTweets.filter(
        (t) => !alreadyLikedSet.has(t.id) && t.authorUsername,
      );

      // Language filter (basic: use tweet's lang field from GraphQL)
      if (languages) {
        const langSet = new Set(languages.split(",").map((l) => l.trim()));
        eligible = eligible.filter((t) => !t.language || langSet.has(t.language));
      }

      // Shuffle and limit
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
      }
      const toLike = eligible.slice(0, maxLikes);

      const liked: LikedTweetFromPython[] = [];

      // Like tweets
      for (const tweet of toLike) {
        try {
          const success = await likeTweetOnPage(page, tweet);
          if (success) {
            liked.push({
              tweet_id: tweet.id,
              author_username: tweet.authorUsername,
              text: tweet.text.slice(0, 300),
              likes: tweet.likes,
              retweets: tweet.retweets,
              views: tweet.views,
            });
            log.info("Tweet liked", { tweetId: tweet.id, author: tweet.authorUsername });
          }
          await delay(3000, 8000);
        } catch (err) {
          log.warn("Like failed", {
            tweetId: tweet.id,
            error: err,
          });
          await delay(5000, 10000);
        }
      }

      return { ok: true, scraped, liked };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", detail: msg };
  } finally {
    await session.cleanup();
  }
}
