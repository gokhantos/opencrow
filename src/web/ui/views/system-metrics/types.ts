// ============================================================================
// SystemMetrics — shared types and design tokens
// ============================================================================

export interface DiskInfo {
  readonly filesystem: string;
  readonly mount: string;
  readonly total: number;
  readonly used: number;
  readonly available: number;
  readonly percentage: number;
}

export interface SystemMetricsData {
  readonly timestamp: number;
  readonly cpu: {
    readonly usage: number;
    readonly loadAvg: [number, number, number];
  };
  readonly memory: {
    readonly total: number;
    readonly used: number;
    readonly free: number;
    readonly available: number;
    readonly percentage: number;
  };
  readonly disk: readonly DiskInfo[];
  readonly processes: ReadonlyArray<{
    readonly pid: number;
    readonly name: string;
    readonly cpu: number;
    readonly memory: number;
    readonly memoryMB: number;
  }>;
}

// ============================================================================
// Design tokens (shared across chart options and components)
// ============================================================================

export const C = {
  teal: "#2dd4bf",
  purple: "#a78bfa",
  deepPurple: "#7928ca",
  amber: "#f5a623",
  red: "#f87171",
  blue: "#3b82f6",
  border: "rgba(255,255,255,0.06)",
  borderHover: "rgba(255,255,255,0.12)",
  cardBg: "rgba(19, 19, 22, 0.65)",
  tooltipBg: "rgba(10, 10, 14, 0.95)",
} as const;

// ============================================================================
// Helpers
// ============================================================================

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Convert 6-digit hex to rgba string */
export function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
