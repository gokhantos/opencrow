// API surface for the newborn-velocity time-series (`app-velocity-store.ts`):
// lists the newborn apps currently accelerating hardest. Mounted under
// `/api` in `app.ts`, so it inherits the same bearer-auth gate as every
// other `/api/*` route — no auth logic here, mirroring
// `appstore-signature-hits.ts`.

import { Hono } from "hono";
import { z } from "zod";
import { getTopAcceleratingNewborns } from "../../sources/appstore/app-velocity-store";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function createAppStoreVelocityRoutes(): Hono {
  const app = new Hono();

  app.get("/appstore/velocity/accelerating", async (c) => {
    const parsed = listQuerySchema.safeParse({
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { limit } = parsed.data;
    const newborns = await getTopAcceleratingNewborns({ limit });
    return c.json({ success: true, data: newborns, meta: { count: newborns.length, limit } });
  });

  return app;
}
