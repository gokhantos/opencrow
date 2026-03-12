import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import { verifyRedditAccount } from "./verify-accounts";

const log = createLogger("reddit-accounts");

const accountCreateSchema = z.object({
  label: z.string().min(1).max(100),
  cookies_json: z.string().min(10),
});

const accountUpdateSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  cookies_json: z.string().min(10).optional(),
});

type RedditAccountStatus = "unverified" | "active" | "expired" | "error";

interface RedditAccountRow {
  id: string;
  label: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  cookies_json: string;
  status: RedditAccountStatus;
  verified_at: number | null;
  error_message: string | null;
  last_scraped_at: number | null;
  last_scrape_count: number | null;
  created_at: number;
  updated_at: number;
}

function countCookies(cookiesJson: string): number {
  try {
    const arr = JSON.parse(cookiesJson || "[]");
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function redactAccount(row: RedditAccountRow) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    cookie_count: countCookies(row.cookies_json),
    status: row.status,
    verified_at: row.verified_at,
    error_message: row.error_message,
    last_scraped_at: row.last_scraped_at,
    last_scrape_count: row.last_scrape_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createRedditAccountRoutes(): Hono {
  const app = new Hono();

  app.get("/accounts", async (c) => {
    const db = getDb();
    const rows = (await db`
      SELECT * FROM reddit_accounts ORDER BY created_at DESC
    `) as RedditAccountRow[];
    return c.json({ success: true, data: rows.map(redactAccount) });
  });

  app.get("/accounts/:id", async (c) => {
    const db = getDb();
    const id = c.req.param("id");
    const rows = (await db`
      SELECT * FROM reddit_accounts WHERE id = ${id}
    `) as RedditAccountRow[];
    if (rows.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }
    return c.json({ success: true, data: redactAccount(rows[0]!) });
  });

  app.post("/accounts", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = accountCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    let cookiesArr: unknown[];
    try {
      cookiesArr = JSON.parse(parsed.data.cookies_json);
      if (!Array.isArray(cookiesArr) || cookiesArr.length === 0) {
        return c.json(
          { success: false, error: "cookies_json must be a non-empty array" },
          400,
        );
      }
    } catch {
      return c.json(
        { success: false, error: "cookies_json is not valid JSON" },
        400,
      );
    }

    const { label, cookies_json } = parsed.data;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();

    await db`
      INSERT INTO reddit_accounts (id, label, cookies_json, created_at, updated_at)
      VALUES (${id}, ${label}, ${cookies_json}, ${now}, ${now})
    `;

    const rows = (await db`SELECT * FROM reddit_accounts WHERE id = ${id}`) as RedditAccountRow[];
    log.info("Reddit account created", { id, label });
    return c.json({ success: true, data: redactAccount(rows[0]!) }, 201);
  });

  app.put("/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = accountUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const db = getDb();
    const existing = (await db`SELECT id FROM reddit_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const updates = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const cookiesChanged = updates.cookies_json !== undefined;

    if (cookiesChanged) {
      await db`
        UPDATE reddit_accounts SET
          label = COALESCE(${updates.label ?? null}, label),
          cookies_json = COALESCE(${updates.cookies_json ?? null}, cookies_json),
          status = 'unverified',
          error_message = NULL,
          updated_at = ${now}
        WHERE id = ${id}
      `;
    } else {
      await db`
        UPDATE reddit_accounts SET
          label = COALESCE(${updates.label ?? null}, label),
          updated_at = ${now}
        WHERE id = ${id}
      `;
    }

    const rows = (await db`SELECT * FROM reddit_accounts WHERE id = ${id}`) as RedditAccountRow[];
    log.info("Reddit account updated", { id });
    return c.json({ success: true, data: redactAccount(rows[0]!) });
  });

  app.delete("/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const existing = (await db`SELECT id FROM reddit_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    await db`DELETE FROM reddit_accounts WHERE id = ${id}`;
    log.info("Reddit account deleted", { id });
    return c.json({ success: true, message: "Account deleted" });
  });

  app.post("/accounts/:id/verify", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const rows = (await db`SELECT * FROM reddit_accounts WHERE id = ${id}`) as RedditAccountRow[];
    if (rows.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const account = rows[0]!;
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = await verifyRedditAccount(account.cookies_json);

      log.info("Reddit account verify result", { id, ok: result.ok });

      if (result.ok) {
        await db`
          UPDATE reddit_accounts SET
            username = ${result.username ?? null},
            display_name = ${result.display_name ?? null},
            avatar_url = ${result.avatar_url ?? null},
            status = 'active',
            verified_at = ${now},
            error_message = NULL,
            updated_at = ${now}
          WHERE id = ${id}
        `;
        log.info("Reddit account verified", { id, username: result.username });
      } else {
        const errorMsg = result.error ?? "Unknown verification error";
        const status: RedditAccountStatus = errorMsg.includes("expired")
          ? "expired"
          : "error";
        await db`
          UPDATE reddit_accounts SET
            status = ${status},
            error_message = ${errorMsg},
            updated_at = ${now}
          WHERE id = ${id}
        `;
        log.warn("Reddit account verification failed", { id, error: errorMsg });
      }

      const updated = (await db`SELECT * FROM reddit_accounts WHERE id = ${id}`) as RedditAccountRow[];
      return c.json({ success: true, data: redactAccount(updated[0]!) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verification failed";
      log.error("Reddit account verify error", { id, error: msg });

      await db`
        UPDATE reddit_accounts SET
          status = 'error',
          error_message = ${msg},
          updated_at = ${now}
        WHERE id = ${id}
      `;
      const updated = (await db`SELECT * FROM reddit_accounts WHERE id = ${id}`) as RedditAccountRow[];
      return c.json({ success: true, data: redactAccount(updated[0]!) });
    }
  });

  return app;
}
