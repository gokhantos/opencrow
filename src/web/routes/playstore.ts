import { Hono } from "hono";
import { createLogger } from "../../logger";
import {
  getRankings,
  getRankingsByCategory,
  getDiscoveredApps,
  getLowRatedReviews,
} from "../../sources/playstore/store";
import { getDb } from "../../store/db";
import type { CoreClient } from "../core-client";

const log = createLogger("playstore-api");

export function createPlayStoreRoutes(
  opts: { coreClient?: CoreClient } = {},
): Hono {
  const app = new Hono();

  app.get("/playstore/rankings", async (c) => {
    const listType = c.req.query("list_type") || undefined;
    const category = c.req.query("category") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "200") || 200, 500));

    const rankings = category
      ? await getRankingsByCategory(category, limit)
      : await getRankings(listType, limit);

    return c.json({ success: true, data: rankings });
  });

  app.get("/playstore/discovered", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "100") || 100, 500));
    const apps = await getDiscoveredApps(limit);
    return c.json({ success: true, data: apps });
  });

  app.get("/playstore/reviews", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const reviews = await getLowRatedReviews(limit);
    return c.json({ success: true, data: reviews });
  });

  app.get("/playstore/stats", async (c) => {
    const db = getDb();
    const rows = await db`
      SELECT
        (SELECT count(*) FROM playstore_rankings) as total_apps,
        (SELECT count(*) FROM playstore_reviews) as total_reviews,
        (SELECT count(DISTINCT category) FROM playstore_rankings) as total_categories,
        (SELECT max(updated_at) FROM playstore_rankings) as last_updated_at
    `;
    const stats = rows[0] ?? {
      total_apps: 0,
      total_reviews: 0,
      total_categories: 0,
      last_updated_at: null,
    };
    return c.json({ success: true, data: stats });
  });

  app.post("/playstore/scrape-now", async (c) => {
    log.info("Manual Play Store scrape triggered");

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction(
        "playstore",
        "scrape-now",
        {},
      );
      return c.json({ success: true, data: result.data });
    }

    return c.json(
      { success: false, error: "Play Store scraper not available" },
      503,
    );
  });

  return app;
}
