import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import type { TimelineScrapeProcessor } from "../../sources/x/timeline/processor";
import type { CoreClient } from "../core-client";
import {
  getTimelineScrapeJob,
  upsertTimelineScrapeJob,
  stopTimelineScrapeJob,
  getTimelineTweets,
} from "../../sources/x/timeline/store";

const log = createLogger("x-timeline-api");

const startSchema = z.object({
  account_id: z.string().min(1),
  interval_minutes: z.number().int().min(5).max(1440).default(10),
  max_pages: z.number().int().min(1).max(10).default(3),
  sources: z.string().default("home,top_posts"),
  languages: z.string().nullable().default(null),
});

const stopSchema = z.object({
  account_id: z.string().min(1),
});

const runNowSchema = z.object({
  account_id: z.string().min(1),
});

export function createTimelineRoutes(opts: {
  processor?: TimelineScrapeProcessor;
  coreClient?: CoreClient;
}): Hono {
  const app = new Hono();

  app.post("/timeline/start", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = startSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const { account_id, interval_minutes, max_pages, sources, languages } = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const baseSec = interval_minutes * 60;
    const jittered = Math.round(baseSec * (0.8 + Math.random() * 0.4));
    const nextRunAt = now + jittered;

    const job = await upsertTimelineScrapeJob(
      account_id,
      max_pages,
      sources,
      interval_minutes,
      "running",
      nextRunAt,
      languages,
    );

    log.info("Timeline scrape started", {
      account_id,
      interval_minutes,
      max_pages,
      sources,
      languages,
    });
    return c.json({ success: true, data: job });
  });

  app.post("/timeline/stop", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = stopSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    await stopTimelineScrapeJob(parsed.data.account_id);
    const job = await getTimelineScrapeJob(parsed.data.account_id);

    log.info("Timeline scrape stopped", {
      account_id: parsed.data.account_id,
    });
    return c.json({ success: true, data: job });
  });

  app.get("/timeline/status", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const job = await getTimelineScrapeJob(accountId);
    return c.json({ success: true, data: job });
  });

  app.get("/timeline/tweets", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const source = c.req.query("source") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(Number(limitParam ?? "100") || 100, 500),
    );
    const tweets = await getTimelineTweets(accountId, source, limit);

    return c.json({ success: true, data: tweets });
  });

  app.post("/timeline/backfill-rag", async (c) => {
    log.info("Timeline RAG backfill triggered");
    try {
      if (opts.processor) {
        const result = await opts.processor.backfillRag();
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.coreClient) {
        const result = await opts.coreClient.scraperAction(
          "x-timeline",
          "backfill-rag",
        );
        return c.json({ success: true, data: result.data });
      }
      return c.json(
        { success: false, error: "Timeline processor not available" },
        503,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      log.error("Timeline RAG backfill error", { error: err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.post("/timeline/run-now", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = runNowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    log.info("Manual timeline scrape triggered", {
      account_id: parsed.data.account_id,
    });

    if (opts.processor) {
      const result = await opts.processor.runNow(parsed.data.account_id);
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction(
        "x-timeline",
        "run-now",
        {
          accountId: parsed.data.account_id,
        },
      );
      return c.json({ success: true, data: result.data });
    }
    return c.json(
      { success: false, error: "Timeline processor not available" },
      503,
    );
  });

  return app;
}
