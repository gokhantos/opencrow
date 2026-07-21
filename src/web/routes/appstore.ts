import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import {
  getTopOpportunities,
  getScanHistory,
  getKeywordMeta,
  getOpportunityClusters,
  getClusterMembers,
  SORT_KEYS,
  CLUSTER_SORT_KEYS,
} from "../../sources/appstore/keyword-store";
import type { GapTrend } from "../../sources/appstore/keyword-types";
import {
  getRankings,
  getRankingsByCategory,
  getDiscoveredApps,
  getLowRatedReviews,
} from "../../sources/appstore/store";
import { getRankSeriesFromScans, getRankClimbers } from "../../sources/appstore/serp-rank-store";
import {
  deleteKeywordVerdict,
  getStarredKeywords,
  upsertKeywordVerdict,
} from "../../sources/appstore/keyword-verdict-store";
import { getDb } from "../../store/db";
import type { CoreClient } from "../core-client";

const log = createLogger("appstore-api");

const GAP_TRENDS = ["heating", "stable", "cooling", "new"] as const satisfies readonly GapTrend[];

const opportunitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(SORT_KEYS).default("opportunity"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  genreZone: z.string().optional(),
  trend: z.enum(GAP_TRENDS).optional(),
  minDemand: z.coerce.number().min(0).optional(),
  maxCompetitiveness: z.coerce.number().min(0).max(100).optional(),
  minIncumbentWeakness: z.coerce.number().min(0).max(1).optional(),
  minOpportunity: z.coerce.number().min(0).max(1).optional(),
  minBuildability: z.coerce.number().min(0).max(100).optional(),
  // z.coerce.boolean() would coerce ANY non-empty string (including "false")
  // to true — an explicit "true"/"false" string enum + transform is the only
  // safe way to read a boolean out of a query string.
  hideJunk: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  // Same boolean-string convention as `hideJunk` above (z.coerce.boolean()
  // would treat "false" as truthy). Shares the exact filter semantics
  // `collectKeywordGaps` (the idea-synthesis pipeline consumer) hardcodes —
  // see `GetTopOpportunitiesOptions.excludeLowConfidence`'s doc comment —
  // so the UI and the pipeline validate/consume the same contract.
  excludeLowConfidence: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const scanHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

// Server-side watchlist (Batch F, F5 leg 1) — mirrors the App Store keyword
// column length in practice; a bare length ceiling, not format validation
// (keywords are free-text search phrases).
const watchlistKeywordParamSchema = z.string().trim().min(1).max(200);
const watchlistListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const STORES = ["app", "play", "DE"] as const;

const rankSeriesQuerySchema = z.object({
  keyword: z.string().min(1),
  appId: z.string().min(1),
  store: z.enum(STORES).default("app"),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

const rankClimbersQuerySchema = z.object({
  keyword: z.string().min(1),
  store: z.enum(STORES).default("app"),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

// Member-level filters shared by both cluster endpoints — identical semantics
// to the opportunities filters (minus genreZone, which clusters span). Kept as
// a base so the aggregate list and the :clusterId expand view validate the same
// filter surface.
const clusterMemberFilterSchema = z.object({
  trend: z.enum(GAP_TRENDS).optional(),
  minDemand: z.coerce.number().min(0).optional(),
  maxCompetitiveness: z.coerce.number().min(0).max(100).optional(),
  minIncumbentWeakness: z.coerce.number().min(0).max(1).optional(),
  minOpportunity: z.coerce.number().min(0).max(1).optional(),
  minBuildability: z.coerce.number().min(0).max(100).optional(),
  hideJunk: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const opportunityClustersQuerySchema = clusterMemberFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(CLUSTER_SORT_KEYS).default("maxBuildability"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const clusterMembersQuerySchema = clusterMemberFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const clusterIdParamSchema = z.coerce.number().int().min(0).max(2_147_483_647);

const CLUSTER_QUERY_KEYS = [
  "limit",
  "offset",
  "sort",
  "dir",
  "trend",
  "minDemand",
  "maxCompetitiveness",
  "minIncumbentWeakness",
  "minOpportunity",
  "minBuildability",
  "hideJunk",
] as const;

export function createAppStoreRoutes(
  opts: { coreClient?: CoreClient } = {},
): Hono {
  const app = new Hono();

  app.get("/appstore/rankings", async (c) => {
    const listType = c.req.query("list_type") || undefined;
    const category = c.req.query("category") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "200") || 200, 500));

    const rankings = category
      ? await getRankingsByCategory(category, limit)
      : await getRankings(listType, limit);

    return c.json({ success: true, data: rankings });
  });

  app.get("/appstore/discovered", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "100") || 100, 500));
    const apps = await getDiscoveredApps(limit);
    return c.json({ success: true, data: apps });
  });

  app.get("/appstore/reviews", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
    const reviews = await getLowRatedReviews(limit);
    return c.json({ success: true, data: reviews });
  });

  app.get("/appstore/opportunities", async (c) => {
    const rawQuery: Record<string, string> = {};
    for (const key of [
      "limit",
      "offset",
      "sort",
      "dir",
      "genreZone",
      "trend",
      "minDemand",
      "maxCompetitiveness",
      "minIncumbentWeakness",
      "minOpportunity",
      "minBuildability",
      "hideJunk",
      "excludeLowConfidence",
    ] as const) {
      const value = c.req.query(key);
      if (value) rawQuery[key] = value;
    }

    const parsed = opportunitiesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const {
      limit,
      offset,
      sort,
      dir,
      genreZone,
      trend,
      minDemand,
      maxCompetitiveness,
      minIncumbentWeakness,
      minOpportunity,
      minBuildability,
      hideJunk,
      excludeLowConfidence,
    } = parsed.data;
    const { rows, total } = await getTopOpportunities({
      limit,
      offset,
      sort,
      dir,
      genreZone,
      trend,
      minDemand,
      maxCompetitiveness,
      minIncumbentWeakness,
      minOpportunity,
      minBuildability,
      hideJunk,
      excludeLowConfidence,
    });
    return c.json({
      success: true,
      data: rows,
      meta: { total, limit, offset },
    });
  });

  app.get("/appstore/opportunities/:keyword", async (c) => {
    const keyword = c.req.param("keyword");
    const parsed = scanHistoryQuerySchema.safeParse({
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    // Dashboard scan history is always the US storefront (2026-07-21 audit
    // item B fix — `getScanHistory` now requires an explicit store so a
    // DE-lane row can never silently starve/contaminate this view).
    const [history, meta] = await Promise.all([
      getScanHistory(keyword, parsed.data.limit, "app"),
      getKeywordMeta(keyword),
    ]);
    return c.json({
      success: true,
      data: {
        history,
        meta: {
          keyword,
          firstFoundAt: meta?.firstFoundAt ?? null,
          source: meta?.source ?? null,
        },
      },
    });
  });

  // Server-side watchlist (Batch F, F5 leg 1) — durable, cross-device star
  // state backed by `appstore_keyword_verdicts` (`source: "human"`,
  // `verdict: "starred"`). `OpportunitiesTab.tsx` keeps localStorage as an
  // offline cache but these routes are the source of truth going forward,
  // and `collectKeywordGaps` (F5 leg 3) reads `getStarredKeywords` directly
  // to auto-pull starred keywords as priority seeds every run.
  app.get("/appstore/watchlist", async (c) => {
    const parsed = watchlistListQuerySchema.safeParse({ limit: c.req.query("limit") ?? undefined });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }
    const keywords = await getStarredKeywords(parsed.data.limit);
    return c.json({ success: true, data: keywords, meta: { count: keywords.length } });
  });

  app.post("/appstore/watchlist/:keyword", async (c) => {
    const parsedKeyword = watchlistKeywordParamSchema.safeParse(c.req.param("keyword"));
    if (!parsedKeyword.success) {
      return c.json({ success: false, error: "Invalid keyword" }, 400);
    }
    const record = await upsertKeywordVerdict({
      keyword: parsedKeyword.data,
      verdict: "starred",
      source: "human",
    });
    return c.json({ success: true, data: record });
  });

  app.delete("/appstore/watchlist/:keyword", async (c) => {
    const parsedKeyword = watchlistKeywordParamSchema.safeParse(c.req.param("keyword"));
    if (!parsedKeyword.success) {
      return c.json({ success: false, error: "Invalid keyword" }, 400);
    }
    const deleted = await deleteKeywordVerdict(parsedKeyword.data, "human");
    return c.json({ success: true, data: { deleted } });
  });

  // Deep-SERP rank tracking (serp-rank Stage 1, deep-scrape build) — reads
  // `appstore_keyword_scans.top_apps`/`serp_tail` via `serp-rank-store.ts`.
  app.get("/appstore/rank-series", async (c) => {
    const parsed = rankSeriesQuerySchema.safeParse({
      keyword: c.req.query("keyword") ?? undefined,
      appId: c.req.query("appId") ?? undefined,
      store: c.req.query("store") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { keyword, appId, store, limit } = parsed.data;
    const series = await getRankSeriesFromScans(keyword, store, appId, limit);
    return c.json({
      success: true,
      data: series,
      meta: { keyword, appId, store, count: series.length },
    });
  });

  app.get("/appstore/rank-climbers", async (c) => {
    const parsed = rankClimbersQuerySchema.safeParse({
      keyword: c.req.query("keyword") ?? undefined,
      store: c.req.query("store") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { keyword, store, limit } = parsed.data;
    const climbers = await getRankClimbers(keyword, store, limit);
    return c.json({
      success: true,
      data: climbers,
      meta: { keyword, store, count: climbers.length },
    });
  });

  app.get("/appstore/opportunity-clusters", async (c) => {
    const rawQuery: Record<string, string> = {};
    for (const key of CLUSTER_QUERY_KEYS) {
      const value = c.req.query(key);
      if (value) rawQuery[key] = value;
    }

    const parsed = opportunityClustersQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { limit, offset, sort, dir, ...filters } = parsed.data;
    const { clusters, total } = await getOpportunityClusters({
      limit,
      offset,
      sort,
      dir,
      ...filters,
    });
    return c.json({
      success: true,
      data: clusters,
      meta: { total, limit, offset },
    });
  });

  app.get("/appstore/opportunity-clusters/:clusterId", async (c) => {
    const parsedId = clusterIdParamSchema.safeParse(c.req.param("clusterId"));
    if (!parsedId.success) {
      return c.json({ success: false, error: "Invalid cluster id" }, 400);
    }

    const rawQuery: Record<string, string> = {};
    for (const key of CLUSTER_QUERY_KEYS) {
      const value = c.req.query(key);
      if (value) rawQuery[key] = value;
    }

    const parsed = clusterMembersQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid query parameters";
      return c.json({ success: false, error: message }, 400);
    }

    const { limit, offset, ...filters } = parsed.data;
    const members = await getClusterMembers({
      clusterId: parsedId.data,
      limit,
      offset,
      ...filters,
    });
    return c.json({
      success: true,
      data: members,
      meta: { clusterId: parsedId.data, count: members.length, limit, offset },
    });
  });

  app.get("/appstore/stats", async (c) => {
    const db = getDb();
    // Lane-health heartbeat (B2): "when did each keyword-pipeline lane last
    // produce anything?", computed from cheap MAX() aggregates over existing
    // columns — so the dashboard can surface e.g. "last corpus growth: 3d
    // ago" and a silently-dead discovery lane becomes visible even after a
    // guardian restart wipes scraper.ts's in-process flatline counters.
    const [rows, scanByStore, growthBySource] = await Promise.all([
      db`
        SELECT
          (SELECT count(*) FROM appstore_apps) as total_apps,
          (SELECT count(*) FROM appstore_reviews) as total_reviews,
          (SELECT count(DISTINCT category) FROM appstore_apps) as total_categories,
          (SELECT max(updated_at) FROM appstore_apps) as last_updated_at,
          (SELECT max(seen_at) FROM appstore_autocomplete_hints) as last_hint_seen_at
      `,
      db`
        SELECT store, max(scanned_at) as last_scanned_at
        FROM appstore_keyword_scans
        GROUP BY store
      `,
      db`
        SELECT source, max(created_at) as last_created_at
        FROM appstore_keywords
        GROUP BY source
      `,
    ]);

    const base = (rows as ReadonlyArray<Record<string, unknown>>)[0] ?? {
      total_apps: 0,
      total_reviews: 0,
      total_categories: 0,
      last_updated_at: null,
      last_hint_seen_at: null,
    };

    const toNum = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);

    return c.json({
      success: true,
      data: {
        ...base,
        laneHealth: {
          // Autocomplete/GB hint discovery — the lane the 2026-07-18 header
          // change silently killed. Freshness of the newest hint row.
          lastHintSeenAt: toNum((base as { last_hint_seen_at?: unknown }).last_hint_seen_at),
          // SERP scan freshness per store ('app' / 'DE' / 'play').
          scansByStore: (scanByStore as ReadonlyArray<{ store: string; last_scanned_at: unknown }>).map(
            (r) => ({ store: r.store, lastScannedAt: toNum(r.last_scanned_at) }),
          ),
          // "last corpus growth" per keyword source (seed/autocomplete/mined/…).
          corpusGrowthBySource: (
            growthBySource as ReadonlyArray<{ source: string; last_created_at: unknown }>
          ).map((r) => ({ source: r.source, lastCreatedAt: toNum(r.last_created_at) })),
        },
      },
    });
  });

  app.post("/appstore/scrape-now", async (c) => {
    log.info("Manual App Store scrape triggered");

    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction(
        "appstore",
        "scrape-now",
        {},
      );
      return c.json({ success: true, data: result.data });
    }

    return c.json(
      { success: false, error: "App Store scraper not available" },
      503,
    );
  });

  return app;
}
