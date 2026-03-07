import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import type { AutolikeProcessor } from "../../sources/x/interactions/processor";
import type { CoreClient } from "../core-client";
import {
  getAutolikeJob,
  upsertAutolikeJob,
  stopAutolikeJob,
  getScrapedTweets,
  getLikedTweets,
} from "../../sources/x/interactions/store";

const log = createLogger("x-interactions-api");

const SUPPORTED_LANGUAGES = [
  "tr",
  "en",
  "de",
  "fr",
  "es",
  "pt",
  "it",
  "nl",
  "ru",
  "ar",
  "ja",
  "ko",
  "zh",
] as const;

const startSchema = z.object({
  account_id: z.string().min(1),
  interval_minutes: z.number().int().min(1).max(1440).default(15),
  max_likes_per_run: z.number().int().min(1).max(50).default(5),
  languages: z.array(z.string()).max(10).nullable().optional().default(null),
});

const stopSchema = z.object({
  account_id: z.string().min(1),
});

const runNowSchema = z.object({
  account_id: z.string().min(1),
});

export function createInteractionRoutes(opts: {
  processor?: AutolikeProcessor;
  coreClient?: CoreClient;
}): Hono {
  const app = new Hono();

  app.post("/interactions/start", async (c) => {
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

    const { account_id, interval_minutes, max_likes_per_run, languages } =
      parsed.data;
    const langStr =
      languages && languages.length > 0 ? languages.join(",") : null;
    const now = Math.floor(Date.now() / 1000);
    const baseSec = interval_minutes * 60;
    const jittered = Math.round(baseSec * (0.8 + Math.random() * 0.4));
    const nextRunAt = now + jittered;

    const job = await upsertAutolikeJob(
      account_id,
      interval_minutes,
      max_likes_per_run,
      "running",
      nextRunAt,
      langStr,
    );

    log.info("Autolike started", {
      account_id,
      interval_minutes,
      max_likes_per_run,
      languages: langStr,
    });
    return c.json({ success: true, data: job });
  });

  app.post("/interactions/stop", async (c) => {
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

    await stopAutolikeJob(parsed.data.account_id);
    const job = await getAutolikeJob(parsed.data.account_id);

    log.info("Autolike stopped", { account_id: parsed.data.account_id });
    return c.json({ success: true, data: job });
  });

  app.get("/interactions/status", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const job = await getAutolikeJob(accountId);
    return c.json({ success: true, data: job });
  });

  app.get("/interactions/scraped", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const limitParam = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(Number(limitParam ?? "100") || 100, 500),
    );
    const tweets = await getScrapedTweets(accountId, limit);

    return c.json({ success: true, data: tweets });
  });

  app.get("/interactions/liked", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const limitParam = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(Number(limitParam ?? "100") || 100, 500),
    );
    const tweets = await getLikedTweets(accountId, limit);

    return c.json({ success: true, data: tweets });
  });

  app.post("/interactions/run-now", async (c) => {
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

    log.info("Manual autolike triggered", {
      account_id: parsed.data.account_id,
    });

    if (opts.processor) {
      const result = await opts.processor.runNow(parsed.data.account_id);
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      try {
        const result = await opts.coreClient.scraperAction(
          "x-interactions",
          "run-now",
          {
            accountId: parsed.data.account_id,
          },
        );
        return c.json({ success: true, data: result.data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Autolike request failed";
        log.error("Autolike run-now failed", { error: msg });
        return c.json({ success: false, error: msg }, 502);
      }
    }
    return c.json(
      { success: false, error: "Autolike processor not available" },
      503,
    );
  });

  return app;
}
