import { Hono } from "hono";
import { z } from "zod";
import {
  buildToolCatalog,
  CATEGORY_LABELS,
  applyFeatureFilter,
  type EnabledFeatures,
} from "../../tools/catalog";
import { getOverride, setOverride } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";

const NAMESPACE = "tools";

async function getEnabledFeatures(): Promise<EnabledFeatures> {
  const [config, enabledScrapersOverride, qdrantOverride, marketOverride, disabledToolsOverride] =
    await Promise.all([
      loadConfigWithOverrides(),
      getOverride("features", "enabledScrapers"),
      getOverride("features", "qdrantEnabled"),
      getOverride("features", "marketEnabled"),
      getOverride(NAMESPACE, "disabledTools"),
    ]);

  const enabledScrapers: readonly string[] =
    enabledScrapersOverride !== null
      ? (enabledScrapersOverride as string[])
      : (config.processes.scraperProcesses.scraperIds ?? []);

  const qdrantEnabled: boolean =
    qdrantOverride !== null
      ? Boolean(qdrantOverride)
      : config.memorySearch !== undefined;

  const marketEnabled: boolean =
    marketOverride !== null
      ? Boolean(marketOverride)
      : config.market !== undefined;

  const disabledTools: readonly string[] =
    disabledToolsOverride !== null
      ? (disabledToolsOverride as string[])
      : [];

  return { enabledScrapers, qdrantEnabled, marketEnabled, disabledTools };
}

const updateDisabledSchema = z.object({
  disabled: z.array(z.string()),
});

export function createToolsRoutes(): Hono {
  const app = new Hono();

  app.get("/tools", async (c) => {
    const catalog = buildToolCatalog();
    const features = await getEnabledFeatures();
    const filtered = applyFeatureFilter(catalog, features);
    return c.json({
      success: true,
      data: filtered,
      categories: CATEGORY_LABELS,
    });
  });

  app.put("/tools/disabled", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = updateDisabledSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400,
      );
    }

    try {
      await setOverride(NAMESPACE, "disabledTools", parsed.data.disabled);
      return c.json({ success: true, data: { disabled: parsed.data.disabled } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
