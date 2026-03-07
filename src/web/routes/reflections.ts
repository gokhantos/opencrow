import { Hono } from "hono";
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import {
  getReflectionStats,
  getUnresolvedReflections,
} from "../../agent/self-reflection";
import {
  getAgentReflections,
  findSimilarPastFailures,
} from "../../agent/reflection/postmortem";
import {
  analyzeAgentReflections,
  findCrossAgentPatterns,
  getImprovementSuggestions,
} from "../../agent/reflection/analyzer";

const log = createLogger("web-reflections");

export function createReflectionsRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/reflections/:agentId - Get reflections for an agent
   * Query params: limit, outcomeStatus
   */
  app.get("/reflections/:agentId", async (c) => {
    try {
      const agentId = c.req.param("agentId");
      const limit = c.req.query("limit");
      const outcomeStatus = c.req.query("outcomeStatus");

      const reflections = await getAgentReflections(
        agentId,
        Math.min(parseInt(limit || "10", 10), 100),
        outcomeStatus,
      );

      return c.json({
        success: true,
        data: reflections,
      });
    } catch (err) {
      log.warn("Failed to get agent reflections", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get agent reflections",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/:agentId/analysis - Get reflection analysis for an agent
   * Query params: timeWindow
   */
  app.get("/reflections/:agentId/analysis", async (c) => {
    try {
      const agentId = c.req.param("agentId");
      const timeWindow = c.req.query("timeWindow") || "7d";

      const analysis = await analyzeAgentReflections(agentId, timeWindow);

      return c.json({
        success: true,
        data: analysis,
      });
    } catch (err) {
      log.warn("Failed to analyze agent reflections", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to analyze agent reflections",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/:agentId/suggestions - Get improvement suggestions for an agent
   */
  app.get("/reflections/:agentId/suggestions", async (c) => {
    try {
      const agentId = c.req.param("agentId");
      const suggestions = await getImprovementSuggestions(agentId);

      return c.json({
        success: true,
        data: suggestions,
      });
    } catch (err) {
      log.warn("Failed to get improvement suggestions", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get improvement suggestions",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/patterns - Get cross-agent reflection patterns
   * Query params: limit
   */
  app.get("/reflections/patterns", async (c) => {
    try {
      const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 100);
      const patterns = await findCrossAgentPatterns(limit);

      return c.json({
        success: true,
        data: patterns,
      });
    } catch (err) {
      log.warn("Failed to find cross-agent patterns", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to find cross-agent patterns",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/search - Search for similar past failures
   * Query params: errorSignature, domain, limit
   */
  app.get("/reflections/search", async (c) => {
    try {
      const errorSignature = c.req.query("errorSignature");
      const domain = c.req.query("domain") || "general";
      const limit = c.req.query("limit") || "5";

      if (!errorSignature) {
        return c.json(
          {
            success: false,
            error: "errorSignature query parameter is required",
          },
          400,
        );
      }

      const failures = await findSimilarPastFailures(
        errorSignature,
        domain,
        Math.min(parseInt(limit, 10), 50),
      );

      return c.json({
        success: true,
        data: failures,
      });
    } catch (err) {
      log.warn("Failed to search similar failures", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to search similar failures",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/stats - Get reflection statistics
   */
  app.get("/reflections/stats", async (c) => {
    try {
      const db = getDb();

      // Total reflections
      const totalResult = await db`
        SELECT COUNT(*) as count FROM agent_reflections
      `;
      const totalReflections = Number(totalResult?.[0]?.count || 0);

      // Reflections by type
      const typeResult = await db`
        SELECT
          reflection_type,
          COUNT(*) as count
        FROM agent_reflections
        GROUP BY reflection_type
      `;

      const byType: Record<string, number> = {};
      if (typeResult && typeResult.length > 0) {
        for (const row of typeResult) {
          byType[row.reflection_type] = Number(row.count);
        }
      }

      // Reflections by outcome status
      const outcomeResult = await db`
        SELECT
          outcome_status,
          COUNT(*) as count
        FROM agent_reflections
        GROUP BY outcome_status
      `;

      const byOutcome: Record<string, number> = {};
      if (outcomeResult && outcomeResult.length > 0) {
        for (const row of outcomeResult) {
          byOutcome[row.outcome_status] = Number(row.count);
        }
      }

      // Average lessons per reflection
      const lessonsAvgResult = await db`
        SELECT
          AVG(jsonb_array_length(lessons_learned_json::jsonb)) as avg_lessons
        FROM agent_reflections
        WHERE lessons_learned_json IS NOT NULL
          AND lessons_learned_json != '[]'
      `;
      const avgLessons = Number(lessonsAvgResult?.[0]?.avg_lessons || 0);

      // Average improvement actions per reflection
      const actionsAvgResult = await db`
        SELECT
          AVG(jsonb_array_length(improvement_actions_json::jsonb)) as avg_actions
        FROM agent_reflections
        WHERE improvement_actions_json IS NOT NULL
          AND improvement_actions_json != '[]'
      `;
      const avgActions = Number(actionsAvgResult?.[0]?.avg_actions || 0);

      // Reflections today
      const todayResult = await db`
        SELECT COUNT(*) as count FROM agent_reflections
        WHERE created_at >= DATE_TRUNC('day', NOW())
      `;
      const reflectionsToday = Number(todayResult?.[0]?.count || 0);

      // Unique agents with reflections
      const agentsResult = await db`
        SELECT COUNT(DISTINCT agent_id) as count FROM agent_reflections
      `;
      const uniqueAgents = Number(agentsResult?.[0]?.count || 0);

      return c.json({
        success: true,
        data: {
          totalReflections,
          byType,
          byOutcome,
          avgLessons,
          avgActions,
          reflectionsToday,
          uniqueAgents,
        },
      });
    } catch (err) {
      log.warn("Failed to get reflection stats", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get reflection stats",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/recent - Get recent reflections
   * Query params: limit
   */
  app.get("/reflections/recent", async (c) => {
    try {
      const db = getDb();
      const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);

      const result = await db`
        SELECT
          ar.id,
          ar.session_id,
          ar.task_hash,
          ar.agent_id,
          ar.reflection_type,
          ar.outcome_status,
          ar.what_went_well,
          ar.what_went_wrong,
          ar.root_cause_analysis,
          ar.lessons_learned_json,
          ar.improvement_actions_json,
          ar.created_at,
          sh.result as task_result
        FROM agent_reflections ar
        LEFT JOIN session_history sh ON ar.session_id = sh.session_id
        ORDER BY ar.created_at DESC
        LIMIT ${limit}
      `;

      // Parse JSON fields
      const reflections = (result || []).map((row: any) => ({
        ...row,
        lessons_learned: JSON.parse(row.lessons_learned_json || "[]"),
        improvement_actions: JSON.parse(row.improvement_actions_json || "[]"),
      }));

      return c.json({
        success: true,
        data: reflections,
      });
    } catch (err) {
      log.warn("Failed to get recent reflections", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get recent reflections",
        },
        500,
      );
    }
  });

  /**
   * GET /api/reflections/:agentId/learning - Get lessons learned for an agent
   * Query params: limit
   */
  app.get("/reflections/:agentId/learning", async (c) => {
    try {
      const agentId = c.req.param("agentId");
      const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
      const db = getDb();

      const result = await db`
        SELECT
          ar.task_hash,
          ar.outcome_status,
          ar.lessons_learned_json,
          ar.improvement_actions_json,
          ar.created_at
        FROM agent_reflections ar
        WHERE ar.agent_id = ${agentId}
        ORDER BY ar.created_at DESC
        LIMIT ${limit}
      `;

      // Extract all lessons and actions
      const lessons: string[] = [];
      const actions: Array<{ action: string; priority: string }> = [];

      for (const row of result || []) {
        const lessonsLearned = JSON.parse(row.lessons_learned_json || "[]");
        const improvementActions = JSON.parse(
          row.improvement_actions_json || "[]",
        );

        lessons.push(...lessonsLearned);

        for (const action of improvementActions) {
          actions.push({
            action: action.action,
            priority: action.priority,
          });
        }
      }

      // Get unique lessons
      const uniqueLessons = [...new Set(lessons)];

      return c.json({
        success: true,
        data: {
          lessons: uniqueLessons.slice(0, 20),
          actions: actions.slice(0, 20),
        },
      });
    } catch (err) {
      log.warn("Failed to get agent lessons", { error: String(err) });
      return c.json(
        {
          success: false,
          error: "Failed to get agent lessons",
        },
        500,
      );
    }
  });

  /**
   * GET /api/self-reflections/stats - Get self-reflection aggregate statistics
   */
  app.get("/self-reflections/stats", async (c) => {
    try {
      const stats = await getReflectionStats();
      return c.json({ success: true, data: stats });
    } catch (err) {
      log.warn("Failed to get self-reflection stats", { error: String(err) });
      return c.json(
        { success: false, error: "Failed to get self-reflection stats" },
        500,
      );
    }
  });

  /**
   * GET /api/self-reflections/unresolved - Get unresolved self-reflections
   * Query params: sessionId (optional)
   */
  app.get("/self-reflections/unresolved", async (c) => {
    try {
      const sessionId = c.req.query("sessionId");
      const reflections = await getUnresolvedReflections(sessionId);
      return c.json({ success: true, data: reflections });
    } catch (err) {
      log.warn("Failed to get unresolved self-reflections", {
        error: String(err),
      });
      return c.json(
        { success: false, error: "Failed to get unresolved self-reflections" },
        500,
      );
    }
  });

  return app;
}
