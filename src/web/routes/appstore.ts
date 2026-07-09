import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { getTopOpportunities, getScanHistory } from "../../sources/appstore/keyword-store";
import type { GapTrend } from "../../sources/appstore/keyword-types";
import {
  getRankings,
  getRankingsByCategory,
  getDiscoveredApps,
  getLowRatedReviews,
} from "../../sources/appstore/store";
import { getDb } from "../../store/db";
import type { CoreClient } from "../core-client";

const log = createLogger("appstore-api");

const GAP_TRENDS = ["heating", "stable", "cooling", "new"] as const satisfies readonly GapTrend[];

const opportunitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  genreZone: z.string().optional(),
  trend: z.enum(GAP_TRENDS).optional(),
});

const scanHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

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

  app.get("/appstore/opportunities", async (c) => {
    const rawQuery: Record<string, string> = {};
    for (const key of ["limit", "genreZone", "trend"] as const) {
      const value = c.req.query(key);
      if (value) rawQuery[key] = value;
    }

    const parsed = opportunitiesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { limit, genreZone, trend } = parsed.data;
    const opportunities = await getTopOpportunities({ limit, genreZone, trend });
    return c.json({ success: true, data: opportunities });
  });

  app.get("/appstore/opportunities/:keyword", async (c) => {
    const keyword = c.req.param("keyword");
    const parsed = scanHistoryQuerySchema.safeParse({
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const history = await getScanHistory(keyword, parsed.data.limit);
    return c.json({ success: true, data: history });
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
