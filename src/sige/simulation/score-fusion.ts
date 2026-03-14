import { createLogger } from "../../logger"
import type {
  FusedScore,
  IncentiveBreakdown,
  ScoredIdea,
  SocialSimResult,
} from "../types"

const log = createLogger("sige:score-fusion")

// ─── Social Score Weights ─────────────────────────────────────────────────────

const ADOPTION_WEIGHT = 0.5
const SENTIMENT_WEIGHT = 0.3
const REMIX_WEIGHT = 0.2

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Computes a 0-1 social viability score for a single idea based on its
 * adoption rate, sentiment distribution, and remix frequency.
 */
export function computeSocialViabilityScore(
  ideaId: string,
  socialResult: SocialSimResult,
): number {
  const adoption = socialResult.adoptionRates[ideaId] ?? 0
  const rawSentiment = socialResult.sentimentDistribution[ideaId] ?? 0

  // Normalize sentiment from [-1, 1] to [0, 1]
  const normalizedSentiment = (rawSentiment + 1) / 2

  const totalActions = socialResult.citizenActions.length
  const remixCount = socialResult.citizenActions.filter(
    (a) => a.targetIdeaId === ideaId && a.actionType === "remix",
  ).length
  const remixFrequency = totalActions > 0 ? remixCount / totalActions : 0

  const raw =
    ADOPTION_WEIGHT * adoption +
    SENTIMENT_WEIGHT * normalizedSentiment +
    REMIX_WEIGHT * remixFrequency

  return clamp(raw, 0, 1)
}

/**
 * Fuses expert and social scores for each idea.
 *
 * fused = alpha * expertScore + (1 - alpha) * socialScore
 *
 * Results are sorted by fused score descending.
 */
export function fuseScores(
  expertIdeas: readonly ScoredIdea[],
  socialResult: SocialSimResult,
  alpha: number,
): readonly FusedScore[] {
  log.debug("Fusing expert and social scores", { ideaCount: expertIdeas.length, alpha })

  const clampedAlpha = clamp(alpha, 0, 1)

  // Compute raw social scores for all ideas
  const rawSocialScores = expertIdeas.map((idea) => ({
    ideaId: idea.id,
    raw: computeSocialViabilityScore(idea.id, socialResult),
  }))

  // Normalize social scores across the set to [0, 1]
  const normalizedSocialScores = normalizeScores(rawSocialScores)

  const fused: FusedScore[] = expertIdeas.map((idea) => {
    const expertScore = clamp(idea.expertScore, 0, 1)
    const socialScore = normalizedSocialScores[idea.id] ?? 0
    const fusedScore =
      clampedAlpha * expertScore + (1 - clampedAlpha) * socialScore

    const breakdown = buildIncentiveBreakdown(idea, socialScore)

    return {
      ideaId: idea.id,
      expertScore,
      socialScore,
      fusedScore: parseFloat(fusedScore.toFixed(6)),
      alpha: clampedAlpha,
      breakdown,
    }
  })

  return fused.sort((a, b) => b.fusedScore - a.fusedScore)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RawScore {
  readonly ideaId: string
  readonly raw: number
}

/**
 * Min-max normalizes scores to [0, 1].
 * If all scores are equal, returns 0.5 for each entry.
 */
function normalizeScores(
  scores: readonly RawScore[],
): Readonly<Record<string, number>> {
  if (scores.length === 0) return {}

  const values = scores.map((s) => s.raw)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min

  return Object.fromEntries(
    scores.map(({ ideaId, raw }) => [
      ideaId,
      range > 0 ? (raw - min) / range : 0.5,
    ]),
  )
}

/**
 * Builds an IncentiveBreakdown for a fused idea.
 * Phase 6 will fill in the real incentive computations — these are placeholders.
 */
function buildIncentiveBreakdown(
  idea: ScoredIdea,
  socialScore: number,
): IncentiveBreakdown {
  return {
    diversityBonus: idea.incentiveBreakdown.diversityBonus,
    buildingBonus: idea.incentiveBreakdown.buildingBonus,
    surpriseBonus: idea.incentiveBreakdown.surpriseBonus,
    accuracyPenalty: idea.incentiveBreakdown.accuracyPenalty,
    memoryReward: idea.incentiveBreakdown.memoryReward,
    coalitionStability: idea.incentiveBreakdown.coalitionStability,
    signalCredibility: idea.incentiveBreakdown.signalCredibility,
    socialViability: parseFloat(socialScore.toFixed(6)),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
