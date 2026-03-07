export type AlertLevel = "critical" | "warning" | "info";

export type CheckCategory =
  | "process"
  | "error_rate"
  | "disk"
  | "cron"
  | "memory";

export interface CheckResult {
  readonly category: CheckCategory;
  readonly level: AlertLevel;
  readonly title: string;
  readonly detail: string;
  readonly metric?: number;
  readonly threshold?: number;
}

export interface MonitorThresholds {
  readonly processHeartbeatStaleSec: number;
  readonly errorCountWindow: number;
  readonly errorRatePercent: number;
  readonly errorWindowMinutes: number;
  readonly diskUsagePercent: number;
  readonly memoryUsagePercent: number;
  readonly cronConsecutiveFailures: number;
}

export interface MonitorConfig {
  readonly checkIntervalMs: number;
  readonly alertCooldownMs: number;
  readonly thresholds: MonitorThresholds;
}

export interface FiredAlert {
  readonly id: string;
  readonly category: CheckCategory;
  readonly level: AlertLevel;
  readonly title: string;
  readonly detail: string;
  readonly metric: number | null;
  readonly threshold: number | null;
  readonly firedAt: number;
  readonly resolvedAt: number | null;
}

export interface DedupEntry {
  readonly lastFiredAt: number;
  readonly level: AlertLevel;
  readonly consecutiveCount: number;
}
