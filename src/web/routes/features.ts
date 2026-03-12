import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { getOverride, setOverride } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";
import { DEFAULT_CHUNK_PROFILES } from "../../memory/chunk-profiles";
import type { MemorySourceKind } from "../../memory/types";
import { AVAILABLE_SCRAPERS } from "../../sources/available";
import { embeddingsConfigSchema } from "../../config/schema";

const log = createLogger("web-features");

const NAMESPACE = "features";
const SCRAPER_CONFIG_NAMESPACE = "scraper-config";
const CHUNK_PROFILES_NAMESPACE = "chunk-profiles";

const chunkProfileOverrideSchema = z.object({
  maxTokens: z.number().int().min(50).max(2000).optional(),
  overlap: z.number().int().min(0).max(1000).optional(),
  contentMaxChars: z.number().int().min(100).max(20000).optional(),
  commentMaxChars: z.number().int().min(50).max(5000).optional(),
}).refine(
  (d) => d.overlap === undefined || d.maxTokens === undefined || d.overlap <= Math.floor(d.maxTokens / 2),
  { message: "overlap must be at most half of maxTokens" },
);

const updateScrapersSchema = z.object({
  enabled: z.array(z.string()),
});

const hackernewsConfigSchema = z.object({
  intervalMinutes: z.number().int().min(1).max(1440).default(10),
  maxStories: z.number().int().min(10).max(200).default(60),
  commentLimit: z.number().int().min(0).max(10).default(3),
});

const githubSearchConfigSchema = z.object({
  intervalMinutes: z.number().int().min(1).max(1440).default(360),
  minStars: z.number().int().min(1).max(100000).default(500),
  pushedWithinDays: z.number().int().min(1).max(90).default(7),
  maxPages: z.number().int().min(1).max(10).default(4),
});

