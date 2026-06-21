import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { getOverride, setOverride } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";

const log = createLogger("web-config-sige");

// ---------------------------------------------------------------------------
// Namespaces / keys
//
// Both subtrees live in the `config` namespace and are deep-merged onto their
// config subtree by mergeFeatureOverrides in src/config/loader.ts:
//   - config/sige           -> config.sige          (EXISTING merge path)
//   - config/smart.sigeAuto -> config.pipelines.ideas.smart.sigeAuto
//
// IMPORTANT (Foundation contract): the loader passes the stored override JSON's
// keys VERBATIM onto the subtree before the final zod parse, so the PUT bodies
// below MUST use the ACTUAL schema field names (e.g. mem0.baseUrl, neo4j.boltUrl)
// or zod strips unknown keys. These schemas mirror those field names exactly.
// ---------------------------------------------------------------------------
const NAMESPACE = "config";
const SIGE_KEY = "sige";
const SIGE_AUTO_KEY = "smart.sigeAuto";

// --- config/sige core (partial; every field optional so the PUT is a patch) ---
export const sigeCoreOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    mem0: z
      .object({
        baseUrl: z.string().url().optional(),
      })
      .strict()
      .optional(),
    neo4j: z
      .object({
        enabled: z.boolean().optional(),
        boltUrl: z.string().min(1).optional(),
        user: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SigeCoreOverride = z.infer<typeof sigeCoreOverrideSchema>;

// --- config/smart.sigeAuto (autonomous scheduler; partial patch) ---
// MANUAL-ONLY default: `enabled=false` keeps SIGE manual; setting it true turns
// on the self-scheduler. Bounds mirror sigeAutoConfigSchema in schema.ts.
export const sigeAutoOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    cadence: z.enum(["manual", "daily"]).optional(),
    maxDeepFrontiers: z.number().int().min(1).max(8).optional(),
    broadFrontierCap: z.number().int().min(1).max(8).optional(),
    broadPoolSize: z.number().int().min(1).max(200).optional(),
    maxConcurrent: z.number().int().min(1).max(1).optional(),
    memoryWriteback: z.boolean().optional(),
  })
  .strict();

export type SigeAutoOverride = z.infer<typeof sigeAutoOverrideSchema>;

// ---------------------------------------------------------------------------
// Effective-value readers — return the CURRENT EFFECTIVE config the app uses
// (schema defaults <- env <- DB override), plus a coarse `source` hint so the
// UI can show whether a value came from a DB override row.
// ---------------------------------------------------------------------------
function source(hasOverride: boolean): "db" | "config" {
  return hasOverride ? "db" : "config";
}

export function createConfigSigeRoutes(): Hono {
  const app = new Hono();

  app.get("/config/sige", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const coreOverride = (await getOverride(NAMESPACE, SIGE_KEY)) as Record<
        string,
        unknown
      > | null;
      const autoOverride = (await getOverride(
        NAMESPACE,
        SIGE_AUTO_KEY,
      )) as Record<string, unknown> | null;

      // sige is optional in the schema; fall back to safe defaults for display.
      const sige = config.sige;
      const sigeAuto = config.pipelines.ideas.smart.sigeAuto;

      return c.json({
        success: true,
        data: {
          core: {
            enabled: sige?.enabled ?? false,
            mem0: { baseUrl: sige?.mem0.baseUrl ?? "http://127.0.0.1:8050" },
            neo4j: {
              enabled: sige?.neo4j.enabled ?? false,
              boltUrl: sige?.neo4j.boltUrl ?? "bolt://127.0.0.1:7687",
              user: sige?.neo4j.user ?? "neo4j",
            },
            source: source(coreOverride !== null),
          },
          auto: {
            enabled: sigeAuto.enabled,
            cadence: sigeAuto.cadence,
            maxDeepFrontiers: sigeAuto.maxDeepFrontiers,
            broadFrontierCap: sigeAuto.broadFrontierCap,
            broadPoolSize: sigeAuto.broadPoolSize,
            maxConcurrent: sigeAuto.maxConcurrent,
            memoryWriteback: sigeAuto.memoryWriteback,
            source: source(autoOverride !== null),
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load SIGE config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/config/sige/core", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = sigeCoreOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      // Merge onto the existing override row so a partial PUT does not clobber
      // previously-stored sibling fields (e.g. PUT-ing only `enabled` keeps the
      // stored mem0/neo4j patch intact).
      const existing = ((await getOverride(NAMESPACE, SIGE_KEY)) ?? {}) as Record<
        string,
        unknown
      >;
      const merged = mergeSigeCorePatch(existing, parsed.data);
      await setOverride(NAMESPACE, SIGE_KEY, merged);
      log.info("Updated SIGE core config override", { override: merged });
      return c.json({ success: true, data: merged });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save SIGE core config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/config/sige/auto", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = sigeAutoOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      const existing = ((await getOverride(NAMESPACE, SIGE_AUTO_KEY)) ??
        {}) as Record<string, unknown>;
      const merged = { ...existing, ...parsed.data };
      await setOverride(NAMESPACE, SIGE_AUTO_KEY, merged);
      log.info("Updated SIGE autonomous config override", { override: merged });
      return c.json({ success: true, data: merged });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save SIGE autonomous config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}

/**
 * Deep-merge a SIGE-core patch onto a previously-stored override row WITHOUT
 * mutating either input. Only the nested `mem0` / `neo4j` objects need a
 * one-level merge; top-level `enabled` is a flat overwrite. Exported for unit
 * testing of the partial-patch semantics.
 */
export function mergeSigeCorePatch(
  existing: Record<string, unknown>,
  patch: SigeCoreOverride,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };

  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled;
  }
  if (patch.mem0 !== undefined) {
    const prev = (existing.mem0 ?? {}) as Record<string, unknown>;
    next.mem0 = { ...prev, ...patch.mem0 };
  }
  if (patch.neo4j !== undefined) {
    const prev = (existing.neo4j ?? {}) as Record<string, unknown>;
    next.neo4j = { ...prev, ...patch.neo4j };
  }

  return next;
}
