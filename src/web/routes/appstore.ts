import { Hono } from "hono";
import { createLogger } from "../../logger";
import {
  getRankings,
  getRankingsByCategory,
  getDiscoveredApps,
  getLowRatedReviews,
} from "../../sources/appstore/store";
import { getDb } from "../../store/db";
import type { CoreClient } from "../core-client";

const log = createLogger("appstore-api");

export function createAppStoreRoutes(
  opts: { coreClient?: CoreClient } = {},
): Hono {
  const app = new Hono();

  app.get("/appstore/rankings", async (c) => {
    const listType = c.req.query("list_type") || undefined;
    const category = c.req.query("category") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "200") || 200, 500));

    const rankings = category
      ? await getRankingsByCategory(category, limit)
      : await getRankings(listType, limit);

    return c.json({ success: true, data: rankings });
  });

  app.get("/appstore/discovered", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "100") || 100, 500));
    const apps = await getDiscoveredApps(limit);
    return c.json({ success: true, data: apps });
  });

  app.get("/appstore/reviews", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const reviews = await getLowRatedReviews(limit);
    return c.json({ success: true, data: reviews });
  });

  app.get("/appstore/stats", async (c) => {
    const db = getDb();
    const rows = await db`
      SELECT
        (SELECT count(*) FROM appstore_apps) as total_apps,
        (SELECT count(*) FROM appstore_reviews) as total_reviews,
        (SELECT count(DISTINCT category) FROM appstore_apps) as total_categories,
        (SELECT max(updated_at) FROM appstore_apps) as last_updated_at
    `;
    const stats = rows[0] ?? {
      total_apps: 0,
      total_reviews: 0,
      total_categories: 0,
      last_updated_at: null,
    };
    return c.json({ success: true, data: stats });
  });

  app.post("/appstore/scrape-now", async (c) => {
    log.info("Manual App Store scrape triggered");

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction(
        "appstore",
        "scrape-now",
        {},
      );
      return c.json({ success: true, data: result.data });
    }

    return c.json(
      { success: false, error: "App Store scraper not available" },
      503,
    );
  });

  return app;
}
