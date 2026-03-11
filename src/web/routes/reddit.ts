import { Hono } from "hono";
import { createLogger } from "../../logger";
import type { RedditScraper } from "../../sources/reddit/scraper";
import type { CoreClient } from "../core-client";
import type { MemoryManager } from "../../memory/types";
import type { RedditPostForIndex } from "../../memory/types";
import { getPosts } from "../../sources/reddit/store";
import type { RedditPostRow } from "../../sources/reddit/store";
import { getDb } from "../../store/db";
import { getErrorMessage } from "../../lib/error-serialization";

const log = createLogger("reddit-api");

const REDDIT_AGENT_ID = "reddit";

function rowToPostForIndex(p: RedditPostRow): RedditPostForIndex {
  const topComments = (() => {
    try {
      return p.top_comments_json
        ? (JSON.parse(p.top_comments_json) as string[])
        : undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    id: p.id,
    title: p.title,
    subreddit: p.subreddit,
    url: p.url,
    selftext: p.selftext,
    author: p.author,
    score: p.score,
    numComments: p.num_comments,
    permalink: p.permalink,
    flair: p.flair ?? undefined,
    topComments,
  };
}

async function backfillRagDirect(
  memoryManager: MemoryManager,
): Promise<{ indexed: number; error?: string }> {
  const BATCH_SIZE = 50;
  let totalIndexed = 0;
  let offset = 0;

  try {
    while (true) {
      const posts = await getPosts(undefined, BATCH_SIZE, offset);
      if (posts.length === 0) break;

      const forIndex = posts.map(rowToPostForIndex);
      await memoryManager.indexRedditPosts(REDDIT_AGENT_ID, forIndex);
      totalIndexed += forIndex.length;
      offset += BATCH_SIZE;

      log.info("Reddit RAG backfill batch", {
        batch: Math.ceil(offset / BATCH_SIZE),
        batchSize: forIndex.length,
        totalSoFar: totalIndexed,
      });
    }

    log.info("Reddit RAG backfill complete", { totalIndexed });
    return { indexed: totalIndexed };
  } catch (err) {
    const msg = getErrorMessage(err);
    log.error("Reddit RAG backfill failed", { error: msg, totalIndexed });
    return { indexed: totalIndexed, error: msg };
  }
}

export function createRedditRoutes(opts: {
  scraper?: RedditScraper;
  coreClient?: CoreClient;
  memoryManager?: MemoryManager;
}): Hono {
  const app = new Hono();

  app.get("/reddit/posts", async (c) => {
    const subreddit = c.req.query("subreddit") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));

    const posts = await getPosts(subreddit, limit);
    return c.json({ success: true, data: posts });
  });

  app.get("/reddit/stats", async (c) => {
    const db = getDb();
    const rows = await db`
      SELECT
        count(*) as total_posts,
        max(updated_at) as last_updated_at,
        count(DISTINCT subreddit) as subreddit_count
      FROM reddit_posts
    `;
    const stats = rows[0] ?? {
      total_posts: 0,
      last_updated_at: null,
      subreddit_count: 0,
    };
    return c.json({ success: true, data: stats });
  });

  app.post("/reddit/scrape-now", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = (body as Record<string, string>).account_id;
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id required" },
        400,
      );
    }

    log.info("Manual Reddit scrape triggered", { accountId });
    if (opts.scraper) {
      const result = await opts.scraper.scrapeNow(accountId);
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("reddit", "scrape-now", { accountId });
      return c.json({ success: true, data: result.data });
    }
    return c.json({ success: false, error: "Reddit scraper not available" }, 503);
  });

  app.post("/reddit/backfill-rag", async (c) => {
    log.info("Reddit RAG backfill triggered");
    try {
      if (opts.scraper) {
        const result = await opts.scraper.backfillRag();
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.memoryManager) {
        const result = await backfillRagDirect(opts.memoryManager);
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.coreClient) {
        const result = await opts.coreClient.scraperAction("reddit", "backfill-rag");
        return c.json({ success: true, data: result.data });
      }
      return c.json({ success: false, error: "Reddit scraper not available" }, 503);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      log.error("Reddit RAG backfill error", { error: err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
