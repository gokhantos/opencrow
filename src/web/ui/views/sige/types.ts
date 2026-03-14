// Frontend-facing SIGE types mirroring src/sige/types.ts
// Kept minimal — only what the UI actually renders.

export type SigeSessionStatus =
  | "pending"
  | "knowledge_construction"
  | "game_formulation"
  | "expert_game"
  | "social_simulation"
  | "scoring"
  | "report_generation"
  | "completed"
  | "failed"
  | "cancelled";

export interface SigeSessionConfig {
  readonly expertRounds: number;
  readonly socialAgentCount: number;
  readonly socialRounds: number;
  readonly maxConcurrentAgents: number;
  readonly alpha: number;
  readonly model: string;
  readonly agentModel: string;
}

export interface SigeSession {
  readonly id: string;
  readonly seedInput: string;
  readonly status: SigeSessionStatus;
  readonly config: SigeSessionConfig;
  readonly report?: string;
  readonly createdAt: string; // ISO string from JSON serialization
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface IncentiveBreakdown {
  readonly diversityBonus: number;
  readonly buildingBonus: number;
  readonly surpriseBonus: number;
  readonly accuracyPenalty: number;
  readonly memoryReward: number;
  readonly coalitionStability: number;
  readonly signalCredibility: number;
  readonly socialViability: number;
}

export interface FusedScore {
  readonly ideaId: string;
  readonly expertScore: number;
  readonly socialScore: number;
  readonly fusedScore: number;
  readonly alpha: number;
  readonly breakdown: IncentiveBreakdown;
}

export interface Player {
  readonly id: string;
  readonly name: string;
  readonly strategySpace: readonly string[];
  readonly payoffFunction: string;
}

export type EquilibriumType =
  | "nash"
  | "pareto"
  | "dominant"
  | "evolutionary_stable"
  | "signaling_separating"
  | "signaling_pooling";

export interface Equilibrium {
  readonly type: EquilibriumType;
  readonly ideas: readonly string[];
  readonly stability: number;
  readonly description: string;
}

export interface MetaGameHealth {
  readonly diversityIndex: number;
  readonly convergenceRate: number;
  readonly noveltyScore: number;
}

export interface GameFormulation {
  readonly gameType: string;
  readonly players: readonly Player[];
  readonly moveSequence: string;
}

export interface ExpertGameResult {
  readonly equilibria: readonly Equilibrium[];
  readonly metaGameHealth: MetaGameHealth;
}

export interface PopulationEntry {
  readonly strategy: string;
  readonly fitness: number;
  readonly generation: number;
}

export interface SigeSessionDetail extends SigeSession {
  readonly gameFormulation?: GameFormulation;
  readonly expertResult?: ExpertGameResult;
  readonly fusedScores?: readonly FusedScore[];
}

// SSE event shape
export interface SseStatusEvent {
  readonly type: "status" | "error";
  readonly id?: string;
  readonly status?: SigeSessionStatus;
  readonly message?: string;
}
