import { getAllDefinitions } from "../strategic-agents"
import type {
  AgentAction,
  Coalition,
  Equilibrium,
  EquilibriumType,
  ScoredIdea,
  StrategicAgentRole,
} from "../types"

// ─── Candidate / Divergent shapes ─────────────────────────────────────────────

/** Shape of a candidate idea injected into the evaluate-only path. */
export interface CandidateIdea {
  readonly title: string
  readonly summary?: string
  readonly description?: string
  /** Optional prior/seed score in [0,1]; defaults to 0.5 when absent. */
  readonly expertScore?: number
  /** Optional stable id; preserved on the mapped ScoredIdea when supplied. */
  readonly id?: string
  /**
   * Optional signal-ids / source refs the candidate is grounded in. Carried
   * through onto CandidateEvaluation.evidenceRef so the pipeline can re-bind
   * evolved children through verifyEvidence (the SIGE side never invents these).
   */
  readonly evidenceRef?: readonly string[]
}

/** A single generation-only candidate produced by a divergent persona. */
export interface DivergentCandidate {
  readonly title: string
  readonly summary: string
  /**
   * Optional ids/labels of the grounded signals the persona cited. Round-1
   * output carries a free-text `signalGrounding` field rather than structured
   * ids, so this is populated only when the LLM emits an explicit
   * `signalIds`/`supportingSignalIds` array; otherwise left undefined.
   */
  readonly supportingSignalIds?: readonly string[]
  /** Agent id (role:sessionId) that proposed this candidate. */
  readonly proposedBy: string
}

// ─── Shared title / string utilities ──────────────────────────────────────────

/** Lowercased, trimmed title used as the stable join key across rounds. */
export function normTitle(title: string): string {
  return title.toLowerCase().trim()
}

/** Non-empty string or undefined (trims and treats whitespace-only as empty). */
export function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Build a non-empty fallback enrichedSeed from the candidates' own text so the
 * taste-filter grounding gate always has something to anchor on. Bounded so the
 * prompt stays sane.
 */
export function synthesizeFallbackSeed(ideas: readonly ScoredIdea[]): string {
  const lines = ideas
    .slice(0, 30)
    .map((idea) => {
      const desc = idea.description ? ` — ${idea.description}` : ""
      return `- ${idea.title}${desc}`.slice(0, 600)
    })
    .filter((line) => line.trim().length > 2)

  const body = lines.join("\n").trim()
  if (body.length === 0) {
    // Last-resort sentinel: never return an empty string (the gate must run).
    return "Candidate ideas under evaluation (no descriptions supplied)."
  }
  return `Candidate ideas under evaluation:\n${body}`
}

/**
 * Build a lowercased-title → evidenceRef[] lookup from the caller's candidates.
 * Only candidates that actually carry a non-empty evidenceRef are recorded;
 * evolved children (new titles) inherit nothing here and are re-grounded
 * pipeline-side. PURE.
 */
export function buildEvidenceRefByTitle(
  candidates: readonly CandidateIdea[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>()
  for (const candidate of candidates) {
    const title = typeof candidate.title === "string" ? candidate.title.trim() : ""
    if (!title) continue
    const refs = Array.isArray(candidate.evidenceRef)
      ? candidate.evidenceRef.filter(
          (r): r is string => typeof r === "string" && r.trim().length > 0,
        )
      : []
    if (refs.length > 0) map.set(normTitle(title), refs)
  }
  return map
}

/**
 * Map incoming candidate shapes to the internal ScoredIdea contract.
 * Blank-titled candidates are dropped. See the mapping table above.
 */
export function mapCandidatesToScoredIdeas(
  candidates: readonly CandidateIdea[],
): readonly ScoredIdea[] {
  const ideas: ScoredIdea[] = []

  for (const candidate of candidates) {
    const title = typeof candidate.title === "string" ? candidate.title.trim() : ""
    if (!title) continue

    const description =
      (typeof candidate.summary === "string" && candidate.summary) ||
      (typeof candidate.description === "string" && candidate.description) ||
      ""

    const rawScore =
      typeof candidate.expertScore === "number" ? candidate.expertScore : 0.5
    const expertScore = Math.max(0, Math.min(1, rawScore))

    ideas.push({
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : crypto.randomUUID(),
      title,
      description,
      proposedBy: "external:candidate",
      round: 1,
      expertScore,
      incentiveBreakdown: {
        diversityBonus: 0,
        buildingBonus: 0,
        surpriseBonus: 0,
        accuracyPenalty: 0,
        memoryReward: 0,
        coalitionStability: 0,
        signalCredibility: 0,
        socialViability: 0,
      },
      strategicMetadata: {
        paretoOptimal: false,
        dominantStrategy: false,
        evolutionarilyStable: false,
        nashEquilibrium: false,
      },
    })
  }

  return ideas
}

/**
 * Pure extractor: map Round-1 agent actions → the simple DivergentCandidate
 * shape. Parses each action's JSON `ideas` array, drops blank-titled ideas,
 * derives a summary from `description`/`oneLiner`, and lifts an optional
 * `signalIds`/`supportingSignalIds` array when present. Exported for unit tests.
 */
export function extractDivergentCandidates(
  actions: readonly AgentAction[],
): readonly DivergentCandidate[] {
  const candidates: DivergentCandidate[] = []

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rawIdeas = Array.isArray(raw.ideas) ? raw.ideas : []

    for (const item of rawIdeas) {
      if (typeof item !== "object" || item === null) continue
      const idea = item as Record<string, unknown>

      const title = typeof idea.title === "string" ? idea.title.trim() : ""
      if (!title) continue

      const summary =
        (typeof idea.description === "string" && idea.description.trim()) ||
        (typeof idea.oneLiner === "string" && idea.oneLiner.trim()) ||
        ""

      const supportingSignalIds = extractSignalIds(idea)

      candidates.push({
        title,
        summary,
        proposedBy: action.agentId,
        ...(supportingSignalIds ? { supportingSignalIds } : {}),
      })
    }
  }

  return candidates
}

