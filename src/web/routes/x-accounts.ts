import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import { verifyXAccount } from "./verify-accounts";

const log = createLogger("x-accounts");

const accountCreateSchema = z.object({
  label: z.string().min(1).max(100),
  auth_token: z.string().min(20),
  ct0: z.string().min(20),
});

const accountUpdateSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  auth_token: z.string().min(20).optional(),
  ct0: z.string().min(20).optional(),
});

const timelineCapSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string().max(100).optional().default("0 */2 * * *"),
  target_users: z.array(z.string().max(100)).optional().default([]),
  max_pages: z.number().int().min(1).max(10).optional().default(3),
});

const postingCapSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string().max(100).nullable().optional().default(null),
  auto_reply: z.boolean().optional().default(false),
  reply_keywords: z.array(z.string().max(200)).optional().default([]),
});

const interactionsCapSchema = z.object({
  enabled: z.boolean(),
  auto_like: z.boolean().optional().default(false),
  auto_retweet: z.boolean().optional().default(false),
  auto_follow_back: z.boolean().optional().default(false),
  daily_like_limit: z.number().int().min(0).max(500).optional().default(50),
  daily_retweet_limit: z.number().int().min(0).max(200).optional().default(20),
});

const notificationsCapSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string().max(100).optional().default("*/30 * * * *"),
  type: z.enum(["all", "mentions"]).optional().default("all"),
  max_pages: z.number().int().min(1).max(10).optional().default(2),
});

const capabilitiesSchema = z.object({
  timeline: timelineCapSchema.optional(),
  posting: postingCapSchema.optional(),
  interactions: interactionsCapSchema.optional(),
  notifications: notificationsCapSchema.optional(),
});

type XAccountStatus = "unverified" | "active" | "expired" | "error";

interface XAccountRow {
  id: string;
  label: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  auth_token: string;
  ct0: string;
  status: XAccountStatus;
  verified_at: number | null;
  error_message: string | null;
  capabilities_json: string;
  created_at: number;
  updated_at: number;
}

function redactSecret(value: string): string {
  if (value.length <= 6) return "******";
  return "***" + value.slice(-6);
}

function parseCapabilities(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function redactAccount(row: XAccountRow) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    display_name: row.display_name,
    profile_image_url: row.profile_image_url,
    auth_token: redactSecret(row.auth_token),
    ct0: redactSecret(row.ct0),
    status: row.status,
    verified_at: row.verified_at,
    error_message: row.error_message,
    capabilities: parseCapabilities(row.capabilities_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createXAccountRoutes(): Hono {
  const app = new Hono();

  app.get("/accounts", async (c) => {
    const db = getDb();
    const rows = (await db`
      SELECT * FROM x_accounts ORDER BY created_at DESC
    `) as XAccountRow[];
    return c.json({ success: true, data: rows.map(redactAccount) });
  });

  app.get("/accounts/:id", async (c) => {
    const db = getDb();
    const id = c.req.param("id");
    const rows = (await db`
      SELECT * FROM x_accounts WHERE id = ${id}
    `) as XAccountRow[];
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

    const { label, auth_token, ct0 } = parsed.data;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();

    await db`
      INSERT INTO x_accounts (id, label, auth_token, ct0, created_at, updated_at)
      VALUES (${id}, ${label}, ${auth_token}, ${ct0}, ${now}, ${now})
    `;

    const rows =
      (await db`SELECT * FROM x_accounts WHERE id = ${id}`) as XAccountRow[];
    log.info("X account created", { id, label });
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
    const existing = (await db`SELECT id FROM x_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const updates = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const cookiesChanged =
      updates.auth_token !== undefined || updates.ct0 !== undefined;

    if (cookiesChanged) {
      await db`
        UPDATE x_accounts SET
          label = COALESCE(${updates.label ?? null}, label),
          auth_token = COALESCE(${updates.auth_token ?? null}, auth_token),
          ct0 = COALESCE(${updates.ct0 ?? null}, ct0),
          status = 'unverified',
          error_message = NULL,
          updated_at = ${now}
        WHERE id = ${id}
      `;
    } else {
      await db`
        UPDATE x_accounts SET
          label = COALESCE(${updates.label ?? null}, label),
          updated_at = ${now}
        WHERE id = ${id}
      `;
    }

    const rows =
      (await db`SELECT * FROM x_accounts WHERE id = ${id}`) as XAccountRow[];
    log.info("X account updated", { id });
    return c.json({ success: true, data: redactAccount(rows[0]!) });
  });

  app.delete("/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const existing = (await db`SELECT id FROM x_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    await db`DELETE FROM x_accounts WHERE id = ${id}`;
    log.info("X account deleted", { id });
    return c.json({ success: true, message: "Account deleted" });
  });

  app.put("/accounts/:id/capabilities", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = capabilitiesSchema.safeParse(body);
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
    const existing = (await db`SELECT id FROM x_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const now = Math.floor(Date.now() / 1000);
    const capJson = JSON.stringify(parsed.data);

    await db`
      UPDATE x_accounts SET
        capabilities_json = ${capJson},
        updated_at = ${now}
      WHERE id = ${id}
    `;

    const rows =
      (await db`SELECT * FROM x_accounts WHERE id = ${id}`) as XAccountRow[];
    log.info("X account capabilities updated", { id });
    return c.json({ success: true, data: redactAccount(rows[0]!) });
  });

  app.post("/accounts/:id/verify", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const rows =
      (await db`SELECT * FROM x_accounts WHERE id = ${id}`) as XAccountRow[];
    if (rows.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const account = rows[0]!;
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = await verifyXAccount(account.auth_token, account.ct0);

      log.info("X account verify result", { id, ok: result.ok });

      if (result.ok) {
        await db`
          UPDATE x_accounts SET
            username = ${result.username ?? null},
            display_name = ${result.display_name ?? null},
            profile_image_url = ${result.profile_image_url ?? null},
            status = 'active',
            verified_at = ${now},
            error_message = NULL,
            updated_at = ${now}
          WHERE id = ${id}
        `;
        log.info("X account verified", { id, username: result.username });
      } else {
        const errorMsg = result.error ?? "Unknown verification error";
        const status: XAccountStatus = errorMsg.includes("expired")
          ? "expired"
          : "error";
        await db`
          UPDATE x_accounts SET
            status = ${status},
            error_message = ${errorMsg},
            updated_at = ${now}
          WHERE id = ${id}
        `;
        log.warn("X account verification failed", { id, error: errorMsg });
      }

      const updated =
        (await db`SELECT * FROM x_accounts WHERE id = ${id}`) as XAccountRow[];
      return c.json({ success: true, data: redactAccount(updated[0]!) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verification failed";
      log.error("X account verify error", { id, error: msg });

      await db`
        UPDATE x_accounts SET
          status = 'error',
          error_message = ${msg},
          updated_at = ${now}
        WHERE id = ${id}
      `;
      const updated =
        (await db`SELECT * FROM x_accounts WHERE id = ${id}`) as XAccountRow[];
      return c.json({ success: true, data: redactAccount(updated[0]!) });
    }
  });

  return app;
}
