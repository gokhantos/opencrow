import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import type { AutofollowProcessor } from "../../sources/x/follow/processor";
import type { CoreClient } from "../core-client";
import {
  getAutofollowJob,
  upsertAutofollowJob,
  stopAutofollowJob,
  getFollowedUsers,
} from "../../sources/x/follow/store";

const log = createLogger("x-follow-api");

const startSchema = z.object({
  account_id: z.string().min(1),
  interval_minutes: z.number().int().min(1).max(1440).default(60),
  max_follows_per_run: z.number().int().min(1).max(20).default(3),
  languages: z.array(z.string()).max(10).nullable().optional().default(null),
});

const stopSchema = z.object({
  account_id: z.string().min(1),
});

const runNowSchema = z.object({
  account_id: z.string().min(1),
});

export function createFollowRoutes(opts: {
  processor?: AutofollowProcessor;
  coreClient?: CoreClient;
}): Hono {
  const app = new Hono();

  app.post("/follow/start", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
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

    const { account_id, interval_minutes, max_follows_per_run, languages } =
      parsed.data;
    const langStr =
      languages && languages.length > 0 ? languages.join(",") : null;
    const now = Math.floor(Date.now() / 1000);
    const baseSec = interval_minutes * 60;
    const jittered = Math.round(baseSec * (0.8 + Math.random() * 0.4));
    const nextRunAt = now + jittered;

    const job = await upsertAutofollowJob(
      account_id,
      interval_minutes,
      max_follows_per_run,
      "running",
      nextRunAt,
      langStr,
    );

    log.info("Autofollow started", {
      account_id,
      interval_minutes,
      max_follows_per_run,
      languages: langStr,
    });
    return c.json({ success: true, data: job });
  });

  app.post("/follow/stop", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
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

    await stopAutofollowJob(parsed.data.account_id);
    const job = await getAutofollowJob(parsed.data.account_id);

    log.info("Autofollow stopped", { account_id: parsed.data.account_id });
    return c.json({ success: true, data: job });
  });

  app.get("/follow/status", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const job = await getAutofollowJob(accountId);
    return c.json({ success: true, data: job });
  });

  app.get("/follow/history", async (c) => {
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
    const users = await getFollowedUsers(accountId, limit);

    return c.json({ success: true, data: users });
  });

  app.post("/follow/run-now", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
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

    log.info("Manual autofollow triggered", {
      account_id: parsed.data.account_id,
    });

    if (opts.processor) {
      const result = await opts.processor.runNow(parsed.data.account_id);
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction(
        "x-follow",
        "run-now",
        {
          accountId: parsed.data.account_id,
        },
      );
      return c.json({ success: true, data: result.data });
    }
    return c.json(
      { success: false, error: "Autofollow processor not available" },
      503,
    );
  });

  return app;
}
