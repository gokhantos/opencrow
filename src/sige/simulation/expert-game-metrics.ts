import type { StrategicAgentDefinition } from "../strategic-agents"
import type {
  MetaGameHealth,
  SimulationRound,
  StrategicAgentRole,
} from "../types"

// ─── Abort Signal ─────────────────────────────────────────────────────────────

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Expert game simulation aborted")
  }
}

// ─── First-Class Dissent ──────────────────────────────────────────────────────

/**
 * Roles whose disagreement is treated as FIRST-CLASS dissent rather than noise:
 * the red-team (adversarial) and the contrarian VC. When these personas score
 * an idea far from the rest of the panel, that's a polarizing-idea signal the
 * mean-pool would otherwise wash out.
 */
const DISSENT_ROLES: ReadonlySet<StrategicAgentRole> = new Set([
  "adversarial",
  "contrarian_investor",
])

/** A single raw per-agent score for an idea, keyed by normalized title. */
interface RawAgentScore {
  readonly role: StrategicAgentRole
  readonly titleKey: string
  readonly score: number
}

/**
 * Parse every per-agent idea score emitted across the rounds. Reads the SAME
 * `evaluations[]` (round 2/3) and `finalRankings[]` (round 4) shapes the
 * existing extractors consume, but keeps the proposer ROLE attached so we can
 * separate dissenters from consensus. PURE.
 */
function extractRawAgentScores(
  rounds: readonly SimulationRound[],
): readonly RawAgentScore[] {
  const out: RawAgentScore[] = []
  for (const round of rounds) {
    for (const action of round.agentActions) {
      let parsed: unknown
      try {
        parsed = JSON.parse(action.content)
      } catch {
        continue
      }
      if (typeof parsed !== "object" || parsed === null) continue
      const raw = parsed as Record<string, unknown>

      const evals = Array.isArray(raw.evaluations) ? raw.evaluations : []
      for (const ev of evals) {
        if (typeof ev !== "object" || ev === null) continue
        const e = ev as Record<string, unknown>
        const id = typeof e.ideaId === "string" ? e.ideaId.trim() : ""
        if (!id || typeof e.score !== "number") continue
        out.push({
          role: action.role,
          titleKey: id.toLowerCase(),
          score: Math.max(0, Math.min(1, e.score)),
        })
      }

      const rankings = Array.isArray(raw.finalRankings) ? raw.finalRankings : []
      for (const r of rankings) {
        if (typeof r !== "object" || r === null) continue
        const rank = r as Record<string, unknown>
        const id = typeof rank.ideaId === "string" ? rank.ideaId.trim() : ""
        if (!id || typeof rank.score !== "number") continue
        out.push({
          role: action.role,
          titleKey: id.toLowerCase(),
          score: Math.max(0, Math.min(1, rank.score)),
        })
      }
    }
  }
  return out
}

/**
 * Compute a first-class dissent term in [0,1] per normalized title.
 *
 * Dissent = |mean(dissenter scores) − mean(consensus scores)| where dissenters
 * are the red-team / contrarian personas and consensus is everyone else. When an
 * idea has scores from only one camp we fall back to the score SPREAD (max−min)
 * of whatever scores exist, so a sharply-split panel still surfaces. Returns an
 * empty map when no scores are present (the field is then omitted upstream).
 *
 * PURE — no I/O, no clock, no rng — and fully unit-testable.
 */
export function computeDissentByTitle(
  rounds: readonly SimulationRound[],
): ReadonlyMap<string, number> {
  const scores = extractRawAgentScores(rounds)

  const dissenterByTitle = new Map<string, number[]>()
  const consensusByTitle = new Map<string, number[]>()
  const allByTitle = new Map<string, number[]>()

  for (const s of scores) {
    const bucket = DISSENT_ROLES.has(s.role) ? dissenterByTitle : consensusByTitle
    bucket.set(s.titleKey, [...(bucket.get(s.titleKey) ?? []), s.score])
    allByTitle.set(s.titleKey, [...(allByTitle.get(s.titleKey) ?? []), s.score])
  }

  const result = new Map<string, number>()
  for (const [titleKey, all] of allByTitle) {
    const dissenter = dissenterByTitle.get(titleKey)
    const consensus = consensusByTitle.get(titleKey)

    let dissent: number
    if (dissenter && dissenter.length > 0 && consensus && consensus.length > 0) {
      dissent = Math.abs(mean(dissenter) - mean(consensus))
    } else {
      // Only one camp scored this idea — use the raw spread as a proxy.
      dissent = all.length > 1 ? Math.max(...all) - Math.min(...all) : 0
    }
    result.set(titleKey, clamp01(dissent))
  }

  return result
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

// ─── Meta-Game Health ─────────────────────────────────────────────────────────

export function computeMetaGameHealth(
  rounds: readonly SimulationRound[],
  definitions: readonly StrategicAgentDefinition[],
): MetaGameHealth {
  const allActions = rounds.flatMap((r) => r.agentActions)
  const totalActions = allActions.length

  // Agent balance: fraction of actions per role
  const actionsByRole = new Map<StrategicAgentRole, number>()
  for (const action of allActions) {
    const count = actionsByRole.get(action.role) ?? 0
    actionsByRole.set(action.role, count + 1)
  }

  const agentBalanceScores: Partial<Record<StrategicAgentRole, number>> = {}
  for (const def of definitions) {
    const count = actionsByRole.get(def.role) ?? 0
    agentBalanceScores[def.role] = totalActions > 0 ? count / totalActions : 0
  }

  // Diversity index: ratio of unique titles to total ideas
  const allIdeas = rounds.flatMap((r) => r.outcomes.selectedIdeas)
  const uniqueTitles = new Set(allIdeas.map((i) => i.title))
  const diversityIndex =
    allIdeas.length > 0 ? uniqueTitles.size / allIdeas.length : 0

  // Convergence rate: how much scores narrowed over rounds
  const roundScores = rounds.map((r) => {
    const ideas = r.outcomes.selectedIdeas
    if (ideas.length < 2) return 0
    const scores = ideas.map((i) => i.expertScore)
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length
    return scores.reduce((s, v) => s + Math.abs(v - mean), 0) / scores.length
  })

  const convergenceRate =
    roundScores.length >= 2
      ? Math.max(0, (roundScores[0]! - roundScores[roundScores.length - 1]!) / Math.max(roundScores[0]!, 0.0001))
      : 0

  // Novelty score: average distance of final ideas from a baseline 0.5 score
  const finalRound = rounds[rounds.length - 1]
  const finalIdeas = finalRound?.outcomes.selectedIdeas ?? []
  const noveltyScore =
    finalIdeas.length > 0
      ? finalIdeas.reduce((s, i) => s + Math.abs(i.expertScore - 0.5), 0) / finalIdeas.length
      : 0

  return {
    agentBalanceScores: agentBalanceScores as Record<StrategicAgentRole, number>,
    diversityIndex,
    convergenceRate,
    noveltyScore,
  }
}
