/**
 * Config-as-data route for the graph-reasoning domain
 * (`config/smart.graphReasoning`).
 *
 * GET  /config/graph  — returns the CURRENT EFFECTIVE values (DB override >
 *   env > schema default, exactly as the app reads them via
 *   loadConfigWithOverrides) under `config.pipelines.ideas.smart.graphReasoning`.
 * PUT  /config/graph  — zod-validates a PARTIAL body (rejecting unknown/invalid
 *   keys) and persists it via setOverride(NAMESPACE, KEY, value). The partial is
 *   deep-merged onto the subtree by src/config/loader.ts; field names here MUST
 *   match the schema (verbatim merge), so the PUT schema mirrors
 *   graphReasoningConfigSchema's field names + bounds.
 *
 * Auth is applied at mount time in src/web/app.ts; do not re-add it here
 * (mirrors src/web/routes/features.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { setOverride } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";

const log = createLogger("web-config-graph");

/** config_overrides row this domain owns. */
export const NAMESPACE = "config";
export const KEY = "smart.graphReasoning";

/**
 * Validation schema for the PUT body. Every field is optional so callers can
 * persist a PARTIAL override; `.strict()` rejects unknown keys (the loader
 * merges keys verbatim, so unknown keys would otherwise silently leak). Bounds
 * mirror `graphReasoningConfigSchema` in src/config/schema.ts.
 */
export const graphReasoningOverrideSchema = z
  .object({
    enabled: z.boolean(),
    maxHops: z.number().int().min(2).max(6),
    maxPaths: z.number().int().min(1).max(20),
    searchLimit: z.number().int().min(1).max(100),
    minDegree: z.number().int().min(1).max(1000),
    maxDegree: z.number().int().min(1).max(5000),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field is required",
  })
  .refine(
    (d) =>
      d.minDegree === undefined ||
      d.maxDegree === undefined ||
      d.minDegree <= d.maxDegree,
    { message: "minDegree must be less than or equal to maxDegree" },
  );

export type GraphReasoningOverride = z.infer<typeof graphReasoningOverrideSchema>;

export function createConfigGraphRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const effective = config.pipelines.ideas.smart.graphReasoning;
      return c.json({
        success: true,
        data: effective,
        restartRequired: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load graph-reasoning config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = graphReasoningOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(NAMESPACE, KEY, parsed.data);
      log.info("Updated graph-reasoning config override", { override: parsed.data });
      // Return the new EFFECTIVE config so the UI reflects the merged result.
      const config = await loadConfigWithOverrides();
      return c.json({
        success: true,
        data: config.pipelines.ideas.smart.graphReasoning,
        restartRequired: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save graph-reasoning config override", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
