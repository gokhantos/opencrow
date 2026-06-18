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
  // Null for autonomous (origin="auto") sessions, which have no human seed.
  readonly seedInput: string | null;
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
  /** Per-agent-role balance scores; keyed by StrategicAgentRole string. */
  readonly agentBalanceScores?: Readonly<Record<string, number>>;
}

export interface ScoredIdea {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly proposedBy: string;
  readonly round: number;
  readonly expertScore: number;
  readonly socialScore?: number;
  readonly fusedScore?: number;
  readonly incentiveBreakdown: IncentiveBreakdown;
}

export interface Coalition {
  readonly id: string;
  readonly members: readonly string[];
  readonly sharedIdeas: readonly string[];
  readonly stability: number;
}

export interface RoundOutcome {
  readonly selectedIdeas: readonly ScoredIdea[];
  readonly eliminatedIdeas: readonly string[];
  readonly coalitions?: readonly Coalition[];
  readonly equilibria?: readonly Equilibrium[];
}

export interface AgentAction {
  readonly agentId: string;
  readonly role: string;
  readonly round: number;
  readonly actionType: string;
  readonly content: string;
  readonly confidence: number;
}

export interface SimulationRound {
  readonly roundNumber: number;
  readonly roundType: string;
  readonly agentActions: readonly AgentAction[];
  readonly outcomes: RoundOutcome;
}

export type CitizenActionType =
  | "adopt"
  | "resist"
  | "remix"
  | "combine"
  | "oppose"
  | "ignore";

export interface SocialSimAction {
  readonly citizenId: string;
  readonly actionType: CitizenActionType;
  readonly targetIdeaId: string;
  readonly content?: string;
  readonly sentiment: number;
}

export interface RemixVariant {
  readonly originalIdeaId: string;
  readonly citizenId: string;
  readonly remixedContent: string;
  readonly adoptionRate: number;
}

export interface SocialSimResult {
  readonly citizenActions: readonly SocialSimAction[];
  readonly adoptionRates: Readonly<Record<string, number>>;
  readonly sentimentDistribution: Readonly<Record<string, number>>;
  readonly remixVariants: readonly RemixVariant[];
}

export interface GameFormulation {
  readonly gameType: string;
  readonly players: readonly Player[];
  readonly moveSequence: string;
}

export interface ExpertGameResult {
  readonly rounds?: readonly SimulationRound[];
  readonly equilibria: readonly Equilibrium[];
  readonly rankedIdeas?: readonly ScoredIdea[];
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
  readonly socialResult?: SocialSimResult;
  readonly fusedScores?: readonly FusedScore[];
}

// SSE event shape
export interface SseStatusEvent {
  readonly type: "status" | "error";
  readonly id?: string;
  readonly status?: SigeSessionStatus;
  readonly message?: string;
}
