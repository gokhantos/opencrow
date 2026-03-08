export type CronSchedule =
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "every"; readonly everyMs: number }
  | { readonly kind: "cron"; readonly expr: string; readonly tz?: string };

export type IdeaGenMode = "pipeline" | "full";

export interface CronPayload {
  readonly kind: "agentTurn" | "internal";
  readonly message?: string;
  readonly agentId?: string;
  readonly timeoutSeconds?: number;
  readonly handler?: string; // For internal handlers (e.g., "scoring-engine")
  readonly mode?: IdeaGenMode; // For idea-gen agents: pipeline (default) or full
}

export interface CronDelivery {
  readonly mode: "none" | "announce";
  readonly channel?: string;
  readonly chatId?: string;
}

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly deleteAfterRun: boolean;
  readonly priority: number;
  readonly schedule: CronSchedule;
  readonly payload: CronPayload;
  readonly delivery: CronDelivery;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CronProgressEntry {
  readonly type:
    | "thinking"
    | "tool_start"
    | "tool_done"
    | "iteration"
    | "subagent_start"
    | "subagent_done";
  readonly text: string;
  readonly ts: number;
}

export interface CronRunRecord {
  readonly id: string;
  readonly jobId: string;
  readonly status: "running" | "ok" | "error" | "timeout";
  readonly resultSummary: string | null;
  readonly error: string | null;
  readonly durationMs: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly progress: readonly CronProgressEntry[] | null;
}

export interface CronJobCreate {
  readonly name: string;
  readonly schedule: CronSchedule;
  readonly payload: CronPayload;
  readonly delivery?: CronDelivery;
  readonly enabled?: boolean;
  readonly deleteAfterRun?: boolean;
  readonly priority?: number;
}

export interface CronJobPatch {
  readonly name?: string;
  readonly schedule?: CronSchedule;
  readonly payload?: CronPayload;
  readonly delivery?: CronDelivery;
  readonly enabled?: boolean;
  readonly deleteAfterRun?: boolean;
  readonly priority?: number;
}
