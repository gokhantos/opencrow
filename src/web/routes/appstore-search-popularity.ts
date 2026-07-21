/**
 * Manual-import API for `appstore_search_popularity` (migration 053) — the
 * real write path for ASA "searchPopularity" scores. There is no
 * programmatic sweep for this metric (see `popularity-store.ts`'s module
 * doc): a human runs a Playwright session against the ASA web UI (or reads
 * the campaign dashboard by hand) and POSTs the resulting rows here.
 *
 * Mounted under `/api` in `app.ts`, so it inherits the same bearer-auth gate
 * as every other `/api/*` route — no auth logic here, mirroring
 * `appstore-velocity.ts` / `appstore-signature-hits.ts`.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { upsertPopularity } from "../../sources/appstore/popularity-store";

const log = createLogger("appstore-search-popularity-api");

const MAX_ROWS_PER_IMPORT = 500;

const popularityRowSchema = z.object({
  keyword: z.string().trim().min(1).max(200),
  popularity: z.number().int().min(0).max(5),
  storefront: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "storefront must be a 2-letter ISO country code, e.g. US")
    .default("US"),
  // ISO 8601 timestamp; defaults to "now" (import time) when the caller
  // doesn't know exactly when the reading was taken.
  checked_at: z.string().datetime({ offset: true }).optional(),
});

const importRequestSchema = z.array(popularityRowSchema).min(1).max(MAX_ROWS_PER_IMPORT);

export function createAppStoreSearchPopularityRoutes(): Hono {
  const app = new Hono();

  // POST body: a bare array of rows (not wrapped in an object) — this is a
  // manual bulk-import endpoint, kept as simple as possible for a hand-rolled
  // curl/script payload.
  app.post("/appstore/search-popularity", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = importRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    try {
      const written = await upsertPopularity(
        parsed.data.map((row) => ({
          keyword: row.keyword,
          source: "asa" as const,
          value: row.popularity,
          storefront: row.storefront,
          checkedAt: row.checked_at
            ? Math.floor(new Date(row.checked_at).getTime() / 1000)
            : undefined,
        })),
      );
      return c.json({ success: true, data: { written } });
    } catch (err) {
      log.error("ASA search-popularity import failed", { err });
      return c.json({ success: false, error: "Import failed" }, 500);
    }
  });

  return app;
}
