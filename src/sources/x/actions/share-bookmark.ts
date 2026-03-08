/** Share top video bookmark by posting the video URL as a new tweet. */

import type { Page, Response as PwResponse } from "playwright";
import type { ShareOutcome } from "../bookmarks/types";
import {
  launchXBrowser,
  validateCookies,
  extractOperation,
  delay,
  BASE_URL,
  BOOKMARKS_URL,
  BOOKMARK_OPERATIONS,
} from "../shared";
import { createLogger } from "../../../logger";

import { getErrorMessage } from "../../../lib/error-serialization";
const log = createLogger("x-share-bookmark");

interface VideoEntry {
  tweet_id: string;
  author: string;
  url: string;
  video_url: string;
}

function findScreenName(tweetObj: Record<string, unknown>): string {
  // Path 1: core.user_results.result.legacy.screen_name
  const core = tweetObj.core as Record<string, unknown> | undefined;
  if (core) {
    for (const key of ["user_results", "user_result"]) {
      const ur = core[key] as Record<string, unknown> | undefined;
      if (ur) {
        const result = ur.result as Record<string, unknown> | undefined;
        if (result) {
          const legacy = result.legacy as Record<string, unknown> | undefined;
          if (legacy?.screen_name) return String(legacy.screen_name);
          if (result.screen_name) return String(result.screen_name);
        }
      }
    }
  }

  // Path 2: from extended_entities media expanded_url
  const legacy = tweetObj.legacy as Record<string, unknown> | undefined;
  if (legacy) {
    const extEnt = legacy.extended_entities as Record<string, unknown> | undefined;
    if (extEnt) {
      const mediaList = extEnt.media as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(mediaList)) {
        for (const m of mediaList) {
          const expanded = String(m.expanded_url ?? "");
          const match = expanded.match(/x\.com\/([^/]+)\/status\//);
          if (match) return match[1]!;
        }
      }
    }

    // Path 3: entities.user_mentions
    const entities = legacy.entities as Record<string, unknown> | undefined;
    if (entities) {
      const mentions = entities.user_mentions as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(mentions) && mentions.length > 0 && mentions[0]!.screen_name) {
        return String(mentions[0]!.screen_name);
      }
      // Path 4: entities.urls
      const urls = entities.urls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(urls)) {
        for (const u of urls) {
          const expanded = String(u.expanded_url ?? "");
          const match = expanded.match(/x\.com\/([^/]+)\/status\//);
          if (match) return match[1]!;
        }
      }
    }
  }

  return "";
}

function extractVideoTweets(
  data: unknown,
  depth = 0,
): VideoEntry[] {
  if (depth > 30) return [];
  const results: VideoEntry[] = [];

  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const dict = data as Record<string, unknown>;
    const legacy = dict.legacy as Record<string, unknown> | undefined;
    const restId = dict.rest_id as string | undefined;
    const typename = String(dict.__typename ?? "");

    if (
      legacy &&
      restId &&
      ["Tweet", "TweetWithVisibilityResults", ""].includes(typename)
    ) {
      const extended = (legacy.extended_entities ?? {}) as Record<string, unknown>;
      const mediaList = extended.media as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(mediaList)) {
        const hasVideo = mediaList.some((m) => m.type === "video");
        if (hasVideo) {
          let videoAuthor = "";
          let videoTweetId = String(restId);

          for (const m of mediaList) {
            if (m.type !== "video") continue;
            const expanded = String(m.expanded_url ?? "");
            const match = expanded.match(/x\.com\/([^/]+)\/status\/(\d+)/);
            if (match) {
              videoAuthor = match[1]!;
              videoTweetId = match[2]!;
              break;
            }
          }

          if (!videoAuthor) {
            videoAuthor = findScreenName(dict);
          }

          results.push({
            tweet_id: videoTweetId,
            author: videoAuthor,
            url: videoAuthor
              ? `${BASE_URL}/${videoAuthor}/status/${videoTweetId}`
              : "",
            video_url: videoAuthor
              ? `${BASE_URL}/${videoAuthor}/status/${videoTweetId}/video/1`
              : "",
          });
          return results;
        }
      }
    }

    for (const value of Object.values(dict)) {
      if (typeof value === "object" && value !== null) {
        results.push(...extractVideoTweets(value, depth + 1));
      }
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        results.push(...extractVideoTweets(item, depth + 1));
      }
    }
  }

  return results;
}

