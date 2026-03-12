import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import { verifyPHAccount } from "./verify-accounts";

const log = createLogger("ph-accounts");

const accountCreateSchema = z.object({
  label: z.string().min(1).max(100),
  cookies_json: z.string().min(10),
});

const accountUpdateSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  cookies_json: z.string().min(10).optional(),
});

const feedCapSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string().max(100).optional().default("0 */4 * * *"),
  max_pages: z.number().int().min(1).max(10).optional().default(3),
  target_topics: z.array(z.string().max(100)).optional().default([]),
  target_products: z.array(z.string().max(200)).optional().default([]),
});

const upvotingCapSchema = z.object({
  enabled: z.boolean(),
  auto_upvote: z.boolean().optional().default(false),
  daily_upvote_limit: z.number().int().min(0).max(200).optional().default(20),
  upvote_keywords: z.array(z.string().max(200)).optional().default([]),
  upvote_topics: z.array(z.string().max(100)).optional().default([]),
});

const commentingCapSchema = z.object({
  enabled: z.boolean(),
  auto_comment: z.boolean().optional().default(false),
  daily_comment_limit: z.number().int().min(0).max(50).optional().default(5),
  comment_keywords: z.array(z.string().max(200)).optional().default([]),
  comment_template: z.string().max(1000).optional().default(""),
});

const capabilitiesSchema = z.object({
  feed: feedCapSchema.optional(),
  upvoting: upvotingCapSchema.optional(),
  commenting: commentingCapSchema.optional(),
});

type PHAccountStatus = "unverified" | "active" | "expired" | "error";

interface PHAccountRow {
  id: string;
  label: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  cookies_json: string;
  session_cookie: string;
  token_cookie: string;
  status: PHAccountStatus;
  verified_at: number | null;
  error_message: string | null;
  capabilities_json: string;
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

function parseCapabilities(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function extractSessionPreview(cookiesJson: string): string {
  try {
    const arr = JSON.parse(cookiesJson || "[]");
    if (!Array.isArray(arr)) return "";
    const session = arr.find(
      (c: { name?: string }) =>
        c.name === "_producthunt_session_production",
    );
    if (!session?.value) return "";
    const val = session.value as string;
    if (val.length <= 8) return "******";
    return "***" + val.slice(-6);
  } catch {
    return "";
  }
}

function redactAccount(row: PHAccountRow) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    cookie_count: countCookies(row.cookies_json),
    session_preview: extractSessionPreview(row.cookies_json),
    status: row.status,
    verified_at: row.verified_at,
    error_message: row.error_message,
    capabilities: parseCapabilities(row.capabilities_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createPHAccountRoutes(): Hono {
  const app = new Hono();

  app.get("/accounts", async (c) => {
    const db = getDb();
    const rows = (await db`
      SELECT * FROM ph_accounts ORDER BY created_at DESC
    `) as PHAccountRow[];
    return c.json({ success: true, data: rows.map(redactAccount) });
  });

  app.get("/accounts/:id", async (c) => {
    const db = getDb();
    const id = c.req.param("id");
    const rows = (await db`
      SELECT * FROM ph_accounts WHERE id = ${id}
    `) as PHAccountRow[];
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

    // Validate the cookies JSON is a valid array
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
      INSERT INTO ph_accounts (id, label, cookies_json, created_at, updated_at)
      VALUES (${id}, ${label}, ${cookies_json}, ${now}, ${now})
    `;

    const rows =
      (await db`SELECT * FROM ph_accounts WHERE id = ${id}`) as PHAccountRow[];
    log.info("PH account created", { id, label });
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
    const existing = (await db`SELECT id FROM ph_accounts WHERE id = ${id}`) as {
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
        UPDATE ph_accounts SET
          label = COALESCE(${updates.label ?? null}, label),
          cookies_json = COALESCE(${updates.cookies_json ?? null}, cookies_json),
          status = 'unverified',
          error_message = NULL,
          updated_at = ${now}
        WHERE id = ${id}
      `;
    } else {
      await db`
        UPDATE ph_accounts SET
          label = COALESCE(${updates.label ?? null}, label),
          updated_at = ${now}
        WHERE id = ${id}
      `;
    }

    const rows =
      (await db`SELECT * FROM ph_accounts WHERE id = ${id}`) as PHAccountRow[];
    log.info("PH account updated", { id });
    return c.json({ success: true, data: redactAccount(rows[0]!) });
  });

  app.delete("/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const existing = (await db`SELECT id FROM ph_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    await db`DELETE FROM ph_accounts WHERE id = ${id}`;
    log.info("PH account deleted", { id });
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
    const existing = (await db`SELECT id FROM ph_accounts WHERE id = ${id}`) as {
      id: string;
    }[];
    if (existing.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const now = Math.floor(Date.now() / 1000);
    const capJson = JSON.stringify(parsed.data);

    await db`
      UPDATE ph_accounts SET
        capabilities_json = ${capJson},
        updated_at = ${now}
      WHERE id = ${id}
    `;

    const rows =
      (await db`SELECT * FROM ph_accounts WHERE id = ${id}`) as PHAccountRow[];
    log.info("PH account capabilities updated", { id });
    return c.json({ success: true, data: redactAccount(rows[0]!) });
  });

  app.post("/accounts/:id/verify", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const rows =
      (await db`SELECT * FROM ph_accounts WHERE id = ${id}`) as PHAccountRow[];
    if (rows.length === 0) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    const account = rows[0]!;
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = await verifyPHAccount(account.cookies_json);

      log.info("PH account verify result", { id, ok: result.ok });

      if (result.ok) {
        await db`
          UPDATE ph_accounts SET
            username = ${result.username ?? null},
            display_name = ${result.display_name ?? null},
            avatar_url = ${result.avatar_url ?? null},
            status = 'active',
            verified_at = ${now},
            error_message = NULL,
            updated_at = ${now}
          WHERE id = ${id}
        `;
        log.info("PH account verified", { id, username: result.username });
      } else {
        const errorMsg = result.error ?? "Unknown verification error";
        const status: PHAccountStatus = errorMsg.includes("expired")
          ? "expired"
          : "error";
        await db`
          UPDATE ph_accounts SET
            status = ${status},
            error_message = ${errorMsg},
            updated_at = ${now}
          WHERE id = ${id}
        `;
        log.warn("PH account verification failed", { id, error: errorMsg });
      }

      const updated =
        (await db`SELECT * FROM ph_accounts WHERE id = ${id}`) as PHAccountRow[];
      return c.json({ success: true, data: redactAccount(updated[0]!) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verification failed";
      log.error("PH account verify error", { id, error: msg });

      await db`
        UPDATE ph_accounts SET
          status = 'error',
          error_message = ${msg},
          updated_at = ${now}
        WHERE id = ${id}
      `;
      const updated =
        (await db`SELECT * FROM ph_accounts WHERE id = ${id}`) as PHAccountRow[];
      return c.json({ success: true, data: redactAccount(updated[0]!) });
    }
  });

  return app;
}
