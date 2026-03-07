import { Hono } from "hono";
import { createLogger } from "../../logger";
import { getTrends } from "../../sources/google-trends/store";
import { getDb } from "../../store/db";
import type { CoreClient } from "../core-client";

const log = createLogger("google-trends-api");

export function createGoogleTrendsRoutes(opts: {
  coreClient?: CoreClient;
} = {}): Hono {
  const app = new Hono();

  app.get("/trends/list", async (c) => {
    const category = c.req.query("category") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const trends = await getTrends(category, limit);
    return c.json({ success: true, data: trends });
  });

  app.get("/trends/stats", async (c) => {
    const db = getDb();
    const rows = await db`
      SELECT
        count(*) as total_trends,
        max(updated_at) as last_updated_at,
        count(DISTINCT category) as categories
      FROM google_trends
    `;
    const stats = rows[0] ?? { total_trends: 0, last_updated_at: null, categories: 0 };
    return c.json({ success: true, data: stats });
  });

  app.post("/trends/scrape-now", async (c) => {
    log.info("Manual Google Trends scrape triggered");

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("google-trends", "scrape-now", {});
      return c.json({ success: true, data: result.data });
    }

    return c.json({ success: false, error: "Google Trends scraper not available" }, 503);
  });

  app.post("/trends/backfill-rag", async (c) => {
    log.info("Google Trends RAG backfill triggered");

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("google-trends", "backfill-rag");
      return c.json({ success: true, data: result.data });
    }

    return c.json({ success: false, error: "Google Trends scraper not available" }, 503);
  });

  return app;
}
