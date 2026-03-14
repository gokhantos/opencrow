import { createLogger } from "../logger"
import type { IncentiveBreakdown, IncentiveWeights, ScoredIdea } from "./types"

const log = createLogger("sige:incentives")

// ─── Context ──────────────────────────────────────────────────────────────────

export interface IncentiveContext {
  readonly allIdeas: readonly ScoredIdea[]
  readonly priorIdeas?: readonly ScoredIdea[]
  readonly socialViabilityScore: number
  readonly weights: IncentiveWeights
  readonly agentCredibilityScores?: Readonly<Record<string, number>>
}

// ─── Tokenization Helpers ─────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  )
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0

  let intersectionSize = 0
  for (const token of a) {
    if (b.has(token)) intersectionSize++
  }

  const unionSize = a.size + b.size - intersectionSize
  return unionSize > 0 ? intersectionSize / unionSize : 0
}

function ideaTokens(idea: ScoredIdea): Set<string> {
  return tokenize(`${idea.title} ${idea.description}`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ─── Individual Incentive Functions ───────────────────────────────────────────

/**
 * Reward ideas that are semantically distant from other ideas.
 * Uses average Jaccard distance from the centroid word set.
 */
export function diversityBonus(
  idea: ScoredIdea,
  allIdeas: readonly ScoredIdea[],
): number {
  const others = allIdeas.filter((i) => i.id !== idea.id)
  if (others.length === 0) return 0.5

  const ideaToks = ideaTokens(idea)

  const avgSimilarity =
    others.reduce((sum, other) => sum + jaccardSimilarity(ideaToks, ideaTokens(other)), 0) /
    others.length

  // Distance = 1 - similarity; higher distance = higher bonus
  return clamp(1 - avgSimilarity, 0, 1)
}

/**
 * Reward ideas that build on prior validated ideas.
 * Checks word overlap with prior winning ideas (those with high fused scores).
 */
export function buildingBonus(
  idea: ScoredIdea,
  priorIdeas: readonly ScoredIdea[],
): number {
  if (priorIdeas.length === 0) return 0

  const HIGH_SCORE_THRESHOLD = 0.6
  const winningPrior = priorIdeas.filter(
    (p) => (p.fusedScore ?? p.expertScore) >= HIGH_SCORE_THRESHOLD,
  )
  if (winningPrior.length === 0) return 0

  const ideaToks = ideaTokens(idea)
  const maxSimilarity = winningPrior.reduce(
    (max, prior) => Math.max(max, jaccardSimilarity(ideaToks, ideaTokens(prior))),
    0,
  )

  return clamp(maxSimilarity, 0, 1)
}

/**
 * Reward ideas far from expected/obvious strategies.
 * Inverse of average similarity to all other ideas.
 */
export function surpriseBonus(
  idea: ScoredIdea,
  allIdeas: readonly ScoredIdea[],
): number {
  const others = allIdeas.filter((i) => i.id !== idea.id)
  if (others.length === 0) return 0.5

  const ideaToks = ideaTokens(idea)
  const avgSimilarity =
    others.reduce((sum, other) => sum + jaccardSimilarity(ideaToks, ideaTokens(other)), 0) /
    others.length

  // Ideas that stand alone (low avg similarity) get higher surprise scores
  return clamp(1 - avgSimilarity, 0, 1)
}

/**
 * Penalize ideas that conflict with known constraints.
 * Based on strategic metadata stability and feasibility flags.
 */
export function accuracyPenalty(idea: ScoredIdea): number {
  const meta = idea.strategicMetadata
  let penalty = 0

  // Penalize ideas that are not evolutionarily stable
  if (!meta.evolutionarilyStable) penalty += 0.2

  // Penalize ideas that are not Pareto optimal and not Nash equilibria
  if (!meta.paretoOptimal && !meta.nashEquilibrium) penalty += 0.3

  // Penalize dominant strategy violations (dominant = over-simplistic signal)
  if (meta.dominantStrategy) penalty += 0.1

  return clamp(penalty, 0, 1)
}

/**
 * Reward agents that successfully apply patterns from past sessions.
 * Similarity to past successful ideas (those with high fused scores).
 */
export function memoryReward(
  idea: ScoredIdea,
  priorIdeas: readonly ScoredIdea[],
): number {
  if (priorIdeas.length === 0) return 0

  const HIGH_SCORE_THRESHOLD = 0.65
  const successfulPrior = priorIdeas.filter(
    (p) => (p.fusedScore ?? p.expertScore) >= HIGH_SCORE_THRESHOLD,
  )
  if (successfulPrior.length === 0) return 0

  const ideaToks = ideaTokens(idea)
  const avgSimilarity =
    successfulPrior.reduce(
      (sum, prior) => sum + jaccardSimilarity(ideaToks, ideaTokens(prior)),
      0,
    ) / successfulPrior.length

  return clamp(avgSimilarity, 0, 1)
}

/**
 * Score based on the stability of the idea's supporting coalition.
 */
export function coalitionStability(idea: ScoredIdea): number {
  const meta = idea.strategicMetadata

  // No coalition data available
  if (!meta.supportingCoalition || meta.supportingCoalition.length === 0) {
    return 0.3
  }

  // A larger, more stable coalition signals stronger support
  // Normalize coalition size: 1 member = 0.3, 5+ members = 1.0
  const coalitionSize = meta.supportingCoalition.length
  const sizeScore = clamp(coalitionSize / 5, 0, 1)

  // Boost for Nash or Pareto stability
  const stabilityBoost = meta.nashEquilibrium ? 0.2 : meta.paretoOptimal ? 0.1 : 0

  return clamp(sizeScore + stabilityBoost, 0, 1)
}

/**
 * Track agent reliability via credibility history.
 * Returns 0.5 for unknown agents as a neutral default.
 */
export function signalCredibility(
  agentId: string,
  credibilityScores: Readonly<Record<string, number>>,
): number {
  const score = credibilityScores[agentId]
  if (score === undefined) return 0.5
  return clamp(score, 0, 1)
}

/**
 * Apply all incentives to compute a final adjusted score.
 * Formula: baseScore + sum(bonus_i * weight_i) - sum(penalty_i * weight_i),
 * clamped to [0, 1].
 */
export function applyIncentives(
  baseScore: number,
  breakdown: IncentiveBreakdown,
  weights: IncentiveWeights,
): number {
  const bonuses =
    breakdown.diversityBonus * weights.diversity +
    breakdown.buildingBonus * weights.building +
    breakdown.surpriseBonus * weights.surprise +
    breakdown.socialViability * weights.socialViability

  const penalties = breakdown.accuracyPenalty * weights.accuracyPenalty

  const adjusted = baseScore + bonuses - penalties
  return clamp(adjusted, 0, 1)
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Compute the full incentive breakdown for a single idea within its session context.
 */
export function computeIncentives(
  idea: ScoredIdea,
  context: IncentiveContext,
): IncentiveBreakdown {
  const { allIdeas, priorIdeas = [], agentCredibilityScores = {} } = context

  log.debug("Computing incentives", { ideaId: idea.id, allIdeasCount: allIdeas.length })

  return {
    diversityBonus: diversityBonus(idea, allIdeas),
    buildingBonus: buildingBonus(idea, priorIdeas),
    surpriseBonus: surpriseBonus(idea, allIdeas),
    accuracyPenalty: accuracyPenalty(idea),
    memoryReward: memoryReward(idea, priorIdeas),
    coalitionStability: coalitionStability(idea),
    signalCredibility: signalCredibility(idea.proposedBy, agentCredibilityScores),
    socialViability: clamp(context.socialViabilityScore, 0, 1),
  }
}

// ─── Auto-Balancing ───────────────────────────────────────────────────────────

export interface AutoBalancingInput {
  readonly diversityIndex: number
  readonly dominantAgentRole?: string
  readonly socialExpertDivergence: number
}

/**
 * Compute recommended weight adjustments based on session results.
 * Returns only the weights that should change; caller merges with existing config.
 */
export function computeAutoBalancing(
  sessionResults: AutoBalancingInput,
): Partial<IncentiveWeights> {
  // Build each conditional adjustment then compose a single immutable partial
  const diversityAdjustment: Partial<IncentiveWeights> =
    sessionResults.diversityIndex < 0.3
      ? { diversity: 0.25, surprise: 0.15 }
      : {}

  const socialAdjustment: Partial<IncentiveWeights> =
    sessionResults.socialExpertDivergence > 0.4
      ? { socialViability: 0.1 }
      : {}

  const buildingAdjustment: Partial<IncentiveWeights> =
    sessionResults.dominantAgentRole !== undefined
      ? { building: 0.05 }
      : {}

  const adjustments: Partial<IncentiveWeights> = {
    ...diversityAdjustment,
    ...socialAdjustment,
    ...buildingAdjustment,
  }

  log.debug("Auto-balancing adjustments computed", {
    diversityIndex: sessionResults.diversityIndex,
    adjustments,
  })

  return adjustments
}
