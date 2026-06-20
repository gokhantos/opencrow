/**
 * Signals config route (config/smart.signal).
 *
 * Exposes the three flat "signal" smart fields as a single UI-grouped domain:
 *   - facets           -> smart.signalFacets          (boolean)
 *   - ranking          -> smart.signalRanking         (boolean)
 *   - importanceFloor  -> smart.signalImportanceFloor (low|medium|high)
 *
 * These are read at process boot (cron/pipeline), so every field is
 * RESTART-REQUIRED — a saved change only takes effect after the relevant
 * process restarts.
 *
 * Persistence: the PUT body is a PARTIAL object stored verbatim under
 * config_overrides(namespace='config', key='smart.signal'). The config loader
 * (mergeSmartSignalOverride) field-maps {facets,ranking,importanceFloor} onto
 * the flat smart fields and deep-merges over env/defaults (DB > env > default).
 *
 * Auth is applied at mount (see app.ts) — not re-added here, matching features.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { getOverride, setOverride } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";

const log = createLogger("web-config-signals");

const NAMESPACE = "config";
const KEY = "smart.signal";

/** Importance buckets exposed by this domain (a subset of the schema enum). */
export const IMPORTANCE_FLOORS = ["low", "medium", "high"] as const;
export type ImportanceFloor = (typeof IMPORTANCE_FLOORS)[number];

/**
 * PUT body schema. All fields optional (partial override) but unknown/invalid
 * keys are rejected (strict). At least one field must be present.
 */
export const signalsUpdateSchema = z
  .object({
    facets: z.boolean().optional(),
    ranking: z.boolean().optional(),
    importanceFloor: z.enum(IMPORTANCE_FLOORS).optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.facets !== undefined ||
      d.ranking !== undefined ||
      d.importanceFloor !== undefined,
    { message: "At least one of facets, ranking, importanceFloor is required" },
  );

export type SignalsUpdate = z.infer<typeof signalsUpdateSchema>;

export interface SignalsEffective {
  readonly facets: boolean;
  readonly ranking: boolean;
  readonly importanceFloor: ImportanceFloor;
}

export interface SignalsState {
  readonly effective: SignalsEffective;
  /** Whether a DB override row currently exists for this domain. */
  readonly hasOverride: boolean;
  /** Fields that only take effect after a process restart. */
  readonly restartRequired: readonly (keyof SignalsEffective)[];
}

/**
 * Coerce the schema's wider importance enum (noise|low|medium|high) down to the
 * domain's exposed buckets. `noise` (which this domain does not surface) clamps
 * up to the nearest exposed bucket `low`, so the GET never returns a value the
 * PUT schema would reject.
 */
export function normalizeImportanceFloor(raw: unknown): ImportanceFloor {
  return raw === "medium" || raw === "high" ? raw : "low";
}

/**
 * Build the effective signals view from the already-merged app config. Pure so
 * it can be unit-tested without a DB. Reads the flat smart fields the loader
 * populates from env + the config/smart.signal override.
 */
export function buildSignalsEffective(smart: {
  readonly signalFacets?: unknown;
  readonly signalRanking?: unknown;
  readonly signalImportanceFloor?: unknown;
}): SignalsEffective {
  return {
    facets: smart.signalFacets === true,
    ranking: smart.signalRanking === true,
    importanceFloor: normalizeImportanceFloor(smart.signalImportanceFloor),
  };
}

const RESTART_REQUIRED: readonly (keyof SignalsEffective)[] = [
  "facets",
  "ranking",
  "importanceFloor",
];

export function createConfigSignalsRoutes(): Hono {
  const app = new Hono();

  app.get("/signals", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const override = await getOverride(NAMESPACE, KEY);
      const smart = config.pipelines.ideas.smart;
      const state: SignalsState = {
        effective: buildSignalsEffective(smart),
        hasOverride: override !== null,
        restartRequired: RESTART_REQUIRED,
      };
      return c.json({ success: true, data: state });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load signals config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/signals", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = signalsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      // Merge over any existing partial so unspecified fields are preserved.
      const existing = (await getOverride(NAMESPACE, KEY)) as
        | Partial<SignalsUpdate>
        | null;
      const next: SignalsUpdate = { ...(existing ?? {}), ...parsed.data };
      await setOverride(NAMESPACE, KEY, next);
      log.info("Updated signals config", { override: next });
      return c.json({ success: true, data: next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save signals config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
