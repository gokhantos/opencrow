import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";

interface SessionAnalysisRow {
  agent_id: string;
  session_id: string;
  prompt: string | null;
  result: string | null;
  created_at: Date;
  updated_at: Date;
  duration_seconds: number | null;
}

export function createGetSessionAnalysisTool(): ToolDefinition {
  return {
    name: "get_session_analysis",
    description:
      "Analyze session durations and outcomes. Shows average session length, common outcomes, and session patterns. Useful for understanding conversation quality.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
        agent_id: {
          type: "string",
          description: "Filter by agent ID. Omit for all agents.",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const agentId = input.agent_id as string | undefined;

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Duration stats
        const durationStats = await db`
          SELECT
            AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_duration,
            MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_duration,
            MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_duration,
            COUNT(*) as session_count
          FROM session_history
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${agentId ? db`AND agent_id = ${agentId}` : db``}
        `;

        // Sessions by agent
        const byAgent = await db`
          SELECT agent_id, COUNT(*) as session_count,
                 AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_duration
          FROM session_history
          WHERE created_at >= TO_TIMESTAMP(${since})
          GROUP BY agent_id
          ORDER BY session_count DESC
          LIMIT 10
        `;

        // Recent sessions
        const recentSessions = await db`
          SELECT agent_id, session_id, prompt, result, created_at, updated_at
          FROM session_history
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${agentId ? db`AND agent_id = ${agentId}` : db``}
          ORDER BY updated_at DESC
          LIMIT 5
        `;

        const totalSessions = durationStats[0]?.session_count || 0n;
        const avgDuration = durationStats[0]?.avg_duration ? Math.round(Number(durationStats[0].avg_duration)) : 0;
        const minDuration = durationStats[0]?.min_duration ? Math.round(Number(durationStats[0].min_duration)) : 0;
        const maxDuration = durationStats[0]?.max_duration ? Math.round(Number(durationStats[0].max_duration)) : 0;

        const lines: string[] = [];
        lines.push(`Session Analysis (last ${hoursBack}h):\n`);
        lines.push(`Total sessions: ${totalSessions}`);
        lines.push(`Duration: avg ${Math.floor(avgDuration / 60)}m ${avgDuration % 60}s`);
        lines.push(`          min ${Math.floor(minDuration / 60)}m ${minDuration % 60}s`);
        lines.push(`          max ${Math.floor(maxDuration / 60)}m ${maxDuration % 60}s\n`);

        if (byAgent.length > 0) {
          lines.push("By agent:");
          for (const r of byAgent) {
            const avgDur = r.avg_duration ? Math.round(Number(r.avg_duration)) : 0;
            lines.push(`  ${r.agent_id}: ${r.session_count} sessions, avg ${Math.floor(avgDur / 60)}m ${avgDur % 60}s`);
          }
          lines.push("");
        }

        if (recentSessions.length > 0) {
          lines.push("Recent sessions:");
          for (const r of recentSessions) {
            const ts = new Date(r.updated_at).toLocaleTimeString();
            const promptPreview = r.prompt ? r.prompt.slice(0, 40).replace(/\n/g, " ") : "no prompt";
            const resultPreview = r.result ? r.result.slice(0, 30).replace(/\n/g, " ") : "no result";
            lines.push(`  [${ts}] ${r.agent_id}`);
            lines.push(`    Prompt: ${promptPreview}${r.prompt && r.prompt.length > 40 ? "..." : ""}`);
            lines.push(`    Result: ${resultPreview}${r.result && r.result.length > 30 ? "..." : ""}`);
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching session analysis: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetHealthDashboardTool(): ToolDefinition {
  return {
    name: "get_health_dashboard",
    description:
      "System health dashboard combining tool errors, session stats, and subagent activity. Shows error rates, active sessions, and system health indicators.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 72).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 72);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Tool error rate
        const toolStats = await db`
          SELECT COUNT(*) as total_calls,
                 SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
          FROM tool_audit_log
          WHERE created_at >= TO_TIMESTAMP(${since})
        `;

        // Subagent success rate
        const subagentStats = await db`
          SELECT COUNT(*) as total_spawns,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes,
                 SUM(CASE WHEN status IN ('error', 'timeout') THEN 1 ELSE 0 END) as failures
          FROM subagent_audit_log
          WHERE created_at >= TO_TIMESTAMP(${since})
        `;

        // Active sessions (sessions that started but may not have ended)
        const sessionStats = await db`
          SELECT COUNT(*) as total_sessions
          FROM session_history
          WHERE created_at >= TO_TIMESTAMP(${since})
        `;

        // Process errors
        const processStats = await db`
          SELECT COUNT(*) as error_count
          FROM process_logs
          WHERE created_at >= TO_TIMESTAMP(${since}) AND level = 'error'
        `;

        const totalToolCalls = Number(toolStats[0]?.total_calls || 0);
        const toolErrors = Number(toolStats[0]?.errors || 0);
        const toolErrorRate = totalToolCalls > 0 ? ((toolErrors / totalToolCalls) * 100).toFixed(1) : "0";

        const totalSubagents = Number(subagentStats[0]?.total_spawns || 0);
        const subagentSuccesses = Number(subagentStats[0]?.successes || 0);
        const subagentFailures = Number(subagentStats[0]?.failures || 0);
        const subagentSuccessRate = totalSubagents > 0 ? ((subagentSuccesses / totalSubagents) * 100).toFixed(1) : "0";

        const totalSessions = Number(sessionStats[0]?.total_sessions || 0);
        const processErrors = Number(processStats[0]?.error_count || 0);

        // Health indicators
        const healthIndicators: string[] = [];

        if (parseFloat(toolErrorRate) < 5) {
          healthIndicators.push(`[OK] Tool error rate: ${toolErrorRate}%`);
        } else if (parseFloat(toolErrorRate) < 10) {
          healthIndicators.push(`[WARN] Tool error rate: ${toolErrorRate}%`);
        } else {
          healthIndicators.push(`[CRITICAL] Tool error rate: ${toolErrorRate}%`);
        }

        if (parseFloat(subagentSuccessRate) > 90) {
          healthIndicators.push(`[OK] Subagent success: ${subagentSuccessRate}%`);
        } else if (parseFloat(subagentSuccessRate) > 75) {
          healthIndicators.push(`[WARN] Subagent success: ${subagentSuccessRate}%`);
        } else {
          healthIndicators.push(`[CRITICAL] Subagent success: ${subagentSuccessRate}%`);
        }

        if (processErrors < 10) {
          healthIndicators.push(`[OK] Process errors: ${processErrors}`);
        } else if (processErrors < 50) {
          healthIndicators.push(`[WARN] Process errors: ${processErrors}`);
        } else {
          healthIndicators.push(`[CRITICAL] Process errors: ${processErrors}`);
        }

        const lines: string[] = [];
        lines.push(`SYSTEM HEALTH DASHBOARD (last ${hoursBack}h)`);
        lines.push("=" .repeat(40));
        lines.push("");
        lines.push("HEALTH INDICATORS:");
        for (const indicator of healthIndicators) {
          lines.push(`  ${indicator}`);
        }
        lines.push("");
        lines.push("METRICS SUMMARY:");
        lines.push(`  Tool calls: ${totalToolCalls} (${toolErrors} errors, ${toolErrorRate}%)`);
        lines.push(`  Subagent spawns: ${totalSubagents} (${subagentSuccesses} success, ${subagentFailures} fail)`);
        lines.push(`  Sessions: ${totalSessions}`);
        lines.push(`  Process errors: ${processErrors}`);

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching health dashboard: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetRoutingStatsTool(): ToolDefinition {
  return {
    name: "get_routing_stats",
    description:
      "Intelligent routing statistics. Shows task classification breakdown, agent performance by domain, and routing effectiveness. Useful for optimizing agent selection.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
        domain: {
          type: "string",
          description: "Filter by task domain (coding, research, debug, etc.). Omit for all domains.",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const domainFilter = input.domain as string | undefined;

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Task classification breakdown
        const domainBreakdown = await db`
          SELECT domain, COUNT(*) as count, AVG(complexity_score) as avg_complexity
          FROM task_classification
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${domainFilter ? db`AND domain = ${domainFilter}` : db``}
          GROUP BY domain
          ORDER BY count DESC
        `;

        // Complexity distribution
        const complexityDist = await db`
          SELECT complexity_score, COUNT(*) as count
          FROM task_classification
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${domainFilter ? db`AND domain = ${domainFilter}` : db``}
          GROUP BY complexity_score
          ORDER BY complexity_score
        `;

        // Urgency distribution
        const urgencyDist = await db`
          SELECT urgency, COUNT(*) as count
          FROM task_classification
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${domainFilter ? db`AND domain = ${domainFilter}` : db``}
          GROUP BY urgency
          ORDER BY count DESC
        `;

        // Top keywords by domain
        const topKeywordsData = await db`
          SELECT domain, keywords_json
          FROM task_classification
          WHERE created_at >= TO_TIMESTAMP(${since})
            AND domain IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 100
        `;

        // Aggregate keyword frequency
        const keywordFreq: Record<string, number> = {};
        for (const row of topKeywordsData) {
          try {
            const keywords = JSON.parse(row.keywords_json as string) as string[];
            for (const kw of keywords) {
              keywordFreq[kw] = (keywordFreq[kw] || 0) + 1;
            }
          } catch {
            // Ignore malformed JSON in keywords_json - skip this row
          }
        }
        const topKeywordsList = Object.entries(keywordFreq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15);

        // Subagent performance by domain (joining with task_classification via task text matching)
        // Note: This is approximate since we don't have direct foreign key
        const agentPerformance = await db`
          SELECT subagent_id, COUNT(*) as tasks,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                 SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
                 SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeouts
          FROM subagent_audit_log
          WHERE created_at >= TO_TIMESTAMP(${since})
          GROUP BY subagent_id
          ORDER BY tasks DESC
          LIMIT 15
        `;

        // Agent scores from scoring engine (pre-computed performance metrics)
        const agentScores = await db`
          SELECT agent_id, domain, time_window, score, success_rate, avg_duration_sec, avg_cost_usd, total_tasks
          FROM agent_scores
          WHERE time_window = '24h'
          ORDER BY score DESC NULLS LAST
          LIMIT 15
        `;

        const totalTasks = domainBreakdown.reduce((sum: number, r: { count: bigint }) => sum + Number(r.count), 0);

        const lines: string[] = [];
        lines.push(`ROUTING STATISTICS (last ${hoursBack}h):\n`);
        lines.push(`Total classified tasks: ${totalTasks}\n`);

        // Domain breakdown
        if (domainBreakdown.length > 0) {
          lines.push("TASKS BY DOMAIN:");
          for (const r of domainBreakdown) {
            const count = Number(r.count);
            const pct = totalTasks > 0 ? ((count / totalTasks) * 100).toFixed(1) : "0";
            const avgComplexity = r.avg_complexity ? Number(r.avg_complexity).toFixed(2) : "N/A";
            lines.push(`  ${r.domain}: ${count} (${pct}%), avg complexity: ${avgComplexity}`);
          }
          lines.push("");
        }

        // Complexity distribution
        if (complexityDist.length > 0) {
          lines.push("COMPLEXITY DISTRIBUTION:");
          for (const r of complexityDist) {
            lines.push(`  Level ${r.complexity_score}: ${r.count} tasks`);
          }
          lines.push("");
        }

        // Urgency distribution
        if (urgencyDist.length > 0) {
          lines.push("URGENCY DISTRIBUTION:");
          for (const r of urgencyDist) {
            lines.push(`  ${r.urgency}: ${r.count} tasks`);
          }
          lines.push("");
        }

        // Top keywords
        if (topKeywordsList.length > 0) {
          lines.push("TOP KEYWORDS:");
          for (const [kw, freq] of topKeywordsList) {
            lines.push(`  ${kw}: ${freq}`);
          }
          lines.push("");
        }

        // Agent performance
        if (agentPerformance.length > 0) {
          lines.push("AGENT PERFORMANCE (last 24h):");
          for (const r of agentPerformance) {
            const successRate = r.tasks > 0 ? ((Number(r.completed) / Number(r.tasks)) * 100).toFixed(1) : "0";
            lines.push(`  ${r.subagent_id}: ${r.tasks} tasks, ${successRate}% success (${r.errors} err, ${r.timeouts} timeout)`);
          }
          lines.push("");
        }

        // Agent scores from scoring engine
        if (agentScores.length > 0) {
          lines.push("AGENT SCORES (computed, 24h window):");
          for (const r of agentScores) {
            const score = r.score ? Number(r.score).toFixed(2) : "N/A";
            const successRate = r.success_rate ? (Number(r.success_rate) * 100).toFixed(0) : "N/A";
            const avgDuration = r.avg_duration_sec ? Number(r.avg_duration_sec).toFixed(1) : "N/A";
            const totalTasks = r.total_tasks || 0;
            const domainLabel = r.domain ? ` [${r.domain}]` : "[overall]";
            lines.push(`  ${r.agent_id}${domainLabel}: score ${score}, ${successRate}% success, ${avgDuration}s avg, ${totalTasks} tasks`);
          }
          lines.push("");
        }

        if (totalTasks === 0) {
          return { output: `No classified tasks found in the last ${hoursBack} hours. Task classification is active on UserPrompt and SubagentStart hooks.`, isError: false };
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching routing stats: ${msg}`, isError: true };
      }
    },
  };
}
