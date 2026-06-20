// ─── Game Theory Types ────────────────────────────────────────────────────────

export type GameType =
  | "simultaneous"
  | "sequential"
  | "repeated"
  | "bayesian"
  | "cooperative"
  | "evolutionary"
  | "stackelberg"
  | "signaling"
  | "mechanism_design";

export type StrategicAgentRole =
  | "rational_player"       // equilibrium analysis
  | "mechanism_designer"    // system design
  | "explorer"              // divergent thinking
  | "adversarial"           // stress testing
  | "founder"               // distribution + MVP
  | "user_researcher"       // pain-point grounding
  | "contrarian_investor"   // market sizing + "why now?"
  | "technical_architect"   // feasibility + moat
  | "designer"              // UX + behavioral insight
  | "domain_expert";        // vertical knowledge

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

export type WorkflowTopology =
  | "pipeline"
  | "feedback_loop"
  | "star"
  | "parallel"
  | "hybrid";

export type EquilibriumType =
  | "nash"
  | "pareto"
  | "dominant"
  | "evolutionary_stable"
  | "signaling_separating"
  | "signaling_pooling";

export type CitizenStance = "supportive" | "opposing" | "neutral" | "observer";

export type CitizenActionType =
  | "adopt"
  | "resist"
  | "remix"
  | "combine"
  | "oppose"
  | "ignore";

export type RoundType =
  | "divergent_generation"
  | "strategic_interaction"
  | "evolutionary_tournament"
  | "equilibrium_analysis";

export type RoundNumber = 1 | 2 | 3 | 4;

export type AgentSupportStance = "support" | "oppose" | "neutral";

// ─── Game Formulation ─────────────────────────────────────────────────────────

export interface Player {
  readonly id: string;
  readonly name: string;
  readonly strategySpace: readonly string[];
  readonly payoffFunction: string;
  readonly informationSet: readonly string[];
  readonly privateType?: string;
}

export interface InformationStructure {
  readonly visibility: Readonly<Record<string, readonly string[]>>;
  readonly asymmetries: readonly string[];
  readonly commonKnowledge: readonly string[];
}

export interface Constraint {
  readonly type: "budget" | "legal" | "resource" | "temporal" | "custom";
  readonly description: string;
  readonly affectedPlayers: readonly string[];
}

export interface SignalSpace {
  readonly senderId: string;
  readonly receiverIds: readonly string[];
  readonly signalTypes: readonly string[];
}

export interface PayoffEntry {
  readonly players: Readonly<Record<string, string>>;
  readonly payoffs: Readonly<Record<string, number>>;
}

export interface GameFormulation {
  readonly id: string;
  readonly sessionId: string;
  readonly gameType: GameType;
  readonly players: readonly Player[];
  readonly strategies: Readonly<Record<string, readonly string[]>>;
  readonly payoffMatrix?: readonly PayoffEntry[];
  readonly informationStructure: InformationStructure;
  readonly moveSequence: "simultaneous" | "sequential" | "repeated";
  readonly constraints: readonly Constraint[];
  readonly signalSpaces?: readonly SignalSpace[];
}

// ─── Strategic Agent Profiles ─────────────────────────────────────────────────

export interface AgentPersona {
  readonly name: string;
  readonly background: string;
  /** Range: -1 (fully negative) to 1 (fully positive) */
  readonly sentimentBias: number;
  /** Range: 0 to 1 */
  readonly influenceWeight: number;
  readonly interestedTopics: readonly string[];
  readonly cognitiveStyle: string;
}

export interface EpistemicModel {
  readonly rationalityModel: string;
  readonly beliefDistribution: Readonly<Record<string, number>>;
  readonly levelOfReasoning: number;
}

export interface KnowledgeFilter {
  readonly includedTopics: readonly string[];
  readonly excludedTopics: readonly string[];
  readonly amplifiedEntities: readonly string[];
  readonly attenuatedEntities: readonly string[];
}

export interface StrategicAgentProfile {
  readonly id: string;
  readonly role: StrategicAgentRole;
  readonly persona: AgentPersona;
  readonly strategicType: string;
  readonly reasoningPattern: string;
  readonly epistemicModel: EpistemicModel;
  readonly knowledgeFilter: KnowledgeFilter;
}