/**
 * Pull an optional list of supporting signal ids from a Round-1 idea object.
 * Accepts either `supportingSignalIds` or `signalIds`, requires a non-empty
 * array of non-blank strings, and returns undefined otherwise. Pure; exported
 * for unit tests.
 */
export function extractSignalIds(
  idea: Record<string, unknown>,
): readonly string[] | undefined {
  const rawList = Array.isArray(idea.supportingSignalIds)
    ? idea.supportingSignalIds
    : Array.isArray(idea.signalIds)
      ? idea.signalIds
      : undefined

  if (!rawList) return undefined

  const ids = rawList
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)

  return ids.length > 0 ? ids : undefined
}

// ─── Idea Extraction ──────────────────────────────────────────────────────────

export function extractIdeasFromRound1(actions: readonly AgentAction[]): readonly ScoredIdea[] {
  const ideas: ScoredIdea[] = []

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rawIdeas = Array.isArray(raw.ideas) ? raw.ideas : []

    for (const item of rawIdeas) {
      if (typeof item !== "object" || item === null) continue
      const idea = item as Record<string, unknown>
      const title = typeof idea.title === "string" ? idea.title.trim() : ""
      const description = typeof idea.description === "string" ? idea.description : ""
      const confidence =
        typeof idea.confidence === "number" ? Math.max(0, Math.min(1, idea.confidence)) : 0.5

      if (!title) continue

      ideas.push(
        createScoredIdea({
          title,
          description,
          proposedBy: action.agentId,
          round: 1,
          confidence,
          influenceWeight: getInfluenceWeight(action.role),
        }),
      )
    }
  }

  return ideas
}

export function extractEvaluationsFromRound2(
  actions: readonly AgentAction[],
): readonly { agentId: string; ideaId: string; score: number }[] {
  const evaluations: { agentId: string; ideaId: string; score: number }[] = []

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rawEvals = Array.isArray(raw.evaluations) ? raw.evaluations : []

    for (const ev of rawEvals) {
      if (typeof ev !== "object" || ev === null) continue
      const e = ev as Record<string, unknown>
      const ideaId = typeof e.ideaId === "string" ? e.ideaId : ""
      const score = typeof e.score === "number" ? Math.max(0, Math.min(1, e.score)) : 0.5
      if (ideaId) evaluations.push({ agentId: action.agentId, ideaId, score })
    }
  }

  return evaluations
}

export function extractNewProposalsFromRound2(
  actions: readonly AgentAction[],
): readonly ScoredIdea[] {
  const proposals: ScoredIdea[] = []

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rawProps = Array.isArray(raw.proposals) ? raw.proposals : []

    for (const item of rawProps) {
      if (typeof item !== "object" || item === null) continue
      const p = item as Record<string, unknown>
      const title = typeof p.title === "string" ? p.title.trim() : ""
      const description = typeof p.description === "string" ? p.description : ""
      if (!title) continue

      proposals.push(
        createScoredIdea({
          title,
          description,
          proposedBy: action.agentId,
          round: 2,
          confidence: action.confidence,
          influenceWeight: getInfluenceWeight(action.role),
        }),
      )
    }
  }

  return proposals
}

