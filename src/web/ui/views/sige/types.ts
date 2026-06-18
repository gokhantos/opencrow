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

// ─── Agent action ledger types (GET /api/sige/sessions/:id/actions) ──────────

export interface AgentActionRecord {
  readonly agentId: string;
  readonly role: string;
  readonly round: number;
  readonly actionType: string;
  /** Raw JSON string as stored in DB — parse defensively, may be truncated. */
  readonly content: string;
  readonly confidence: number;
  readonly score: number | null;
  readonly targetIdeas: readonly string[];
  readonly reasoning: string;
  readonly createdAt: number; // epoch seconds, Number()-converted
}

export interface RoundArtifacts {
  readonly equilibria?: readonly unknown[];
  readonly coalitions?: readonly unknown[];
  readonly metagameHealth?: unknown;
  readonly tasteFilter?: unknown;
}

export interface RoundLedger {
  readonly round: number;
  readonly actions: readonly AgentActionRecord[];
  readonly artifacts: RoundArtifacts | null;
}

// ─── Step-monitor progress types (GET /api/sige/sessions/:id/progress) ─────────

export type StepKey =
  | "knowledge_construction"
  | "game_formulation"
  | "expert_game"
  | "social_simulation"
  | "scoring"
  | "report_generation";

export type SubstepState = "waiting" | "running" | "done" | "error";

export interface ProgressSubstep {
  readonly key: string;
  readonly label: string;
  readonly state: SubstepState;
  readonly startedAt: number | null; // epoch seconds
  readonly endedAt: number | null;
  readonly elapsedSec: number | null;
  readonly detail: string | null;
}

export interface ProgressStep {
  readonly key: StepKey;
  readonly label: string;
  readonly state: SubstepState;
  readonly startedAt: number | null; // epoch seconds
  readonly endedAt: number | null;
  readonly elapsedSec: number | null;
  readonly substeps: readonly ProgressSubstep[];
}

export interface SessionProgress {
  readonly sessionId: string;
  readonly status: SigeSessionStatus;
  readonly origin: "human" | "auto";
  readonly createdAt: number; // epoch seconds
  readonly finishedAt: number | null;
  /** Epoch seconds of the most recent heartbeat. */
  readonly lastActivityAt: number | null;
  readonly totalElapsedSec: number;
  /** True when status is non-terminal AND now - lastActivityAt > threshold. */
  readonly stalled: boolean;
  readonly stalledForSec: number | null;
  readonly stalledReason: string | null;
  readonly currentStep: string | null;
  readonly currentSubstep: string | null;
  readonly error: string | null;
  readonly steps: readonly ProgressStep[];
}
