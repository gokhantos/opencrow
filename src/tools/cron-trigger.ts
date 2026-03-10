import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";
import { sendCommand } from "../process/commands";
import { createLogger } from "../logger";

const log = createLogger("tool:cron-trigger");

export function createCronTriggerTool(): ToolDefinition {
  return {
    name: "trigger_cron",
    description:
      "List and manually trigger cron jobs. Use action 'list' to see all jobs with their schedules and last status, or 'run' to trigger a specific job immediately by name.",
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "run"],
          description: "Action: 'list' shows all jobs, 'run' triggers a job.",
        },
        job_name: {
          type: "string",
          description:
            "Job name to trigger (required for 'run'). Use 'list' first to see available names.",
        },
      },
      required: ["action"],
    },
    async execute(
      input: Record<string, unknown>,
    ): Promise<{ output: string; isError: boolean }> {
      const action = String(input.action);

      if (action === "list") {
        return listJobs();
      }

      if (action === "run") {
        const jobName = input.job_name as string | undefined;
        if (!jobName) {
          return {
            output:
              "Error: job_name is required for 'run'. Use action 'list' to see available jobs.",
            isError: true,
          };
        }
        return runJob(jobName);
      }

      return { output: `Unknown action: ${action}`, isError: true };
    },
  };
}

async function listJobs(): Promise<{ output: string; isError: boolean }> {
  try {
    const db = getDb();
    const rows = await db`
      SELECT id, name, enabled, schedule_json, payload_json,
             last_run_at, last_status, last_error
      FROM cron_jobs
      ORDER BY name ASC
    `;

    if (rows.length === 0) {
      return { output: "No cron jobs found.", isError: false };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const name = r.name as string;
      const enabled = r.enabled as boolean;
      const schedule = JSON.parse(r.schedule_json as string) as Record<
        string,
        unknown
      >;
      const payload = JSON.parse(r.payload_json as string) as Record<
        string,
        unknown
      >;
      const lastStatus = (r.last_status as string) || "never";
      const lastRunAt = r.last_run_at as number | null;

      let scheduleStr: string;
      if (schedule.kind === "cron") {
        scheduleStr = `cron: ${schedule.expr}`;
      } else if (schedule.kind === "every") {
        const ms = schedule.everyMs as number;
        if (ms >= 3600000) scheduleStr = `every ${ms / 3600000}h`;
        else if (ms >= 60000) scheduleStr = `every ${ms / 60000}m`;
        else scheduleStr = `every ${ms / 1000}s`;
      } else {
        scheduleStr = `at: ${schedule.at}`;
      }

      const type = `agent:${(payload.agentId as string) || "default"}`;

      const lastRun = lastRunAt
        ? new Date(lastRunAt * 1000).toLocaleString()
        : "never";

      const status = enabled ? "" : " [DISABLED]";
      return `  ${name}${status}\n    ${scheduleStr} | ${type} | last: ${lastStatus} @ ${lastRun}`;
    });

    return {
      output: `${rows.length} cron jobs:\n\n${lines.join("\n\n")}`,
      isError: false,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { output: `Error listing cron jobs: ${msg}`, isError: true };
  }
}

async function runJob(
  jobName: string,
): Promise<{ output: string; isError: boolean }> {
  try {
    const db = getDb();

    // Find job by name (case-insensitive partial match)
    const rows = await db`
      SELECT id, name, enabled FROM cron_jobs
      WHERE LOWER(name) = LOWER(${jobName})
         OR LOWER(name) LIKE LOWER(${`%${jobName}%`})
      ORDER BY
        CASE WHEN LOWER(name) = LOWER(${jobName}) THEN 0 ELSE 1 END,
        name ASC
      LIMIT 5
    `;

    if (rows.length === 0) {
      return {
        output: `No cron job found matching "${jobName}". Use action 'list' to see available jobs.`,
        isError: true,
      };
    }

    // If multiple matches, show them
    if (rows.length > 1) {
      const exactMatch = rows.find(
        (r: Record<string, unknown>) =>
          (r.name as string).toLowerCase() === jobName.toLowerCase(),
      );
      if (!exactMatch) {
        const names = rows
          .map((r: Record<string, unknown>) => r.name as string)
          .join(", ");
        return {
          output: `Multiple jobs match "${jobName}": ${names}. Be more specific.`,
          isError: true,
        };
      }
      // Use exact match
      return triggerJob(
        exactMatch.id as string,
        exactMatch.name as string,
      );
    }

    return triggerJob(rows[0].id as string, rows[0].name as string);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { output: `Error triggering cron job: ${msg}`, isError: true };
  }
}

async function triggerJob(
  jobId: string,
  jobName: string,
): Promise<{ output: string; isError: boolean }> {
  try {
    await sendCommand("cron", "cron:run_job", { jobId });
    log.info("Cron job triggered manually", { jobId, jobName });
    return {
      output: `Triggered "${jobName}" — running asynchronously. Check results with action 'list' later.`,
      isError: false,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      output: `Failed to trigger "${jobName}": ${msg}`,
      isError: true,
    };
  }
}
