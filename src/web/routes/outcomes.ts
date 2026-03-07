import { Hono } from "hono";
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import {
  getOutcomeStats,
  getOutcomeHistory,
  getExtremeOutcomes,
  getDomainOutcomeStats,
  getAgentOutcomeComparison,
  getOutcomeTrend,
} from "../../agent/outcome/history";
import { getOutcomeCache } from "../../agent/outcome/router";

const log = createLogger("web-outcomes");

export function createOutcomesRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/outcomes/stats - Get outcome statistics
   * Query params: hoursBack, domain
   */
  app.get("/outcomes/stats", async (c) => {
    try {
      const hoursBack = c.req.query("hoursBack");
      const domain = c.req.query("domain");

      const stats = await getOutcomeStats(
        hoursBack ? Math.min(parseInt(hoursBack, 10) || 24, 720) : undefined,
        domain,
      );

      return c.json({
        success: true,
        data: stats,
      });
    } catch (err) {
      log.warn("Failed to get outcome stats", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get outcome stats",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/history/:agentId - Get outcome history for an agent
   * Query params: hoursBack, domain, limit
   */
  app.get("/outcomes/history/:agentId", async (c) => {
    try {
      const agentId = c.req.param("agentId");
      const hoursBack = c.req.query("hoursBack");
      const domain = c.req.query("domain");
      const limit = c.req.query("limit");

      const history = await getOutcomeHistory(
        agentId,
        domain,
        hoursBack ? Math.min(parseInt(hoursBack, 10) || 24, 720) : undefined,
        Math.min(parseInt(limit || "50", 10), 200),
      );

      return c.json({
        success: true,
        data: history,
      });
    } catch (err) {
      log.warn("Failed to get outcome history", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get outcome history",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/best - Get tasks with best outcomes
   * Query params: limit
   */
  app.get("/outcomes/best", async (c) => {
    try {
      const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 100);
      const outcomes = await getExtremeOutcomes("best", limit);

      return c.json({
        success: true,
        data: outcomes,
      });
    } catch (err) {
      log.warn("Failed to get best outcomes", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get best outcomes",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/worst - Get tasks with worst outcomes
   * Query params: limit
   */
  app.get("/outcomes/worst", async (c) => {
    try {
      const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 100);
      const outcomes = await getExtremeOutcomes("worst", limit);

      return c.json({
        success: true,
        data: outcomes,
      });
    } catch (err) {
      log.warn("Failed to get worst outcomes", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get worst outcomes",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/domains - Get outcome statistics by domain
   * Query params: hoursBack
   */
  app.get("/outcomes/domains", async (c) => {
    try {
      const hoursBack = c.req.query("hoursBack");
      const domains = await getDomainOutcomeStats(
        Math.min(parseInt(hoursBack || "24", 10), 720),
      );

      return c.json({
        success: true,
        data: domains,
      });
    } catch (err) {
      log.warn("Failed to get domain outcomes", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get domain outcomes",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/agents - Get outcome comparison by agent
   * Query params: hoursBack
   */
  app.get("/outcomes/agents", async (c) => {
    try {
      const hoursBack = c.req.query("hoursBack");
      const agents = await getAgentOutcomeComparison(
        Math.min(parseInt(hoursBack || "24", 10), 720),
      );

      return c.json({
        success: true,
        data: agents,
      });
    } catch (err) {
      log.warn("Failed to get agent outcomes", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get agent outcomes",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/trend - Get outcome trend over time
   * Query params: daysBack, domain
   */
  app.get("/outcomes/trend", async (c) => {
    try {
      const daysBack = c.req.query("daysBack");
      const domain = c.req.query("domain");

      const trend = await getOutcomeTrend(
        Math.min(parseInt(daysBack || "7", 10), 90),
        domain,
      );

      return c.json({
        success: true,
        data: trend,
      });
    } catch (err) {
      log.warn("Failed to get outcome trend", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get outcome trend",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/cache/:domain - Get outcome cache for a domain
   */
  app.get("/outcomes/cache/:domain", async (c) => {
    try {
      const domain = c.req.param("domain");
      const cache = await getOutcomeCache(domain);

      return c.json({
        success: true,
        data: cache,
      });
    } catch (err) {
      log.warn("Failed to get outcome cache", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get outcome cache",
        },
        500,
      );
    }
  });

  /**
   * POST /api/outcomes/cache/refresh - Refresh outcome caches
   */
  app.post("/outcomes/cache/refresh", async (c) => {
    try {
      const { refreshOutcomeCaches } =
        await import("../../agent/outcome-orchestrator");
      const updatedCount = await refreshOutcomeCaches();

      return c.json({
        success: true,
        data: { updatedCount },
      });
    } catch (err) {
      log.warn("Failed to refresh outcome caches", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to refresh outcome caches",
        },
        500,
      );
    }
  });

  /**
   * GET /api/outcomes/summary - Get comprehensive outcome summary
   */
  app.get("/outcomes/summary", async (c) => {
    try {
      const db = getDb();

      // Get total tasks
      const totalResult = await db`
        SELECT COUNT(*) as count FROM task_outcomes
      `;
      const totalTasks = Number(totalResult?.[0]?.count || 0);

      // Get success rate
      const successResult = await db`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE revision_count = 0 OR user_feedback = 'good') as successes
        FROM task_outcomes
      `;
      const total = Number(successResult?.[0]?.total || 0);
      const successes = Number(successResult?.[0]?.successes || 0);
      const successRate = total > 0 ? successes / total : 0;

      // Get average revisions
      const revisionsResult = await db`
        SELECT AVG(revision_count) as avg_revisions
        FROM task_outcomes
        WHERE revision_count > 0
      `;
      const avgRevisions = Number(revisionsResult?.[0]?.avg_revisions || 0);

      // Get feedback distribution
      const feedbackResult = await db`
        SELECT
          user_feedback,
          COUNT(*) as count
        FROM task_outcomes
        WHERE user_feedback IS NOT NULL
        GROUP BY user_feedback
      `;

      const feedback: Record<string, number> = {};
      if (feedbackResult && feedbackResult.length > 0) {
        for (const row of feedbackResult) {
          feedback[row.user_feedback] = Number(row.count);
        }
      }

      // Get tasks with quality scores
      const qualityResult = await db`
        SELECT
          COUNT(*) as count,
          AVG(quality_score) as avg_quality
        FROM task_outcomes
        WHERE quality_score IS NOT NULL
      `;
      const qualityCount = Number(qualityResult?.[0]?.count || 0);
      const avgQuality = Number(qualityResult?.[0]?.avg_quality || 0);

      return c.json({
        success: true,
        data: {
          totalTasks,
          successRate,
          avgRevisions,
          feedback,
          qualityCount,
          avgQuality,
        },
      });
    } catch (err) {
      log.warn("Failed to get outcome summary", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get outcome summary",
        },
        500,
      );
    }
  });

  return app;
}
