import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import type { NewsProcessor } from "../../sources/news/processor";
import type { NewsSource } from "../../sources/news/types";
import type { CoreClient } from "../core-client";
import {
  getArticles,
  getCalendarEvents,
  getArticleStats,
  getScraperRuns,
} from "../../sources/news/store";

const log = createLogger("news-api");

const VALID_SOURCES: readonly string[] = [
  "cryptopanic",
  "cointelegraph",
  "reuters",
  "investing_news",
  "investing_calendar",
];

const scrapeNowSchema = z.object({
  source: z.enum([
    "cryptopanic",
    "cointelegraph",
    "reuters",
    "investing_news",
    "investing_calendar",
  ]),
});

export function createNewsRoutes(opts: {
  processor?: NewsProcessor;
  coreClient?: CoreClient;
}): Hono {
  const app = new Hono();

  app.get("/news/articles", async (c) => {
    const source = c.req.query("source");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const offset = Math.max(0, Number(offsetParam ?? "0") || 0);

    if (source && !VALID_SOURCES.includes(source)) {
      return c.json(
        { success: false, error: `Invalid source: ${source}` },
        400,
      );
    }

    const articles = await getArticles({ source, limit, offset });
    return c.json({ success: true, data: articles });
  });

  app.get("/news/calendar", async (c) => {
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const offset = Math.max(0, Number(offsetParam ?? "0") || 0);

    const events = await getCalendarEvents({ limit, offset });
    return c.json({ success: true, data: events });
  });

  app.get("/news/stats", async (c) => {
    const stats = await getArticleStats();
    return c.json({ success: true, data: stats });
  });

  app.get("/news/runs", async (c) => {
    const source = c.req.query("source");
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "20") || 20, 100));

    const runs = await getScraperRuns({ source, limit });
    return c.json({ success: true, data: runs });
  });

  app.post("/news/scrape-now", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = scrapeNowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const source = parsed.data.source as NewsSource;
    log.info("Manual scrape triggered", { source });

    if (opts.processor) {
      const result = await opts.processor.scrapeNow(source);
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("news", "scrape-now", { source });
      return c.json({ success: true, data: result.data });
    }
    return c.json({ success: false, error: "News processor not available" }, 503);
  });

  app.post("/news/backfill-rag", async (c) => {
    log.info("News RAG backfill triggered");
    try {
      if (opts.processor) {
        const result = await opts.processor.backfillRag();
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.coreClient) {
        const result = await opts.coreClient.scraperAction("news", "backfill-rag");
        return c.json({ success: true, data: result.data });
      }
      return c.json({ success: false, error: "News processor not available" }, 503);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      log.error("News RAG backfill error", { error: err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