export async function shareBookmark(
  authToken: string,
  ct0: string,
  skipIds: string[] = [],
): Promise<ShareOutcome> {
  const validation = validateCookies(authToken, ct0);
  if (!validation.valid) {
    return { ok: false, reason: "error", detail: `Invalid cookies: ${validation.error}` };
  }

  const skipSet = new Set(skipIds);
  const session = await launchXBrowser(authToken, ct0);
  const bookmarkEntries: VideoEntry[] = [];

  const handler = (response: PwResponse) => {
    if (response.status() !== 200) return;
    const op = extractOperation(response.url());
    if (!op) return;
    // Check if any bookmark operation name appears in the URL
    const url = response.url();
    const isBookmark = Array.from(BOOKMARK_OPERATIONS).some((bop) => url.includes(bop));
    if (isBookmark) {
      response
        .json()
        .then((body) => {
          const videos = extractVideoTweets(body);
          bookmarkEntries.push(...videos);
        })
        .catch(() => {});
    }
  };

  try {
    const page = await session.context.newPage();
    page.on("response", handler);

    try {
      // Step 1: Load bookmarks
      await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded" });

      for (let i = 0; i < 40; i++) {
        await delay(500, 500);
        if (bookmarkEntries.length > 0) break;
      }

      if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
        return { ok: false, reason: "error", detail: "Cookies expired - redirected to login" };
      }

      if (bookmarkEntries.length === 0) {
        await page.evaluate("window.scrollBy(0, 800)");
        await delay(2000, 2000);
      }

      if (bookmarkEntries.length === 0) {
        return { ok: false, reason: "no_video_bookmarks" };
      }

      // Deduplicate and filter
      const seen = new Set<string>();
      const unique: VideoEntry[] = [];
      for (const entry of bookmarkEntries) {
        if (!seen.has(entry.tweet_id) && !skipSet.has(entry.tweet_id)) {
          seen.add(entry.tweet_id);
          unique.push(entry);
        }
      }

      if (unique.length === 0) {
        return { ok: false, reason: "no_video_bookmarks" };
      }

      const target = unique[0]!;
      log.info("Found video bookmark", {
        tweetId: target.tweet_id,
        author: target.author,
      });

      if (!target.author) {
        return {
          ok: false,
          reason: "error",
          detail: `Could not extract author for tweet ${target.tweet_id}`,
        };
      }

      // Step 2: Open compose and type video URL
      const composeBtn = await page.$(
        'a[data-testid="SideNav_NewTweet_Button"], ' +
          'a[href="/compose/post"], ' +
          '[data-testid="FloatingCompose_Tweet_Button"]',
      );

      if (composeBtn) {
        await composeBtn.click();
      } else {
        await page.goto(`${BASE_URL}/compose/post`, {
          waitUntil: "domcontentloaded",
        });
      }

      await delay(2000, 2000);

      const textBox = await page.waitForSelector(
        '[data-testid="tweetTextarea_0"], div[contenteditable="true"][role="textbox"]',
        { timeout: 10000 },
      );

      if (!textBox) {
        return { ok: false, reason: "error", detail: "Could not find compose text box" };
      }

      await textBox.click();
      await delay(500, 500);

      // Type URL with retry
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.keyboard.type(target.video_url, { delay: 50 });
        await delay(500, 500);

        const actual = await textBox.evaluate(
          (el: HTMLElement) => el.innerText.trim(),
        );
        if (actual.includes(target.video_url)) break;

        log.warn("Text mismatch, retrying", { attempt: attempt + 1 });
        await page.keyboard.press("Control+KeyA");
        await page.keyboard.press("Backspace");
        await delay(500, 500);
      }

      await page.keyboard.press("Space");
      await delay(3000, 3000);

      // Step 3: Click Post
      const postBtn = await page.waitForSelector(
        '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        { timeout: 10000 },
      );
      if (!postBtn) {
        return { ok: false, reason: "error", detail: "Post button not found" };
      }

      await postBtn.click();
      await delay(3000, 3000);
      log.info("Video posted", { tweetId: target.tweet_id });

      // Step 4: Remove from bookmarks
      await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded" });
      await delay(3000, 3000);

      const articles = await page.$$(
        'article[data-testid="tweet"]',
      );
      for (const article of articles) {
        const links = await article.$$("a[href]");
        let found = false;
        for (const link of links) {
          const href = await link.getAttribute("href");
          if (href && href.includes(target.tweet_id)) {
            found = true;
            break;
          }
        }
        if (found) {
          const bookmarkBtn = await article.$(
            '[data-testid="removeBookmark"], [data-testid="bookmark"]',
          );
          if (bookmarkBtn) {
            await bookmarkBtn.click();
            await delay(1000, 1000);
            log.info("Bookmark removed", { tweetId: target.tweet_id });
          }
          break;
        }
      }

      return {
        ok: true,
        tweet_id: target.tweet_id,
        author: target.author,
        url: target.url,
      };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    return { ok: false, reason: "error", detail: msg };
  } finally {
    await session.cleanup();
  }
}
