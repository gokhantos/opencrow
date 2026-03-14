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
  | "rational_player"
  | "boundedly_rational"
  | "cooperative"
  | "adversarial"
  | "evolutionary"
  | "mechanism_designer"
  | "explorer"
  | "contrarian"
  | "signaler"
  | "abductive_reasoner";

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
  readonly provider: "openrouter" | "agent-sdk" | "alibaba";
  readonly model: string;
  readonly agentModel: string;
}

export interface SigeSession {
  readonly id: string;
  readonly seedInput: string;
  readonly status: SigeSessionStatus;
  readonly config: SigeSessionConfig;
  readonly gameFormulation?: GameFormulation;
  readonly expertResult?: ExpertGameResult;
  readonly socialResult?: SocialSimResult;
  readonly fusedScores?: readonly FusedScore[];
  readonly report?: string;
  readonly createdAt: Date;
  readonly finishedAt?: Date;
  readonly error?: string;
}
