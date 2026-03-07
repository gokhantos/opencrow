import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("agents:tracker");

export interface SubAgentRun {
  readonly id: string;
  readonly parentAgentId: string;
  readonly parentSessionKey: string;
  readonly childAgentId: string;
  readonly childSessionKey: string;
  readonly task: string;
  readonly status: "running" | "completed" | "error" | "timeout";
  readonly resultText: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface SubAgentTracker {
  register(run: {
    id: string;
    parentAgentId: string;
    parentSessionKey: string;
    childAgentId: string;
    childSessionKey: string;
    task: string;
    abortController?: AbortController;
  }): Promise<void>;
  complete(id: string, resultText: string): Promise<void>;
  fail(id: string, errorMessage: string): Promise<void>;
  /** Cancel a running sub-agent by runId. Returns true if found and cancelled. */
  cancel(id: string): boolean;
  getActiveForSession(sessionKey: string): readonly SubAgentRun[];
  /** Get all currently active sub-agent runs. */
  getActive(): readonly SubAgentRun[];
  countActiveForSession(sessionKey: string): number;
  /** Get completed sub-agent results for context propagation */
  getCompletedForSession(
    parentSessionKey: string,
  ): Promise<ReadonlyArray<{ agentId: string; result: string }>>;
}

export function createSubAgentTracker(): SubAgentTracker {
  const activeRuns = new Map<string, SubAgentRun>();
  const abortControllers = new Map<string, AbortController>();

  async function restoreActiveRuns(): Promise<void> {
    try {
      const db = getDb();
      const rows = await db`SELECT * FROM subagent_runs WHERE status = 'running'`;

      for (const row of rows) {
        const run = rowToRun(row as Record<string, unknown>);
        activeRuns.set(run.id, run);
      }

      if (activeRuns.size > 0) {
        log.info("Restored active sub-agent runs", { count: activeRuns.size });
      }
    } catch {
      // table may not have data yet
    }
  }

  let initialized = false;

  async function ensureInit(): Promise<void> {
    if (initialized) return;
    initialized = true;
    await restoreActiveRuns();
  }

  return {
    async register(input): Promise<void> {
      await ensureInit();
      const now = Math.floor(Date.now() / 1000);
      const run: SubAgentRun = {
        id: input.id,
        parentAgentId: input.parentAgentId,
        parentSessionKey: input.parentSessionKey,
        childAgentId: input.childAgentId,
        childSessionKey: input.childSessionKey,
        task: input.task,
        status: "running",
        resultText: null,
        errorMessage: null,
        startedAt: now,
        endedAt: null,
      };

      activeRuns.set(run.id, run);
      if (input.abortController) {
        abortControllers.set(run.id, input.abortController);
      }

      try {
        const db = getDb();
        await db`
          INSERT INTO subagent_runs
            (id, parent_agent_id, parent_session_key, child_agent_id, child_session_key, task, status, started_at)
          VALUES (${run.id}, ${run.parentAgentId}, ${run.parentSessionKey}, ${run.childAgentId}, ${run.childSessionKey}, ${run.task}, 'running', ${run.startedAt})
        `;
      } catch (error) {
        log.error("Failed to persist sub-agent run", error);
      }
    },

    async complete(id: string, resultText: string): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      activeRuns.delete(id);
      abortControllers.delete(id);

      try {
        const db = getDb();
        await db`
          UPDATE subagent_runs SET status = 'completed', result_text = ${resultText}, ended_at = ${now} WHERE id = ${id}
        `;
      } catch (error) {
        log.error("Failed to update sub-agent run", error);
      }
    },

    async fail(id: string, errorMessage: string): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      activeRuns.delete(id);
      abortControllers.delete(id);

      try {
        const db = getDb();
        await db`
          UPDATE subagent_runs SET status = 'error', error_message = ${errorMessage}, ended_at = ${now} WHERE id = ${id}
        `;
      } catch (error) {
        log.error("Failed to update sub-agent run", error);
      }
    },

    cancel(id: string): boolean {
      const controller = abortControllers.get(id);
      if (!controller) return false;

      controller.abort();
      abortControllers.delete(id);

      const run = activeRuns.get(id);
      if (run) {
        activeRuns.set(id, { ...run, status: "error", errorMessage: "Cancelled by user", endedAt: Math.floor(Date.now() / 1000) });
      }

      // Persist cancellation asynchronously (best-effort)
      const now = Math.floor(Date.now() / 1000);
      try {
        const db = getDb();
        db`UPDATE subagent_runs SET status = 'error', error_message = 'Cancelled by user', ended_at = ${now} WHERE id = ${id}`.catch(
          (err) => log.error("Failed to persist cancellation", err),
        );
      } catch (err) {
        log.error("Failed to persist cancellation", err);
      }

      // Remove from active runs after persisting
      activeRuns.delete(id);

      log.info("Sub-agent cancelled", { runId: id });
      return true;
    },

    getActiveForSession(sessionKey: string): readonly SubAgentRun[] {
      return [...activeRuns.values()].filter(
        (r) => r.parentSessionKey === sessionKey,
      );
    },

    getActive(): readonly SubAgentRun[] {
      return [...activeRuns.values()];
    },

    countActiveForSession(sessionKey: string): number {
      return [...activeRuns.values()].filter(
        (r) => r.parentSessionKey === sessionKey,
      ).length;
    },

    async getCompletedForSession(
      parentSessionKey: string,
    ): Promise<ReadonlyArray<{ agentId: string; result: string }>> {
      try {
        const db = getDb();
        const rows = await db`
          SELECT child_agent_id, result_text
          FROM subagent_runs
          WHERE parent_session_key = ${parentSessionKey}
            AND status = 'completed'
            AND result_text IS NOT NULL
          ORDER BY started_at ASC
        `;
        return (rows || []).map((r: Record<string, unknown>) => ({
          agentId: r.child_agent_id as string,
          result: (r.result_text as string).slice(0, 3000),
        }));
      } catch {
        return [];
      }
    },
  };
}

function rowToRun(row: Record<string, unknown>): SubAgentRun {
  return {
    id: row.id as string,
    parentAgentId: row.parent_agent_id as string,
    parentSessionKey: row.parent_session_key as string,
    childAgentId: row.child_agent_id as string,
    childSessionKey: row.child_session_key as string,
    task: row.task as string,
    status: row.status as SubAgentRun["status"],
    resultText: (row.result_text as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number) ?? null,
  };
}
