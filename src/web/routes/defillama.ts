import { Hono } from "hono";
import {
  getProtocols,
  getTopMovers,
  getChainTvls,
  getChainTvlHistory,
  getLatestChainMetrics,
  getAllTargetChainMetrics,
  getChainMetricsHistory,
  chainToId,
  TARGET_CHAINS,
} from "../../sources/defillama/store";
import { getDb } from "../../store/db";
import {
  getProtocolDetail,
  getCategories,
  getLatestGlobalMetrics,
} from "../../sources/defillama/store-overviews";
import { getYieldPools } from "../../sources/defillama/store-yields";
import { getBridges } from "../../sources/defillama/store-bridges";
import {
  getHacks,
  getEmissions,
  getStablecoins,
  getTreasury,
} from "../../sources/defillama/store-misc";

export function createDefiLlamaRoutes(): Hono {
  const app = new Hono();

  app.get("/defi/protocols", async (c) => {
    try {
      const category = c.req.query("category") || undefined;
      const chain = c.req.query("chain") || undefined;
      const limitParam = c.req.query("limit");
      const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
      const protocols = await getProtocols({ category, chain, limit });
      return c.json({ success: true, data: protocols });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/movers", async (c) => {
    try {
      const limitParam = c.req.query("limit");
      const limit = Math.max(1, Math.min(Number(limitParam ?? "20") || 20, 100));
      const movers = await getTopMovers(limit);
      return c.json({ success: true, data: movers });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/chains", async (c) => {
    try {
      const limitParam = c.req.query("limit");
      const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));
      const chains = await getChainTvls(limit);
      return c.json({ success: true, data: chains });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/stats", async (c) => {
    try {
      const db = getDb();
      const rows = await db`
        SELECT
          count(*) as total_protocols,
          max(updated_at) as last_updated_at,
          count(DISTINCT chain) as chains,
          count(DISTINCT category) as categories
        FROM defi_protocols
      `;
      const stats = rows[0] ?? {
        total_protocols: 0,
        last_updated_at: null,
        chains: 0,
        categories: 0,
      };
      return c.json({ success: true, data: stats });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  // --- New endpoints for enhanced data ---

  app.get("/defi/chain-metrics", async (c) => {
    try {
      const chain = c.req.query("chain");
      if (chain) {
        const metrics = await getLatestChainMetrics(chainToId(chain));
        return c.json({ success: true, data: metrics });
      }
      const all = await getAllTargetChainMetrics();
      return c.json({ success: true, data: all });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/chain-metrics/history/:chain", async (c) => {
    try {
      const chain = c.req.param("chain");
      const daysBack = Math.min(
        Math.max(Number(c.req.query("days") ?? "30") || 30, 1),
        365,
      );
      const history = await getChainMetricsHistory(chainToId(chain), daysBack);
      return c.json({ success: true, data: history });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/tvl-history/:chain", async (c) => {
    try {
      const chain = c.req.param("chain");
      const daysBack = Math.min(
        Math.max(Number(c.req.query("days") ?? "90") || 90, 1),
        365,
      );
      const limit = Math.min(
        Math.max(Number(c.req.query("limit") ?? "365") || 365, 1),
        1000,
      );
      const history = await getChainTvlHistory(chainToId(chain), {
        daysBack,
        limit,
      });
      return c.json({ success: true, data: history });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/overview", async (c) => {
    try {
      const [chainMetrics, chainTvls] = await Promise.all([
        getAllTargetChainMetrics(),
        getChainTvls(10),
      ]);

      // Get top protocols per target chain (parallel)
      const protocolResults = await Promise.all(
        TARGET_CHAINS.map((chain) => getProtocols({ chain, limit: 10 })),
      );
      const protocolsByChain: Record<string, unknown[]> = {};
      TARGET_CHAINS.forEach((chain, i) => {
        protocolsByChain[chain] = protocolResults[i] ?? [];
      });

      return c.json({
        success: true,
        data: {
          targetChains: TARGET_CHAINS,
          chainMetrics,
          topChainsByTvl: chainTvls,
          topProtocolsByChain: protocolsByChain,
        },
      });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  // --- Phase 4: Extended data endpoints ---

  app.get("/defi/yields", async (c) => {
    try {
      const chain = c.req.query("chain") || undefined;
      const project = c.req.query("project") || undefined;
      const minApy = Number(c.req.query("minApy") ?? "0") || 0;
      const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
      const data = await getYieldPools({ chain, project, minApy, limit });
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/bridges", async (c) => {
    try {
      const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
      const data = await getBridges({ limit });
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/hacks", async (c) => {
    try {
      const chain = c.req.query("chain") || undefined;
      const minAmount = Number(c.req.query("minAmount") ?? "0") || 0;
      const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
      const data = await getHacks({ chain, limit, minAmount });
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/emissions", async (c) => {
    try {
      const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
      const hasUpcoming = c.req.query("hasUpcoming") === "true";
      const data = await getEmissions({ limit, hasUpcoming });
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/categories", async (c) => {
    try {
      const data = await getCategories();
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/protocol/:slug", async (c) => {
    try {
      const slug = c.req.param("slug");
      const data = await getProtocolDetail(slug);
      if (!data) {
        return c.json({ success: false, error: "Protocol not found" }, 404);
      }
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/global-metrics", async (c) => {
    try {
      const data = await getLatestGlobalMetrics();
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/stablecoins", async (c) => {
    try {
      const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
      const data = await getStablecoins({ limit });
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  app.get("/defi/treasury", async (c) => {
    try {
      const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
      const data = await getTreasury({ limit });
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  });

  return app;
}
