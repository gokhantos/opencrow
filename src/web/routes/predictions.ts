import { Hono } from "hono";
import { getPredictionStats } from "../../agent/prediction-engine";
import { createLogger } from "../../logger";

const log = createLogger("web-predictions");

export function createPredictionsRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/predictions/stats - Get prediction engine performance stats
   */
  app.get("/predictions/stats", async (c) => {
    try {
      const stats = await getPredictionStats();
      return c.json({ success: true, data: stats });
    } catch (err) {
      log.warn("Failed to get prediction stats", { error: String(err) });
      return c.json({ success: false, error: "Failed to get prediction stats" }, 500);
    }
  });

  return app;
}