// ─── Incentive & Scoring ──────────────────────────────────────────────────────

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

export interface StrategicMetadata {
  readonly equilibriumType?: EquilibriumType;
  readonly paretoOptimal: boolean;
  readonly dominantStrategy: boolean;
  readonly evolutionarilyStable: boolean;
  readonly nashEquilibrium: boolean;
  readonly supportingCoalition?: readonly string[];
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
  readonly strategicMetadata: StrategicMetadata;
}

export interface FusedScore {
  readonly ideaId: string;
  readonly expertScore: number;
  readonly socialScore: number;
  readonly fusedScore: number;
  /** Blending coefficient between expert and social scores */
  readonly alpha: number;
  readonly breakdown: IncentiveBreakdown;
}

// ─── Expert Game Simulation ───────────────────────────────────────────────────

export interface AgentAction {
  readonly agentId: string;
  readonly role: StrategicAgentRole;
  readonly round: number;
  readonly actionType: string;
  readonly content: string;
  readonly confidence: number;
  readonly targetIdeas?: readonly string[];
  readonly reasoning: string;
}

export interface Coalition {
  readonly id: string;
  readonly members: readonly string[];
  readonly sharedIdeas: readonly string[];
  readonly stability: number;
  readonly shapleyValues: Readonly<Record<string, number>>;
}

export interface Equilibrium {
  readonly type: EquilibriumType;
  readonly ideas: readonly string[];
  readonly stability: number;
  readonly description: string;
}

export interface RoundOutcome {
  readonly selectedIdeas: readonly ScoredIdea[];
  readonly eliminatedIdeas: readonly string[];
  readonly coalitions?: readonly Coalition[];
  readonly equilibria?: readonly Equilibrium[];
}

export interface SimulationRound {
  readonly roundNumber: RoundNumber;
  readonly roundType: RoundType;
  readonly agentActions: readonly AgentAction[];
  readonly outcomes: RoundOutcome;
}

export interface MetaGameHealth {
  readonly agentBalanceScores: Readonly<Record<StrategicAgentRole, number>>;
  readonly diversityIndex: number;
  readonly convergenceRate: number;
  readonly noveltyScore: number;
}

export interface ExpertGameResult {
  readonly rounds: readonly SimulationRound[];
  readonly equilibria: readonly Equilibrium[];
  readonly rankedIdeas: readonly ScoredIdea[];
  readonly metaGameHealth: MetaGameHealth;
}

// ─── Social Simulation ────────────────────────────────────────────────────────

export interface CitizenAgent {
  readonly id: string;
  readonly persona: string;
  readonly age: number;
  readonly profession: string;
  readonly sentimentBias: number;
  readonly stance: CitizenStance;
  readonly activityLevel: number;
  readonly influenceWeight: number;
}

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
  readonly emergentOpposition: readonly string[];
}

// ─── Report ───────────────────────────────────────────────────────────────────

export interface IdeaAnalysis {
  readonly idea: ScoredIdea;
  readonly gameContext: string;
  readonly equilibriumMembership: readonly string[];
  readonly agentSupport: Readonly<Record<string, AgentSupportStance>>;
  readonly socialReception: string;
}

