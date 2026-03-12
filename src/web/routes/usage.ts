import { Hono } from "hono";
import {
  getUsageSummary,
  getUsageByAgent,
  getUsageByModel,
  getUsageTimeSeries,
  getRecentUsage,
} from "../../store/token-usage";

export function createUsageRoutes(): Hono {
  const app = new Hono();

  function parseSince(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function parseUntil(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  app.get("/usage/summary", async (c) => {
    const since = parseSince(c.req.query("since"));
    const until = parseUntil(c.req.query("until"));
    const data = await getUsageSummary({ since, until });
    return c.json({ success: true, data });
  });

  app.get("/usage/by-agent", async (c) => {
    const since = parseSince(c.req.query("since"));
    const until = parseUntil(c.req.query("until"));
    const data = await getUsageByAgent({ since, until });
    return c.json({ success: true, data });
  });

  app.get("/usage/by-model", async (c) => {
    const since = parseSince(c.req.query("since"));
    const until = parseUntil(c.req.query("until"));
    const data = await getUsageByModel({ since, until });
    return c.json({ success: true, data });
  });

  app.get("/usage/timeseries", async (c) => {
    const since = parseSince(c.req.query("since"));
    const granularity =
      c.req.query("granularity") === "day" ? "day" : "hour";
    const data = await getUsageTimeSeries({
      since: since ?? Math.floor(Date.now() / 1000) - 7 * 86400,
      granularity,
    });
    return c.json({ success: true, data });
  });

  app.get("/usage/recent", async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 500));
    const since = parseSince(c.req.query("since"));
    const data = await getRecentUsage(limit, since);
    return c.json({ success: true, data });
  });

  return app;
}
