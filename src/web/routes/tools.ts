import { Hono } from "hono";
import { buildToolCatalog, CATEGORY_LABELS } from "../../tools/catalog";

export interface ToolMeta {
  readonly name: string;
  readonly category: string;
  readonly description: string;
}

export function createToolsRoutes(): Hono {
  const app = new Hono();

  app.get("/tools", (c) => {
    const catalog = buildToolCatalog();
    return c.json({
      success: true,
      data: catalog,
      categories: CATEGORY_LABELS,
    });
  });

  return app;
}
