// API surface for the newborn-velocity screener (`keyword-screener.ts`):
// lists persisted signature hits and lets an operator triage them (dismiss /
// acknowledge). Mounted under `/api` in `app.ts`, so it inherits the same
// bearer-auth gate as every other `/api/*` route — no auth logic here.

import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import {
  getSignatureHits,
  setSignatureHitStatus,
  SIGNATURE_HIT_STATUSES,
  type SignatureHitStatus,
} from "../../sources/appstore/signature-hits-store";

const log = createLogger("appstore-signature-hits-api");

const listQuerySchema = z.object({
  status: z.enum(SIGNATURE_HIT_STATUSES as [SignatureHitStatus, ...SignatureHitStatus[]]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// `'new'` is excluded — it is an insert-time default the screener itself
// sets, never a caller-driven transition (see `setSignatureHitStatus`).
const SETTABLE_STATUSES = ["active", "dismissed"] as const;
const patchBodySchema = z.object({
  status: z.enum(SETTABLE_STATUSES),
});

export function createAppStoreSignatureHitsRoutes(): Hono {
  const app = new Hono();

  app.get("/appstore/signature-hits", async (c) => {
    const parsed = listQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { status, limit } = parsed.data;
    const hits = await getSignatureHits({ status, limit });
    return c.json({ success: true, data: hits, meta: { count: hits.length, limit, status: status ?? null } });
  });

  app.patch("/appstore/signature-hits/:keyword", async (c) => {
    const keyword = c.req.param("keyword");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = patchBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request body";
      return c.json({ success: false, error: message }, 400);
    }

    const updated = await setSignatureHitStatus(keyword, parsed.data.status);
    if (!updated) {
      return c.json({ success: false, error: `Unknown signature hit: ${keyword}` }, 404);
    }

    log.info("Signature hit status updated", { keyword, status: parsed.data.status });
    return c.json({ success: true, data: updated });
  });

  return app;
}
