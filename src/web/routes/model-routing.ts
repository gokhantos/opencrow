/**
 * API routes for per-process model-routing configuration.
 *
 * GET  /model-routing          — list all 8 process routes
 * PUT  /model-routing/:key     — update a single process route
 */

import { Hono } from "hono";
import { createLogger } from "../../logger";
import {
  getAllModelRoutes,
  setModelRoute,
  isModelRoutingKey,
  modelRouteSchema,
} from "../../store/model-routing";

const log = createLogger("routes:model-routing");

export function createModelRoutingRoutes(): Hono {
  const app = new Hono();

  app.get("/model-routing", async (c) => {
    const all = await getAllModelRoutes();
    const routes = Object.entries(all).map(([key, route]) => ({ key, ...route }));
    return c.json({ routes });
  });

  app.put("/model-routing/:key", async (c) => {
    const key = c.req.param("key");
    if (!isModelRoutingKey(key)) {
      return c.json({ error: `unknown model-routing key: ${key}` }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const parsed = modelRouteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid route", details: parsed.error.flatten() }, 400);
    }

    await setModelRoute(key, parsed.data);
    log.info("Model route updated", { key, provider: parsed.data.provider, model: parsed.data.model });
    return c.json({ key, ...parsed.data });
  });

  return app;
}
