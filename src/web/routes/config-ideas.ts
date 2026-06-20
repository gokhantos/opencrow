import { Hono } from "hono";
import { loadConfigWithOverrides } from "../../config/loader";
import { createLogger } from "../../logger";
import { getOverride, setOverride } from "../../store/config-overrides";
import {
  buildIdeasConfigResponse,
  IDEAS_OVERRIDE_SECTIONS,
  type IdeasOverrideSection,
} from "./config-ideas-schema";

const log = createLogger("web-config-ideas");

/**
 * Ideas/funnel config-as-data route. Owns four config_overrides keys:
 *   config/smart.outcomeMemory    -> pipelines.ideas.smart.outcomeMemory
 *   config/smart.incumbentExclusion -> pipelines.ideas.smart.incumbentExclusion
 *   config/smart.diversityGuard   -> pipelines.ideas.smart.diversityGuard
 *   config/competability          -> pipelines.ideas.smart.competability
 *
 * GET returns the CURRENT EFFECTIVE values (the same merged config the app
 * runs on, DB > env > default) plus the raw DB-override JSON per section so the
 * UI can show "overridden" state.
 *
 * PUT validates a PARTIAL body with zod (rejecting unknown/invalid keys) and
 * persists it via setOverride. Each section is its own key so two Settings
 * forms can never clobber each other.
 *
 * Auth is applied at mount (app.ts) — do NOT re-add it here.
 */
export function createConfigIdeasRoutes(): Hono {
  const app = new Hono();

  app.get("/ideas", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const overrides: Record<string, unknown> = {};
      for (const section of IDEAS_OVERRIDE_SECTIONS) {
        overrides[section.id] = await getOverride(section.namespace, section.key);
      }
      const data = buildIdeasConfigResponse(config, overrides);
      return c.json({ success: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load ideas config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/ideas/:section", async (c) => {
    const sectionId = c.req.param("section");
    const section = IDEAS_OVERRIDE_SECTIONS.find((s) => s.id === sectionId) as
      | IdeasOverrideSection
      | undefined;
    if (!section) {
      return c.json({ success: false, error: `Unknown ideas config section: ${sectionId}` }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = section.schema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(section.namespace, section.key, parsed.data);
      log.info("Updated ideas config section", {
        section: section.id,
        namespace: section.namespace,
        key: section.key,
      });
      return c.json({ success: true, data: parsed.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save ideas config section", { section: section.id, err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