export function extractEvolvedIdeas(
  actions: readonly AgentAction[],
  gen: number,
  survivors: readonly ScoredIdea[],
): readonly ScoredIdea[] {
  const ideas: ScoredIdea[] = []
  const avgSurvivorScore =
    survivors.length > 0
      ? survivors.reduce((sum, s) => sum + s.expertScore, 0) / survivors.length
      : 0.5

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>

    // Mutations
    const mutations = Array.isArray(raw.mutations) ? raw.mutations : []
    for (const m of mutations) {
      if (typeof m !== "object" || m === null) continue
      const mut = m as Record<string, unknown>
      const title =
        typeof mut.mutatedTitle === "string" ? mut.mutatedTitle.trim() : ""
      const description =
        typeof mut.mutatedDescription === "string" ? mut.mutatedDescription : ""
      if (!title) continue
      ideas.push(
        createScoredIdea({
          title,
          description,
          proposedBy: action.agentId,
          round: gen + 2, // gen 1 → round 3, gen 2 → round 4, etc.
          confidence: avgSurvivorScore,
          influenceWeight: getInfluenceWeight(action.role),
        }),
      )
    }

    // Crossovers
    const crossovers = Array.isArray(raw.crossovers) ? raw.crossovers : []
    for (const c of crossovers) {
      if (typeof c !== "object" || c === null) continue
      const cross = c as Record<string, unknown>
      const title =
        typeof cross.combinedTitle === "string" ? cross.combinedTitle.trim() : ""
      const description =
        typeof cross.combinedDescription === "string" ? cross.combinedDescription : ""
      if (!title) continue
      ideas.push(
        createScoredIdea({
          title,
          description,
          proposedBy: action.agentId,
          round: gen + 2,
          confidence: avgSurvivorScore * 1.05, // slight crossover bonus
          influenceWeight: getInfluenceWeight(action.role),
        }),
      )
    }
  }

  return ideas
}

export function extractEquilibria(
  actions: readonly AgentAction[],
  ideas: readonly ScoredIdea[],
): readonly Equilibrium[] {
  const ideaTitles = new Set(ideas.map((i) => i.title))
  const equilibria: Equilibrium[] = []

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rawEq = Array.isArray(raw.equilibria) ? raw.equilibria : []

    for (const eq of rawEq) {
      if (typeof eq !== "object" || eq === null) continue
      const e = eq as Record<string, unknown>

      const rawType = typeof e.type === "string" ? e.type : ""
      const equilType = isValidEquilibriumType(rawType) ? rawType : "nash"
      const stability =
        typeof e.stability === "number" ? Math.max(0, Math.min(1, e.stability)) : 0.5
      const description = typeof e.description === "string" ? e.description : ""
      const ideaIds = Array.isArray(e.ideaIds)
        ? (e.ideaIds as unknown[])
            .filter((id): id is string => typeof id === "string" && ideaTitles.has(id))
        : []

      if (ideaIds.length === 0) continue

      equilibria.push({
        type: equilType,
        ideas: ideaIds,
        stability,
        description,
      })
    }
  }

  return equilibria
}

export function applyFinalRankings(
  ideas: readonly ScoredIdea[],
  actions: readonly AgentAction[],
): readonly ScoredIdea[] {
  const scoreMap = new Map<string, number[]>()

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rankings = Array.isArray(raw.finalRankings) ? raw.finalRankings : []

    for (const r of rankings) {
      if (typeof r !== "object" || r === null) continue
      const rank = r as Record<string, unknown>
      const ideaId = typeof rank.ideaId === "string" ? rank.ideaId : ""
      const score = typeof rank.score === "number" ? Math.max(0, Math.min(1, rank.score)) : null
      if (!ideaId || score === null) continue
      const existing = scoreMap.get(ideaId) ?? []
      scoreMap.set(ideaId, [...existing, score])
    }
  }

  const updated = ideas.map((idea) => {
    const scores = scoreMap.get(idea.title)
    if (!scores || scores.length === 0) return idea
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length
    return { ...idea, expertScore: avg }
  })

  return [...updated].sort((a, b) => b.expertScore - a.expertScore)
}

// ─── Score Aggregation ────────────────────────────────────────────────────────

export function aggregateIdeaScores(
  existingIdeas: readonly ScoredIdea[],
  evaluations: readonly { agentId: string; ideaId: string; score: number }[],
  newProposals: readonly ScoredIdea[],
): readonly ScoredIdea[] {
  const scoresByTitle = new Map<string, number[]>()

  for (const ev of evaluations) {
    const scores = scoresByTitle.get(ev.ideaId) ?? []
    scoresByTitle.set(ev.ideaId, [...scores, ev.score])
  }

  const updated = existingIdeas.map((idea) => {
    const scores = scoresByTitle.get(idea.title)
    if (!scores || scores.length === 0) return idea
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length
    return { ...idea, expertScore: avg }
  })

  return [...updated, ...newProposals]
}