export interface SigeReport {
  readonly executiveSummary: string;
  readonly topIdeas: readonly ScoredIdea[];
  readonly perIdeaAnalysis: readonly IdeaAnalysis[];
  readonly opportunityMap: string;
  readonly riskAssessment: string;
  readonly metaGameHealth: MetaGameHealth;
  readonly recommendedNextSession: string;
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface IncentiveWeights {
  readonly diversity: number;
  readonly building: number;
  readonly surprise: number;
  readonly accuracyPenalty: number;
  readonly socialViability: number;
}

export interface SigeSessionConfig {
  readonly expertRounds: number;
  readonly socialAgentCount: number;
  readonly socialRounds: number;
  readonly maxConcurrentAgents: number;
  /** Blending coefficient for fused scoring (0 = pure expert, 1 = pure social) */
  readonly alpha: number;
  readonly incentiveWeights: IncentiveWeights;
  readonly provider: "openrouter" | "agent-sdk" | "alibaba" | "anthropic" | "opencode";
  readonly model: string;
  readonly agentModel: string;
}

/** Origin of a SIGE session: human-initiated or autonomously scheduled. */
export type SigeSessionOrigin = "human" | "auto";

export interface SigeSession {
  readonly id: string;
  /** Seed input text. Optional: absent for autonomous (seedless) sessions. */
  readonly seedInput?: string;
  /** Who created the session. Defaults to 'human' for pre-019 rows via rowToSession. */
  readonly origin: SigeSessionOrigin;
  /** Inferred run mode: 'seeded' when seedInput is present, 'autonomous' otherwise. */
  readonly mode?: "seeded" | "autonomous";
  readonly status: SigeSessionStatus;
  readonly config: SigeSessionConfig;
  readonly gameFormulation?: GameFormulation;
  readonly expertResult?: ExpertGameResult;
  readonly socialResult?: SocialSimResult;
  readonly fusedScores?: readonly FusedScore[];
  readonly report?: string;
  readonly createdAt: Date;
  readonly finishedAt?: Date;
  /** Epoch seconds of the most recent activity touch. NULL for pre-migration rows. */
  readonly lastActivityAt?: number;
  readonly error?: string;
}

// ─── Session Summary (list endpoint — heavy JSON columns excluded) ────────────

/**
 * Light-weight projection of a SIGE session for list endpoints.
 * Omits the heavy JSON artifact columns (`gameFormulation`, `expertResult`,
 * `socialResult`, `fusedScores`, `report`) that are only needed by the detail
 * view. The detail view fetches a full `SigeSession` separately.
 */
export interface SigeSessionSummary {
  readonly id: string;
  /** Seed input text. Absent for autonomous (seedless) sessions. */
  readonly seedInput?: string;
  /** Who created the session. */
  readonly origin: SigeSessionOrigin;
  readonly status: SigeSessionStatus;
  readonly config: SigeSessionConfig;
  readonly createdAt: Date;
  readonly finishedAt?: Date;
  /** Epoch seconds of the most recent activity touch. Absent for pre-migration rows. */
  readonly lastActivityAt?: number;
  readonly error?: string;
}

// ─── Ideas Aggregation ────────────────────────────────────────────────────────

/**
 * A single idea flattened from a SIGE run's expert-game rounds.
 * One record per unique (runId, ideaId) pair — the highest round the idea
 * reached is kept. Ideas that received a fused score are marked `isFinal`.
 */
export interface AggregatedIdea {
  readonly ideaId: string;
  readonly title: string;
  readonly description: string;
  readonly proposedBy: string;
  /** Highest expert-game round this idea appeared in (1–4). */
  readonly round: number;
  /** The round type of the highest round this idea appeared in. */
  readonly roundType: RoundType;
  readonly expertScore: number;
  /** Null when no social simulation was run for this run. */
  readonly socialScore: number | null;
  /** Null when no fused scoring was run for this run. */
  readonly fusedScore: number | null;
  /**
   * True when this idea has a corresponding FusedScore entry — meaning it
   * survived all expert-game rounds and received a final blended score.
   */
  readonly isFinal: boolean;
  /** Null for non-final ideas (no fused score was computed). */
  readonly breakdown: IncentiveBreakdown | null;
  readonly runId: string;
  readonly runSeed: string | null;
  readonly runOrigin: SigeSessionOrigin;
  readonly runStatus: SigeSessionStatus;
  readonly runCreatedAt: Date;
}

/**
 * Summary of a SIGE run for populating a filter dropdown.
 * Counts are derived from the aggregated ideas, not from re-querying the DB.
 */
export interface RunSummary {
  readonly runId: string;
  readonly seed: string | null;
  readonly origin: SigeSessionOrigin;
  readonly status: SigeSessionStatus;
  readonly createdAt: Date;
  /** Total number of unique ideas extracted from this run. */
  readonly ideaCount: number;
  /** Number of those ideas that have a fused score (isFinal). */
  readonly finalCount: number;
}
