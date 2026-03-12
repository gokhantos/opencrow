import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import type { BookmarkProcessor } from "../../sources/x/bookmarks/processor";
import type { CoreClient } from "../core-client";
import {
  getBookmarkJob,
  upsertBookmarkJob,
  stopJob,
  getSharedVideos,
} from "../../sources/x/bookmarks/store";

const log = createLogger("x-bookmark-api");

const startSchema = z.object({
  account_id: z.string().min(1),
  interval_minutes: z.number().int().min(1).max(1440).default(15),
});

const stopSchema = z.object({
  account_id: z.string().min(1),
});

const shareNowSchema = z.object({
  account_id: z.string().min(1),
});

export function createBookmarkSharingRoutes(opts: {
  processor?: BookmarkProcessor;
  coreClient?: CoreClient;
}): Hono {
  const app = new Hono();

  app.post("/bookmarks/start", async (c) => {
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

    const { account_id, interval_minutes } = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const baseSec = interval_minutes * 60;
    const jittered = Math.round(baseSec * (0.8 + Math.random() * 0.4));
    const nextRunAt = now + jittered;

    const job = await upsertBookmarkJob(
      account_id,
      interval_minutes,
      "running",
      nextRunAt,
    );

    log.info("Bookmark sharing started", { account_id, interval_minutes });
    return c.json({ success: true, data: job });
  });

  app.post("/bookmarks/stop", async (c) => {
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

    await stopJob(parsed.data.account_id);
    const job = await getBookmarkJob(parsed.data.account_id);

    log.info("Bookmark sharing stopped", {
      account_id: parsed.data.account_id,
    });
    return c.json({ success: true, data: job });
  });

  app.get("/bookmarks/status", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const job = await getBookmarkJob(accountId);
    return c.json({ success: true, data: job });
  });

  app.get("/bookmarks/history", async (c) => {
    const accountId = c.req.query("account_id");
    if (!accountId) {
      return c.json(
        { success: false, error: "account_id query param required" },
        400,
      );
    }

    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const videos = await getSharedVideos(accountId, limit);

    return c.json({ success: true, data: videos });
  });

  app.post("/bookmarks/share-now", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = shareNowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    log.info("Manual bookmark share triggered", {
      account_id: parsed.data.account_id,
    });

    if (opts.processor) {
      const result = await opts.processor.shareNow(parsed.data.account_id);
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      try {
        const result = await opts.coreClient.scraperAction(
          "x-bookmarks",
          "share-now",
          {
            accountId: parsed.data.account_id,
          },
        );
        return c.json({ success: true, data: result.data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Bookmark share request failed";
        log.error("Bookmark share-now failed", { error: msg });
        return c.json({ success: false, error: msg }, 502);
      }
    }
    return c.json(
      { success: false, error: "Bookmark processor not available" },
      503,
    );
  });

  return app;
}