const intervalOnlySchema = (defaultMinutes: number) =>
  z.object({
    intervalMinutes: z.number().int().min(1).max(1440).default(defaultMinutes),
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SCRAPER_SCHEMAS: Readonly<Record<string, z.ZodObject<any>>> = {
  hackernews: hackernewsConfigSchema,
  "github-search": githubSearchConfigSchema,
  github: intervalOnlySchema(720),
  reddit: intervalOnlySchema(30),
  producthunt: intervalOnlySchema(10),
  appstore: intervalOnlySchema(60),
  playstore: intervalOnlySchema(60),
  cryptopanic: intervalOnlySchema(15),
  cointelegraph: intervalOnlySchema(30),
  reuters: intervalOnlySchema(60),
  investing_news: intervalOnlySchema(60),
  investing_calendar: intervalOnlySchema(120),
};

const updateBooleanSchema = z.object({
  enabled: z.boolean(),
});

export function createFeaturesRoutes(): Hono {
  const app = new Hono();

  app.get("/features", async (c) => {
    try {
      const config = await loadConfigWithOverrides();

      const enabledScrapers = (await getOverride(
        NAMESPACE,
        "enabledScrapers",
      )) as string[] | null;

      const qdrantOverride = await getOverride(NAMESPACE, "qdrantEnabled");
      const marketOverride = await getOverride(NAMESPACE, "marketEnabled");

      // Determine scraper enabled list: prefer DB override, fall back to config
      const scraperEnabled: string[] =
        enabledScrapers !== null
          ? enabledScrapers
          : (config.processes.scraperProcesses.scraperIds ?? []);

      // Determine qdrant enabled: prefer DB override, fall back to whether memorySearch is configured
      const qdrantEnabled: boolean =
        qdrantOverride !== null
          ? Boolean(qdrantOverride)
          : config.memorySearch !== undefined;

      // Determine market enabled: prefer DB override, fall back to whether market is configured
      const marketEnabled: boolean =
        marketOverride !== null
          ? Boolean(marketOverride)
          : config.market !== undefined;

      // Embeddings config: prefer DB override, fall back to file config defaults
      const embeddingsOverride = await getOverride(NAMESPACE, "embeddings");
      const embeddingsConfig = embeddingsConfigSchema.parse(
        embeddingsOverride ?? config.embeddings ?? {},
      );

      return c.json({
        success: true,
        data: {
          scrapers: {
            available: AVAILABLE_SCRAPERS,
            enabled: scraperEnabled,
          },
          qdrant: { enabled: qdrantEnabled },
          market: { enabled: marketEnabled },
          embeddings: embeddingsConfig,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load features state", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/features/scrapers", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = updateScrapersSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(NAMESPACE, "enabledScrapers", parsed.data.enabled);
      log.info("Updated enabled scrapers", { enabled: parsed.data.enabled });
      return c.json({ success: true, data: { enabled: parsed.data.enabled } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to update enabled scrapers", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/features/qdrant", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = updateBooleanSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(NAMESPACE, "qdrantEnabled", parsed.data.enabled);
      log.info("Updated Qdrant enabled state", { enabled: parsed.data.enabled });
      return c.json({ success: true, data: { enabled: parsed.data.enabled } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to update Qdrant enabled state", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/features/market", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = updateBooleanSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(NAMESPACE, "marketEnabled", parsed.data.enabled);
      log.info("Updated market enabled state", { enabled: parsed.data.enabled });
      return c.json({ success: true, data: { enabled: parsed.data.enabled } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to update market enabled state", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.get("/features/scraper-config/:scraperId", async (c) => {
    const scraperId = c.req.param("scraperId");
    const schema = SCRAPER_SCHEMAS[scraperId];
    if (!schema) {
      return c.json({ success: false, error: `No config schema for scraper: ${scraperId}` }, 404);
    }
    try {
      const raw = await getOverride(SCRAPER_CONFIG_NAMESPACE, scraperId);
      const config = schema.parse(raw ?? {});
      return c.json({ success: true, data: config });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load scraper config", { scraperId, err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/features/scraper-config/:scraperId", async (c) => {
    const scraperId = c.req.param("scraperId");
    const schema = SCRAPER_SCHEMAS[scraperId];
    if (!schema) {
      return c.json({ success: false, error: `No config schema for scraper: ${scraperId}` }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(SCRAPER_CONFIG_NAMESPACE, scraperId, parsed.data);
      log.info("Updated scraper config", { scraperId, config: parsed.data });
      return c.json({ success: true, data: parsed.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save scraper config", { scraperId, err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.get("/features/embeddings", async (c) => {
    try {
      const override = await getOverride(NAMESPACE, "embeddings");
      const config = await loadConfigWithOverrides();
      const embeddingsConfig = embeddingsConfigSchema.parse(
        override ?? config.embeddings ?? {},
      );
      return c.json({ success: true, data: embeddingsConfig });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load embeddings config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/features/embeddings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = embeddingsConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(NAMESPACE, "embeddings", parsed.data);
      log.info("Updated embeddings config", { config: parsed.data });
      return c.json({ success: true, data: parsed.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save embeddings config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.get("/features/chunk-profiles/:kind", async (c) => {
    const kind = c.req.param("kind") as MemorySourceKind;
    if (!DEFAULT_CHUNK_PROFILES[kind]) {
      return c.json({ success: false, error: `Unknown chunk profile kind: ${kind}` }, 404);
    }
    try {
      const base = DEFAULT_CHUNK_PROFILES[kind];
      const dbOverride = await getOverride(CHUNK_PROFILES_NAMESPACE, kind);
      const merged = dbOverride && typeof dbOverride === "object"
        ? { ...base, ...(dbOverride as object) }
        : base;
      return c.json({ success: true, data: merged });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load chunk profile", { kind, err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  app.put("/features/chunk-profiles/:kind", async (c) => {
    const kind = c.req.param("kind") as MemorySourceKind;
    if (!DEFAULT_CHUNK_PROFILES[kind]) {
      return c.json({ success: false, error: `Unknown chunk profile kind: ${kind}` }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = chunkProfileOverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(CHUNK_PROFILES_NAMESPACE, kind, parsed.data);
      log.info("Updated chunk profile override", { kind, override: parsed.data });
      const merged = { ...DEFAULT_CHUNK_PROFILES[kind], ...parsed.data };
      return c.json({ success: true, data: merged });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save chunk profile override", { kind, err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
