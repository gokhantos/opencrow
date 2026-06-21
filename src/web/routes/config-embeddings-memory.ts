/**
 * Config-as-data route for the Embeddings & Memory domain.
 *
 * Two concerns live here:
 *  - `config/memory` { backend: "qdrant" | "mem0" } — selects the memory storage
 *    backend. Persisted as a partial override that the loader deep-merges onto
 *    `config.memorySearch.backend`. Takes effect after a process restart.
 *  - A guarded embeddings-dimensions change. Embeddings (`features/embeddings`)
 *    already owns its full GET/PUT (see features.ts); we do NOT duplicate it.
 *    But changing `dimensions` requires a full Qdrant re-index — the stored
 *    vectors and the collection dimension must match — so this route exposes a
 *    dimensions-only PUT that REFUSES to apply a change unless the caller passes
 *    explicit `confirmReindex: true`. The UI surfaces a loud confirmation.
 *
 * Auth is applied at mount time by the integration agent (mirrors features.ts);
 * do not re-add auth middleware here.
 *
 * Mount: app.route("/api/config/embeddings-memory", createEmbeddingsMemoryRoutes())
 */
import { Hono } from "hono";
import { loadConfigWithOverrides } from "../../config/loader";
import { embeddingsConfigSchema } from "../../config/schema";
import { createLogger } from "../../logger";
import { getOverride, setOverride } from "../../store/config-overrides";
import {
  dimensionsChangeSchema,
  isDimensionsChange,
  MEMORY_KEY,
  MEMORY_NAMESPACE,
  memoryOverrideSchema,
} from "./config-embeddings-memory-schema";

const log = createLogger("web-config-embeddings-memory");

export function createEmbeddingsMemoryRoutes(): Hono {
  const app = new Hono();

  /**
   * GET — current EFFECTIVE values for this domain, read from the same merged
   * config the app uses, plus the source of the memory backend (DB override vs
   * config default) so the UI can show provenance.
   */
  app.get("/", async (c) => {
    try {
      const config = await loadConfigWithOverrides();
      const memoryOverride = await getOverride(MEMORY_NAMESPACE, MEMORY_KEY);

      const effectiveBackend = config.memorySearch?.backend ?? "qdrant";
      // Embeddings dimensions live behind the `features/embeddings` override
      // (the same key this route's PUT writes, mirroring features.ts). The
      // shared loader does NOT merge that override back into `config.embeddings`,
      // so read it directly here — DB override wins, else fall back to the file
      // config — to keep GET coherent with our own writes.
      const embeddingsOverride = await getOverride("features", "embeddings");
      const embeddings = embeddingsConfigSchema.parse(
        embeddingsOverride ?? config.embeddings ?? {},
      );

      return c.json({
        success: true,
        data: {
          memory: {
            backend: effectiveBackend,
            source: memoryOverride !== null ? "override" : "default",
          },
          // Echo current embeddings dimensions so the guard UI can detect a
          // change against the live value without a second request.
          embeddings: {
            dimensions: embeddings.dimensions,
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load embeddings-memory config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  /**
   * PUT /memory — persist the memory-backend override (partial). The loader
   * deep-merges this onto memorySearch.backend; restart required to take effect.
   */
  app.put("/memory", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = memoryOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(MEMORY_NAMESPACE, MEMORY_KEY, parsed.data);
      log.info("Updated memory backend override", { backend: parsed.data.backend });
      return c.json({ success: true, data: parsed.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save memory backend override", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  /**
   * PUT /embeddings/dimensions — guarded dimensions change. Refuses unless the
   * value actually differs from the current effective value AND the caller
   * confirms the re-index implication. Writes through the SAME override key the
   * embeddings route uses (features/embeddings) so the two stay coherent.
   */
  app.put("/embeddings/dimensions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = dimensionsChangeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      const config = await loadConfigWithOverrides();
      // Effective dimensions = DB override if present, else file config — match
      // the GET path and features.ts so the change-detection guard compares
      // against the value the app actually uses (not a stale file default).
      const embeddingsOverride = await getOverride("features", "embeddings");
      const current = embeddingsConfigSchema.parse(
        embeddingsOverride ?? config.embeddings ?? {},
      );

      if (!isDimensionsChange(current.dimensions, parsed.data.dimensions)) {
        // No-op: nothing to persist, nothing to re-index.
        return c.json({
          success: true,
          data: { dimensions: current.dimensions, changed: false },
        });
      }

      if (!parsed.data.confirmReindex) {
        return c.json(
          {
            success: false,
            error:
              "Changing embeddings dimensions requires a full Qdrant re-index. " +
              "Re-submit with confirmReindex: true to proceed.",
            requiresConfirmation: true,
          },
          409,
        );
      }

      const next = { ...current, dimensions: parsed.data.dimensions };
      await setOverride("features", "embeddings", next);
      log.warn("Changed embeddings dimensions (re-index required)", {
        from: current.dimensions,
        to: parsed.data.dimensions,
      });
      return c.json({
        success: true,
        data: { dimensions: parsed.data.dimensions, changed: true },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to change embeddings dimensions", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
