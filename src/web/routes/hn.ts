import { Hono } from "hono";
import { createLogger } from "../../logger";
import type { HNScraper } from "../../sources/hackernews/scraper";
import type { CoreClient } from "../core-client";
import type { MemoryManager, StoryForIndex } from "../../memory/types";
import { getStories, type HNStoryRow } from "../../sources/hackernews/store";
import { getDb } from "../../store/db";

const log = createLogger("hn-api");

export function createHNRoutes(opts: {
  scraper?: HNScraper;
  coreClient?: CoreClient;
  memoryManager?: MemoryManager;
}): Hono {
  const app = new Hono();

  app.get("/hn/stories", async (c) => {
    const feedType = c.req.query("feed") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));

    const stories = await getStories(feedType, limit);
    return c.json({ success: true, data: stories });
  });

  app.get("/hn/stats", async (c) => {
    const db = getDb();
    const rows = await db`
      SELECT
        count(*) as total_stories,
        max(updated_at) as last_updated_at,
        count(DISTINCT feed_type) as feed_types
      FROM hn_stories
    `;
    const stats = rows[0] ?? {
      total_stories: 0,
      last_updated_at: null,
      feed_types: 0,
    };
    return c.json({ success: true, data: stats });
  });

  app.post("/hn/scrape-now", async (c) => {
    log.info("Manual HN scrape triggered");
    if (opts.scraper) {
      const result = await opts.scraper.scrapeNow();
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("hn", "scrape-now");
      return c.json({ success: true, data: result.data });
    }
    return c.json({ success: false, error: "HN scraper not available" }, 503);
  });

  app.post("/hn/backfill-rag", async (c) => {
    log.info("HN RAG backfill triggered");
    try {
      if (opts.scraper) {
        const result = await opts.scraper.backfillRag();
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      // Run backfill directly if we have a memoryManager (web process)
      if (opts.memoryManager) {
        const result = await backfillRagDirect(opts.memoryManager);
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.coreClient) {
        const result = await opts.coreClient.scraperAction("hn", "backfill-rag");
        return c.json({ success: true, data: result.data });
      }
      return c.json({ success: false, error: "HN scraper not available" }, 503);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      log.error("HN RAG backfill error", { error: err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}

const HN_AGENT_ID = "hn";

function rowToStoryForIndex(s: HNStoryRow): StoryForIndex {
  const topComments = (() => {
    try {
      return s.top_comments_json
        ? (JSON.parse(s.top_comments_json) as string[])
        : undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    id: s.id,
    title: s.title,
    url: s.url,
    siteLabel: s.site_label,
    points: s.points,
    author: s.author,
    commentCount: s.comment_count,
    hnUrl: s.hn_url,
    rank: s.rank,
    description: s.description || undefined,
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
      const stories = await getStories(undefined, BATCH_SIZE, offset);
      if (stories.length === 0) break;

      const forIndex = stories.map(rowToStoryForIndex);
      await memoryManager.indexStories(HN_AGENT_ID, forIndex);
      totalIndexed += forIndex.length;
      offset += BATCH_SIZE;

      log.info("HN RAG backfill batch", {
        batch: Math.ceil(offset / BATCH_SIZE),
        batchSize: forIndex.length,
        totalSoFar: totalIndexed,
      });
    }

    log.info("HN RAG backfill complete", { totalIndexed });
    return { indexed: totalIndexed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("HN RAG backfill failed", { error: msg, totalIndexed });
    return { indexed: totalIndexed, error: msg };
  }
}
