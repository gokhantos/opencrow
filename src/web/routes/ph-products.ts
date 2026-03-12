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
    const { getSecret } = await import("../../config/secrets");
    const phToken = await getSecret("PH_API_TOKEN");
    const phSecret = await getSecret("PH_API_SECRET");
    if (!phToken || !phSecret) {
      return c.json({ success: false, error: "PH_API_TOKEN and PH_API_SECRET must both be configured" }, 400);
    }

    log.info("Manual PH scrape triggered");

    if (opts.scraper) {
      const result = await opts.scraper.scrapeNow();
      return c.json({ success: true, data: result });
    }

    if (opts.coreClient) {
      try {
        const result = await opts.coreClient.scraperAction("ph", "scrape-now", {});
        if (!result.error) {
          return c.json({ success: true, data: result.data });
        }
        log.warn("Core PH scraper unavailable, falling back to direct scrape", { error: result.error });
      } catch {
        log.warn("Core unreachable, falling back to direct scrape");
      }
    }

    // Direct scrape fallback — works even when PH scraper process isn't running
    try {
      const { createPHScraper } = await import("../../sources/producthunt/scraper");
      const scraper = createPHScraper();
      const result = await scraper.scrapeNow();
      return c.json({ success: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Direct scrape failed";
      log.error("Direct PH scrape failed", { err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.post("/ph/backfill-rag", async (c) => {
    log.info("PH RAG backfill triggered");
    try {
      if (opts.scraper) {
        const result = await opts.scraper.backfillRag();
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.coreClient) {
        const result = await opts.coreClient.scraperAction("ph", "backfill-rag");
        return c.json({ success: true, data: result.data });
      }
      return c.json({ success: false, error: "PH scraper not available" }, 503);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      log.error("PH RAG backfill error", { error: err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
