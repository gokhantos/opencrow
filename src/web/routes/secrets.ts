import { Hono } from "hono";
import { z } from "zod";
import {
  getOverride,
  setOverride,
  deleteOverride,
} from "../../store/config-overrides";
import { createLogger } from "../../logger";

const log = createLogger("web-secrets");

const MANAGED_KEYS = [
  // --- existing ---
  "OPENCROW_WEB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_BASE_URL",
  "VOYAGE_API_KEY",
  "ALIBABA_API_KEY",
  "ALIBABA_BASE_URL",
  "QDRANT_URL",
  "PH_API_TOKEN",
  "PH_API_SECRET",
  // --- added for config-as-data: every credential the app reads should be
  // manageable from the Secrets UI so nothing has to live only in .env ---
  "CLAUDE_CODE_OAUTH_TOKEN",
  "MEM0_LLM_API_KEY",
  "OPENCODE_API_KEY",
  "NEO4J_PASSWORD",
  "GITHUB_TOKEN",
  "BRAVE_API_KEY",
  "FIRECRAWL_API_KEY",
  "QDRANT_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENCROW_INTERNAL_TOKEN",
  "OPENCROW_INTERNAL_LLM_MODEL",
  "OPENCROW_INTERNAL_LLM_PROVIDER",
] as const;

type ManagedKey = (typeof MANAGED_KEYS)[number];

const setSecretSchema = z.object({
  value: z.string().min(1, "value must not be empty"),
});

function maskValue(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

async function resolveSecretStatus(
  key: ManagedKey,
): Promise<{ key: string; set: boolean; source: "db" | "env" | null; masked: string | null }> {
  let dbValue: unknown = null;
  try {
    dbValue = await getOverride("secrets", key);
  } catch {
    // DB not available — treat as not set in DB
  }

  if (typeof dbValue === "string" && dbValue !== "") {
    return { key, set: true, source: "db", masked: maskValue(dbValue) };
  }

  const envValue = process.env[key];
  if (envValue && envValue !== "") {
    return { key, set: true, source: "env", masked: maskValue(envValue) };
  }

  return { key, set: false, source: null, masked: null };
}

export function createSecretsRoutes(): Hono {
  const app = new Hono();

  // GET /api/secrets — list all managed keys with masked values
  app.get("/secrets", async (c) => {
    try {
      const statuses = await Promise.all(
        MANAGED_KEYS.map((key) => resolveSecretStatus(key)),
      );
      return c.json({ success: true, data: statuses });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list secrets";
      log.error("Failed to list secrets", { err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  // PUT /api/secrets/:key — store a secret in DB
  app.put("/secrets/:key", async (c) => {
    const key = c.req.param("key") as ManagedKey;
    if (!(MANAGED_KEYS as readonly string[]).includes(key)) {
      return c.json({ success: false, error: `Unknown secret key: ${key}` }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = setSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    try {
      await setOverride("secrets", key, parsed.data.value);
      // Audit log: record WHO/WHAT for every secret write. These routes can
      // overwrite OPENCROW_WEB_TOKEN / API keys (a privilege-escalation
      // primitive), so every mutation must leave a trail. Never log the value.
      log.warn("AUDIT secret write", {
        action: "set",
        key,
        ip:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          "unknown",
        userAgent: c.req.header("user-agent") ?? "unknown",
      });
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to store secret";
      log.error("Failed to store secret", { err, key });
      return c.json({ success: false, error: message }, 500);
    }
  });

  // DELETE /api/secrets/:key — remove DB-stored secret (falls back to env)
  app.delete("/secrets/:key", async (c) => {
    const key = c.req.param("key") as ManagedKey;
    if (!(MANAGED_KEYS as readonly string[]).includes(key)) {
      return c.json({ success: false, error: `Unknown secret key: ${key}` }, 400);
    }

    try {
      await deleteOverride("secrets", key);
      // Audit log: deleting a DB secret falls back to env and can change the
      // effective auth token, so every delete must be recorded.
      log.warn("AUDIT secret delete", {
        action: "delete",
        key,
        ip:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          "unknown",
        userAgent: c.req.header("user-agent") ?? "unknown",
      });
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete secret";
      log.error("Failed to delete secret", { err, key });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
