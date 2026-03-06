import { Hono } from "hono";
import { createLogger } from "../../logger";
import { getProducts } from "../../sources/producthunt/store";
import { getDb } from "../../store/db";
import type { PHScraper } from "../../sources/producthunt/scraper";
import type { CoreClient } from "../core-client";

const log = createLogger("ph-products-api");

export function createPHProductRoutes(opts: {
  scraper?: PHScraper;
  coreClient?: CoreClient;
}): Hono {
  const app = new Hono();

  app.get("/ph/products", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));

    const products = await getProducts(limit);
    return c.json({ success: true, data: products });
  });

  app.get("/ph/products/stats", async (c) => {
    const db = getDb();
    const rows = await db`
      SELECT
        count(*) as total_products,
        max(updated_at) as last_updated_at
      FROM ph_products
    `;
    const stats = rows[0] ?? { total_products: 0, last_updated_at: null };
    return c.json({ success: true, data: stats });
  });

  app.post("/ph/scrape-now", async (c) => {
    if (!process.env.PH_API_TOKEN || !process.env.PH_API_SECRET) {
      return c.json({ success: false, error: "PH_API_TOKEN and PH_API_SECRET must both be configured" }, 400);
    }

    log.info("Manual PH scrape triggered");

    if (opts.scraper) {
      const result = await opts.scraper.scrapeNow();
      return c.json({ success: true, data: result });
    }

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("ph", "scrape-now", {});
      return c.json({ success: true, data: result.data });
    }

    return c.json({ success: false, error: "PH scraper not available" }, 503);
  });

  app.post("/ph/backfill-rag", async (c) => {
    log.info("PH RAG backfill triggered");

    if (opts.scraper) {
      const result = await opts.scraper.backfillRag();
      return c.json({ success: true, data: result });
    }

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("ph", "backfill-rag");
      return c.json({ success: true, data: result.data });
    }

    return c.json({ success: false, error: "PH scraper not available" }, 503);
  });

  return app;
}
