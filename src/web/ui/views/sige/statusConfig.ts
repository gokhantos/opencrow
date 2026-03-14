import type { SigeSessionStatus } from "./types";

export const TERMINAL_STATUSES = new Set<SigeSessionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const STATUS_ORDER: readonly SigeSessionStatus[] = [
  "pending",
  "knowledge_construction",
  "game_formulation",
  "expert_game",
  "social_simulation",
  "scoring",
  "report_generation",
  "completed",
];

export const STATUS_LABELS: Record<SigeSessionStatus, string> = {
  pending: "Pending",
  knowledge_construction: "Knowledge Construction",
  game_formulation: "Game Formulation",
  expert_game: "Expert Game",
  social_simulation: "Social Simulation",
  scoring: "Scoring",
  report_generation: "Report Generation",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STATUS_BADGE_STYLES: Record<SigeSessionStatus, string> = {
  pending:
    "bg-bg-3 text-muted border border-border",
  knowledge_construction:
    "bg-accent-subtle text-accent border border-accent/20",
  game_formulation:
    "bg-accent-subtle text-accent border border-accent/20",
  expert_game:
    "bg-warning-subtle text-warning border border-warning/20",
  social_simulation:
    "bg-warning-subtle text-warning border border-warning/20",
  scoring:
    "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  report_generation:
    "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  completed:
    "bg-success-subtle text-success border border-success/20",
  failed:
    "bg-danger-subtle text-danger border border-danger/20",
  cancelled:
    "bg-bg-3 text-muted border border-border",
};

/** Returns progress 0-1 through the active STATUS_ORDER pipeline. */
export function statusProgress(status: SigeSessionStatus): number {
  const idx = STATUS_ORDER.indexOf(status);
  if (idx < 0) return 0;
  return idx / (STATUS_ORDER.length - 1);
}
