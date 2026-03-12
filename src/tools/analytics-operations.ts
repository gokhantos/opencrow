import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";

export function createGetErrorSummaryTool(): ToolDefinition {
  return {
    name: "get_error_summary",
    description:
      "Aggregate error analysis from tool audit logs and process logs. Shows error rates, common errors, and patterns. Useful for identifying reliability issues.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Tool errors
        const toolErrors = await db`
          SELECT
            tool_name,
            COUNT(*) as total,
            SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
          FROM tool_audit_log
          WHERE created_at >= ${since}
          GROUP BY tool_name
          HAVING SUM(CASE WHEN is_error THEN 1 ELSE 0 END) > 0
          ORDER BY errors DESC
          LIMIT 10
        `;

        // Process errors
        const processErrors = await db`
          SELECT
            process_name,
            level,
            COUNT(*) as count
          FROM process_logs
          WHERE created_at >= ${since} AND level = 'error'
          GROUP BY process_name, level
          ORDER BY count DESC
          LIMIT 10
        `;

        const lines: string[] = [];

        if (toolErrors.length > 0) {
          lines.push(`Tool errors (last ${hoursBack}h):`);
          for (const e of toolErrors) {
            const rate = (Number(e.errors) / Number(e.total) * 100).toFixed(1);
            lines.push(`  ${e.tool_name}: ${e.errors} errors / ${e.total} calls (${rate}%)`);
          }
        }

        if (processErrors.length > 0) {
          lines.push(`\nProcess errors (last ${hoursBack}h):`);
          for (const e of processErrors) {
            lines.push(`  ${e.process_name}: ${e.count} errors`);
          }
        }

        if (lines.length === 0) {
          return { output: `No errors found in the last ${hoursBack} hours. System is healthy!`, isError: false };
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching error summary: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetActivityTimelineTool(): ToolDefinition {
  return {
    name: "get_activity_timeline",
    description:
      "Cross-reference activity across sessions, subagent runs, and tool usage. Shows a timeline of system activity. Useful for understanding usage patterns.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
        limit: {
          type: "number",
          description: "Max events per category (default 20, max 50).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const limit = Math.min((input.limit as number) || 20, 50);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Recent sessions
        const sessions = await db`
          SELECT channel, chat_id, created_at
          FROM sessions
          WHERE created_at >= ${since}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

        // Recent subagent runs
        const subagents = await db`
          SELECT child_agent_id, task, status, started_at, ended_at
          FROM subagent_runs
          WHERE started_at >= ${since}
          ORDER BY started_at DESC
          LIMIT ${limit}
        `;

        // Recent tool activity
        const tools = await db`
          SELECT tool_name, agent_id, is_error, created_at
          FROM tool_audit_log
          WHERE created_at >= ${since}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

        const lines: string[] = [];
        lines.push(`Activity Timeline (last ${hoursBack}h):\n`);

        if (sessions.length > 0) {
          lines.push("=== Recent Sessions ===");
          for (const s of sessions.slice(0, 5)) {
            const ts = new Date(s.created_at * 1000).toLocaleString();
            lines.push(`  ${ts} | ${s.channel}/${s.chat_id}`);
          }
          if (sessions.length > 5) lines.push(`  ... and ${sessions.length - 5} more`);
        }

        if (subagents.length > 0) {
          lines.push("\n=== Recent Subagent Runs ===");
          const statusCounts = subagents.reduce((acc: Record<string, number>, s: { status: string }) => {
            acc[s.status] = (acc[s.status] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);
          lines.push(`  Status: ${JSON.stringify(statusCounts)}`);
          for (const s of subagents.slice(0, 3)) {
            const ts = new Date(s.started_at * 1000).toLocaleString();
            lines.push(`  ${ts} | ${s.child_agent_id}: ${s.task.slice(0, 50)} [${s.status}]`);
          }
        }

        if (tools.length > 0) {
          lines.push("\n=== Recent Tool Activity ===");
          const errorCount = tools.filter((t: any) => t.is_error).length;
          lines.push(`  ${tools.length} calls, ${errorCount} errors`);
          for (const t of tools.slice(0, 5)) {
            const ts = new Date(t.created_at * 1000).toLocaleTimeString();
            const err = t.is_error ? " [ERROR]" : "";
            lines.push(`  ${ts} | ${t.agent_id} | ${t.tool_name}${err}`);
          }
        }

        if (sessions.length === 0 && subagents.length === 0 && tools.length === 0) {
          return { output: `No activity found in the last ${hoursBack} hours.`, isError: false };
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching activity timeline: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetUserActivityTool(): ToolDefinition {
  return {
    name: "get_user_activity",
    description:
      "Analyze user activity from prompt logs. Shows most active users/chats, common prompts, and activity patterns. Useful for understanding user behavior.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
        limit: {
          type: "number",
          description: "Max results per category (default 10, max 30).",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const limit = Math.min((input.limit as number) || 10, 30);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Activity by chat (channel/chat_id)
        const byChat = await db`
          SELECT agent_id, session_id, COUNT(*) as prompt_count
          FROM user_prompt_log
          WHERE created_at >= TO_TIMESTAMP(${since})
          GROUP BY agent_id, session_id
          ORDER BY prompt_count DESC
          LIMIT ${limit}
        `;

        // Activity by agent
        const byAgent = await db`
          SELECT agent_id, COUNT(*) as prompt_count
          FROM user_prompt_log
          WHERE created_at >= TO_TIMESTAMP(${since})
          GROUP BY agent_id
          ORDER BY prompt_count DESC
          LIMIT 10
        `;

        // Recent prompts (sample)
        const recentPrompts = await db`
          SELECT agent_id, prompt, created_at
          FROM user_prompt_log
          WHERE created_at >= TO_TIMESTAMP(${since})
          ORDER BY created_at DESC
          LIMIT 5
        `;

        const totalPrompts = byChat.reduce((sum: number, r: { prompt_count: bigint }) => sum + Number(r.prompt_count), 0);
        const uniqueChats = byChat.length;

        const lines: string[] = [];
        lines.push(`User Activity (last ${hoursBack}h):\n`);
        lines.push(`Total prompts: ${totalPrompts}`);
        lines.push(`Unique sessions: ${uniqueChats}\n`);

        if (byAgent.length > 0) {
          lines.push("By agent:");
          for (const r of byAgent) {
            lines.push(`  ${r.agent_id}: ${r.prompt_count} prompts`);
          }
          lines.push("");
        }

        if (byChat.length > 0) {
          lines.push("Top sessions:");
          for (const r of byChat.slice(0, 5)) {
            lines.push(`  ${r.agent_id}/${r.session_id ?? "unknown"}: ${r.prompt_count} prompts`);
          }
          if (byChat.length > 5) {
            lines.push(`  ... and ${byChat.length - 5} more sessions`);
          }
          lines.push("");
        }

        if (recentPrompts.length > 0) {
          lines.push("Recent prompts:");
          for (const r of recentPrompts) {
            const ts = new Date(r.created_at).toLocaleTimeString();
            const preview = r.prompt.slice(0, 60).replace(/\n/g, " ");
            lines.push(`  [${ts}] ${r.agent_id}: ${preview}${r.prompt.length > 60 ? "..." : ""}`);
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching user activity: ${msg}`, isError: true };
      }
    },
  };
}

export function createGetSubagentActivityTool(): ToolDefinition {
  return {
    name: "get_subagent_activity",
    description:
      "Analyze subagent activity from audit logs. Shows spawn patterns, success rates, and task types. Useful for understanding orchestration patterns.",
    categories: ["analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours to look back (default 24, max 168).",
        },
        parent_agent: {
          type: "string",
          description: "Filter by parent agent ID. Omit for all agents.",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const hoursBack = Math.min((input.hours_back as number) || 24, 168);
      const parentAgent = input.parent_agent as string | undefined;

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;

        // Status breakdown
        const statusBreakdown = await db`
          SELECT status, COUNT(*) as count
          FROM subagent_audit_log
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${parentAgent ? db`AND parent_agent_id = ${parentAgent}` : db``}
          GROUP BY status
          ORDER BY count DESC
        `;

        // By subagent type
        const bySubagent = await db`
          SELECT subagent_id, COUNT(*) as spawn_count,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes,
                 SUM(CASE WHEN status = 'error' OR status = 'timeout' THEN 1 ELSE 0 END) as failures
          FROM subagent_audit_log
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${parentAgent ? db`AND parent_agent_id = ${parentAgent}` : db``}
          GROUP BY subagent_id
          ORDER BY spawn_count DESC
          LIMIT 10
        `;

        // Average duration (for completed subagents)
        const durationStats = await db`
          SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) as avg_duration,
                 COUNT(*) as completed_count
          FROM subagent_audit_log
          WHERE completed_at IS NOT NULL
            AND created_at >= TO_TIMESTAMP(${since})
            ${parentAgent ? db`AND parent_agent_id = ${parentAgent}` : db``}
        `;

        // Recent spawns
        const recentSpawns = await db`
          SELECT parent_agent_id, subagent_id, task, status, created_at
          FROM subagent_audit_log
          WHERE created_at >= TO_TIMESTAMP(${since})
            ${parentAgent ? db`AND parent_agent_id = ${parentAgent}` : db``}
          ORDER BY created_at DESC
          LIMIT 5
        `;

        const totalSpawns = statusBreakdown.reduce((sum: number, r: { count: bigint }) => sum + Number(r.count), 0);
        const totalFailures = statusBreakdown
          .filter((r: { status: string }) => r.status === "error" || r.status === "timeout")
          .reduce((sum: number, r: { count: bigint }) => sum + Number(r.count), 0);
        const failureRate = totalSpawns > 0 ? ((totalFailures / totalSpawns) * 100).toFixed(1) : "0";

        const lines: string[] = [];
        lines.push(`Subagent Activity (last ${hoursBack}h):\n`);
        lines.push(`Total spawns: ${totalSpawns}, Failures: ${totalFailures} (${failureRate}%)`);

        if (durationStats[0]?.avg_duration) {
          const avgDur = Math.round(Number(durationStats[0].avg_duration));
          const completed = durationStats[0].completed_count;
          lines.push(`Avg duration: ${avgDur}s (${completed} completed)\n`);
        } else {
          lines.push("");
        }

        if (statusBreakdown.length > 0) {
          lines.push("Status breakdown:");
          for (const r of statusBreakdown) {
            lines.push(`  ${r.status}: ${r.count}`);
          }
          lines.push("");
        }

        if (bySubagent.length > 0) {
          lines.push("By subagent:");
          for (const r of bySubagent) {
            const successRate = r.spawn_count > 0 ? ((Number(r.successes) / Number(r.spawn_count)) * 100).toFixed(0) : "0";
            lines.push(`  ${r.subagent_id}: ${r.spawn_count} spawns, ${successRate}% success`);
          }
          lines.push("");
        }

        if (recentSpawns.length > 0) {
          lines.push("Recent spawns:");
          for (const r of recentSpawns) {
            const ts = new Date(r.created_at).toLocaleTimeString();
            const taskPreview = r.task ? r.task.slice(0, 50).replace(/\n/g, " ") : "no task";
            lines.push(`  [${ts}] ${r.parent_agent_id} → ${r.subagent_id}: ${taskPreview}... [${r.status}]`);
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching subagent activity: ${msg}`, isError: true };
      }
    },
  };
}