export function buildFitnessMap(actions: readonly AgentAction[]): Map<string, number> {
  const scores = new Map<string, number[]>()

  for (const action of actions) {
    let parsed: unknown
    try {
      parsed = JSON.parse(action.content)
    } catch {
      continue
    }

    if (typeof parsed !== "object" || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    const rankings = Array.isArray(raw.rankings) ? raw.rankings : []

    for (const r of rankings) {
      if (typeof r !== "object" || r === null) continue
      const rank = r as Record<string, unknown>
      const ideaId = typeof rank.ideaId === "string" ? rank.ideaId : ""
      const fitness = typeof rank.fitness === "number" ? rank.fitness : null
      if (!ideaId || fitness === null) continue
      const existing = scores.get(ideaId) ?? []
      scores.set(ideaId, [...existing, fitness])
    }
  }

  const result = new Map<string, number>()
  for (const [title, vals] of scores) {
    result.set(title, vals.reduce((s, v) => s + v, 0) / vals.length)
  }
  return result
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

export function formatIdeasForPrompt(ideas: readonly ScoredIdea[]): string {
  if (ideas.length === 0) return "No ideas available yet."

  return ideas
    .map(
      (idea, i) =>
        `${i + 1}. **${idea.title}** (score: ${idea.expertScore.toFixed(2)})\n   ${idea.description}`,
    )
    .join("\n\n")
}

export function createScoredIdea(params: {
  readonly title: string
  readonly description: string
  readonly proposedBy: string
  readonly round: number
  readonly confidence: number
  readonly influenceWeight?: number
}): ScoredIdea {
  const weight = params.influenceWeight ?? 1.0
  const expertScore = Math.max(0, Math.min(1, params.confidence * weight))

  return {
    id: crypto.randomUUID(),
    title: params.title,
    description: params.description,
    proposedBy: params.proposedBy,
    round: params.round,
    expertScore,
    incentiveBreakdown: {
      diversityBonus: 0,
      buildingBonus: params.round > 1 ? 0.05 : 0,
      surpriseBonus: 0,
      accuracyPenalty: 0,
      memoryReward: 0,
      coalitionStability: 0,
      signalCredibility: 0,
      socialViability: 0,
    },
    strategicMetadata: {
      paretoOptimal: false,
      dominantStrategy: false,
      evolutionarilyStable: false,
      nashEquilibrium: false,
    },
  }
}

export function identifyCoalitions(
  evaluations: readonly { agentId: string; ideaId: string; score: number }[],
): readonly Coalition[] {
  const SUPPORT_THRESHOLD = 0.65

  // Map ideaId → agents who scored it highly
  const ideaSupporters = new Map<string, string[]>()
  for (const ev of evaluations) {
    if (ev.score >= SUPPORT_THRESHOLD) {
      const supporters = ideaSupporters.get(ev.ideaId) ?? []
      ideaSupporters.set(ev.ideaId, [...supporters, ev.agentId])
    }
  }

  // Group by agent sets that overlap on multiple ideas
  const coalitionMap = new Map<string, { ideas: string[]; members: Set<string> }>()

  for (const [ideaId, supporters] of ideaSupporters) {
    if (supporters.length < 2) continue
    const key = [...supporters].sort().join("|")
    const existing = coalitionMap.get(key)
    if (existing) {
      coalitionMap.set(key, {
        ideas: [...existing.ideas, ideaId],
        members: existing.members,
      })
    } else {
      coalitionMap.set(key, { ideas: [ideaId], members: new Set(supporters) })
    }
  }

  return Array.from(coalitionMap.values()).map(({ ideas, members }) => {
    const memberArray = Array.from(members)
    const stability =
      ideas.length > 0 ? Math.min(1, ideas.length / 3 + memberArray.length / 10) : 0

    const shapleyValues: Record<string, number> = {}
    const perMember = stability / Math.max(1, memberArray.length)
    for (const m of memberArray) {
      shapleyValues[m] = perMember
    }

    return {
      id: crypto.randomUUID(),
      members: memberArray,
      sharedIdeas: ideas,
      stability,
      shapleyValues,
    }
  })
}

// ─── Internal Utilities ───────────────────────────────────────────────────────

export function getInfluenceWeight(role: StrategicAgentRole): number {
  const allDefs = getAllDefinitions()
  const def = allDefs.find((d) => d.role === role)
  return def?.defaultPersona.influenceWeight ?? 1.0
}

export function isValidEquilibriumType(value: string): value is EquilibriumType {
  const valid: readonly string[] = [
    "nash",
    "pareto",
    "dominant",
    "evolutionary_stable",
    "signaling_separating",
    "signaling_pooling",
  ]
  return valid.includes(value)
}
