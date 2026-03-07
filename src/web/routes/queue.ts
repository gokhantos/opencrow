import { Hono } from "hono";
import { getQueueStats, getQueueDepthByDomain } from "../../agent/queue-manager";
import { createLogger } from "../../logger";

const log = createLogger("web-queue");

export function createQueueRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/queue/stats - Get queue statistics for a time window
   * Query params: window (e.g. "1h", "24h", "7d") — defaults to "24h"
   */
  app.get("/queue/stats", async (c) => {
    const window = c.req.query("window") ?? "24h";
    try {
      const stats = await getQueueStats(window);
      return c.json({ success: true, data: stats });
    } catch (err) {
      log.warn("Failed to get queue stats", { error: String(err) });
      return c.json({ success: false, error: "Failed to get queue stats" }, 500);
    }
  });

  /**
   * GET /api/queue/depth - Get pending task counts grouped by domain
   */
  app.get("/queue/depth", async (c) => {
    try {
      const depth = await getQueueDepthByDomain();
      return c.json({ success: true, data: depth });
    } catch (err) {
      log.warn("Failed to get queue depth", { error: String(err) });
      return c.json({ success: false, error: "Failed to get queue depth" }, 500);
    }
  });

  return app;
}
