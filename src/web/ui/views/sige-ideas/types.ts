/**
 * Frontend-facing types for the SIGE Ideas aggregation page.
 * Mirror the backend AggregatedIdea / RunSummary shapes from src/sige/types.ts,
 * kept minimal — only what the UI actually renders.
 */

import type { SigeSessionStatus } from "../sige/types";
import type { IncentiveBreakdown } from "../sige/types";

export type { SigeSessionStatus, IncentiveBreakdown };

export type RoundType =
  | "divergent_generation"
  | "strategic_interaction"
  | "evolutionary_tournament"
  | "equilibrium_analysis";

export type SigeSessionOrigin = "human" | "auto";

/**
 * A single idea flattened from a SIGE run's expert-game rounds.
 * The API serialises Date fields as ISO 8601 strings.
 */
export interface AggregatedIdea {
  readonly ideaId: string;
  readonly title: string;
  readonly description: string;
  readonly proposedBy: string;
  readonly round: number;
  readonly roundType: RoundType;
  readonly expertScore: number;
  readonly socialScore: number | null;
  readonly fusedScore: number | null;
  readonly isFinal: boolean;
  readonly breakdown: IncentiveBreakdown | null;
  readonly runId: string;
  readonly runSeed: string | null;
  readonly runOrigin: SigeSessionOrigin;
  readonly runStatus: SigeSessionStatus;
  readonly runCreatedAt: string; // ISO 8601 from JSON
}

/** Summary of a SIGE run for the filter dropdown. */
export interface RunSummary {
  readonly runId: string;
  readonly seed: string | null;
  readonly origin: SigeSessionOrigin;
  readonly status: SigeSessionStatus;
  readonly createdAt: string; // ISO 8601 from JSON
  readonly ideaCount: number;
  readonly finalCount: number;
}

export interface IdeasResponse {
  readonly success: true;
  readonly data: {
    readonly ideas: readonly AggregatedIdea[];
    readonly runs: readonly RunSummary[];
  };
}

/** Client-side filter state persisted to localStorage. */
export interface FilterState {
  readonly finalOnly: boolean;
  readonly runId: string; // "" = all
  readonly minScore: number; // 0 = no minimum
  readonly roundFilter: number; // 0 = all, 1–4 = specific round
  readonly sortMode: "score" | "newest";
  readonly search: string;
  readonly limit: number;
}

export const DEFAULT_FILTER_STATE: FilterState = {
  finalOnly: false,
  runId: "",
  minScore: 0,
  roundFilter: 0,
  sortMode: "score",
  search: "",
  limit: 25,
};
