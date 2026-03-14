export type ProcessName =
  | "core"
  | "cron"
  | "web"
  | "market"
  | "sige"
  | `agent:${string}`
  | `scraper:${string}`;

export type ProcessStatus = "alive" | "stale" | "dead";

export interface ProcessRecord {
  readonly name: ProcessName;
  readonly pid: number;
  readonly startedAt: number;
  readonly lastHeartbeat: number;
  readonly metadata: Record<string, unknown>;
}

export type CommandAction = "restart" | "stop" | "cron:run_job";

export interface ProcessCommand {
  readonly id: string;
  readonly target: ProcessName;
  readonly action: CommandAction;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
  readonly acknowledgedAt: number | null;
}

export interface CronDelivery {
  readonly id: string;
  readonly channel: string;
  readonly chatId: string;
  readonly jobName: string;
  readonly text: string;
  readonly preformatted: boolean;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}
