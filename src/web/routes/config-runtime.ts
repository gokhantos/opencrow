import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { getOverride, setOverride } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";

const log = createLogger("web-config-runtime");

const NAMESPACE = "config";
const SERVER_KEY = "server";
const SANDBOX_KEY = "sandbox";

/**
 * `config/server` — partial overrides for the runtime server surface. These are
 * FIELD-MAPPED (not verbatim): the JSON keys here are the scheme's names
 * (`webHost`/`webPort`/`logLevel`/`browserEnabled`), and the loader maps each
 * onto the existing schema fields the matching `OPENCROW_WEB_HOST` / `WEB_PORT`
 * / `LOG_LEVEL` / `OPENCROW_BROWSER_ENABLED` env vars already populate. Every
 * field is optional so a PUT can patch a single value without clobbering the
 * rest of the subtree.
 */
const serverOverrideSchema = z
  .object({
    webHost: z.string().min(1).max(253),
    webPort: z.number().int().min(1).max(65535),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    browserEnabled: z.boolean(),
  })
  .partial()
  .strict();

/**
 * `config/sandbox` — partial overrides for the OS tool-sandbox surface.
 * SECURITY-SENSITIVE: `devToolsAllowNetwork` and `allowUnsandboxedDevTools`
 * loosen the boundary that contains attacker-controllable, workspace-authored
 * code (see toolsConfigSchema docs). Field-mapped onto `tools.sandbox`,
 * `tools.devToolsAllowNetwork`, `tools.allowUnsandboxedDevTools`.
 */
const sandboxOverrideSchema = z
  .object({
    toolsSandbox: z.enum(["off", "best-effort", "required"]),
    devToolsAllowNetwork: z.boolean(),
    allowUnsandboxedDevTools: z.boolean(),
  })
  .partial()
  .strict();

export type ServerOverride = z.infer<typeof serverOverrideSchema>;
export type SandboxOverride = z.infer<typeof sandboxOverrideSchema>;

/**
 * Effective `config/server` values, read from the same merged config the app
 * uses. Returned with the scheme's key names so the UI round-trips cleanly.
 */
export function effectiveServer(
  config: Awaited<ReturnType<typeof loadConfigWithOverrides>>,
): Required<ServerOverride> {
  return {
    webHost: config.web.host,
    webPort: config.web.port,
    logLevel: config.logLevel,
    browserEnabled: config.browser.enabled,
  };
}

/**
 * Effective `config/sandbox` values, read from the merged config.
 */
export function effectiveSandbox(
  config: Awaited<ReturnType<typeof loadConfigWithOverrides>>,
): Required<SandboxOverride> {
  return {
    toolsSandbox: config.tools.sandbox,
    devToolsAllowNetwork: config.tools.devToolsAllowNetwork,
    allowUnsandboxedDevTools: config.tools.allowUnsandboxedDevTools,
  };
}

/** Whether a DB override row exists for the given subtree key. */
function isDbSourced(override: unknown): boolean {
  return override !== null && override !== undefined;
}

export function createConfigRuntimeRoutes(): Hono {
  const app = new Hono();

  app.get("/server", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const override = await getOverride(NAMESPACE, SERVER_KEY);
      return c.json({
        success: true,
        data: {
          ...effectiveServer(config),
          source: isDbSourced(override) ? "db" : "env-or-default",
          restartRequired: ["webHost", "webPort", "logLevel", "browserEnabled"],
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load server runtime config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/server", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = serverOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      // Merge the patch onto the existing override row so a single-field PUT
      // does not drop previously-saved fields.
      const existing = (await getOverride(NAMESPACE, SERVER_KEY)) as
        | ServerOverride
        | null;
      const next: ServerOverride = { ...(existing ?? {}), ...parsed.data };
      await setOverride(NAMESPACE, SERVER_KEY, next);
      log.info("Updated server runtime config", { override: next });
      return c.json({ success: true, data: next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save server runtime config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.get("/sandbox", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const override = await getOverride(NAMESPACE, SANDBOX_KEY);
      return c.json({
        success: true,
        data: {
          ...effectiveSandbox(config),
          source: isDbSourced(override) ? "db" : "env-or-default",
          restartRequired: [
            "toolsSandbox",
            "devToolsAllowNetwork",
            "allowUnsandboxedDevTools",
          ],
          dangerous: ["devToolsAllowNetwork", "allowUnsandboxedDevTools"],
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load sandbox runtime config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/sandbox", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = sandboxOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      const existing = (await getOverride(NAMESPACE, SANDBOX_KEY)) as
        | SandboxOverride
        | null;
      const next: SandboxOverride = { ...(existing ?? {}), ...parsed.data };
      await setOverride(NAMESPACE, SANDBOX_KEY, next);
      log.info("Updated sandbox runtime config", { override: next });
      return c.json({ success: true, data: next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save sandbox runtime config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
