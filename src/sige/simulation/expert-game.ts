import { createLogger } from "../../logger"
import { chat } from "../../agent/chat"
import type { ConversationMessage } from "../../agent/types"
import {
  buildStrategicPrompt,
  parseAgentAction,
  getAllDefinitions,
  type StrategicAgentDefinition,
} from "../strategic-agents"
import {
  getFilteredGraphView,
  graphViewToPromptContext,
  type GraphView,
} from "../knowledge/graph-query"
import type { Mem0Client } from "../knowledge/mem0-client"
import type { GameFormulation } from "../types"
import { runWithConcurrency } from "./concurrency"
import { saveAgentAction, saveSimulationResult } from "../store"
import { runTasteFilter } from "../taste-filter"
import type {
  AgentAction,
  Coalition,
  Equilibrium,
  EquilibriumType,
  ExpertGameResult,
  MetaGameHealth,
  RoundNumber,
  ScoredIdea,
  SigeSessionConfig,
  SimulationRound,
  StrategicAgentRole,
} from "../types"

const log = createLogger("sige:expert-game")

// ─── Fault-Tolerant Concurrency ───────────────────────────────────────────────

/**
 * Runs all tasks with the given concurrency limit.
 * Per-task errors are caught and returned as undefined rather than propagating.
 */
async function runAgentTasks(
  tasks: readonly (() => Promise<AgentAction>)[],
  maxConcurrent: number,
): Promise<readonly (AgentAction | undefined)[]> {
  const faultTolerant = tasks.map(
    (task) => async (): Promise<AgentAction | undefined> => {
      try {
        return await task()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn("Agent task failed (fault-tolerant)", { reason: msg })
        return undefined
      }
    },
  )
  return runWithConcurrency(faultTolerant, maxConcurrent)
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runExpertGame(params: {
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly graphView: GraphView
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
  readonly signalsContext?: string
  readonly enrichedSeed?: string
}): Promise<ExpertGameResult> {
  const { sessionId, gameFormulation, mem0, userId, config, signal, signalsContext, enrichedSeed } = params

  log.info("Expert game starting", { sessionId })

  checkAborted(signal)

  const round1 = await runDivergentGeneration({
    sessionId,
    gameFormulation,
    mem0,
    userId,
    config,
    signal,
    signalsContext,
  })

  await persistRound(sessionId, round1)
  log.info("Round 1 complete", {
    sessionId,
    ideasCount: round1.outcomes.selectedIdeas.length,
  })

  checkAborted(signal)

  const round2 = await runStrategicInteraction({
    sessionId,
    gameFormulation,
    round1Results: round1,
    mem0,
    userId,
    config,
    signal,
    signalsContext,
  })

  await persistRound(sessionId, round2)
  log.info("Round 2 complete", {
    sessionId,
    ideasCount: round2.outcomes.selectedIdeas.length,
    coalitions: round2.outcomes.coalitions?.length ?? 0,
  })

  checkAborted(signal)

  // ── Taste Filter: quality gate between Round 2 and Round 3 ──
  let filteredRound2 = round2
  if (!enrichedSeed) {
    log.warn("Taste filter skipped — no enrichedSeed provided; Round 3 will use unfiltered Round 2 ideas", { sessionId })
  } else {
    const tasteResult = await runTasteFilter({
      ideas: round2.outcomes.selectedIdeas,
      enrichedSeed,
      model: config.model,
      provider: config.provider ?? "alibaba",
      minPassCount: 5,
    })
    log.info("Taste filter applied", {
      sessionId,
      passed: tasteResult.filterStats.totalPassed,
      eliminated: tasteResult.filterStats.totalEliminated,
      avgSpecificity: tasteResult.filterStats.avgSpecificityScore,
      avgSignalGrounding: tasteResult.filterStats.avgSignalGroundingScore,
    })
    filteredRound2 = {
      ...round2,
      outcomes: {
        ...round2.outcomes,
        selectedIdeas: tasteResult.passed,
        eliminatedIdeas: tasteResult.eliminated.map((e) => e.idea.title),
      },
    }
  }

  const round3 = await runEvolutionaryTournament({
    sessionId,
    gameFormulation,
    round2Results: filteredRound2,
    mem0,
    userId,
    config,
    signal,
    signalsContext,
  })

  await persistRound(sessionId, round3)
  log.info("Round 3 complete", {
    sessionId,
    ideasCount: round3.outcomes.selectedIdeas.length,
  })

  checkAborted(signal)

  const allRounds: readonly SimulationRound[] = [round1, round2, round3]

  const round4 = await runEquilibriumAnalysis({
    sessionId,
    gameFormulation,
    round3Results: round3,
    allRounds,
    mem0,
    userId,
    config,
    signal,
    signalsContext,
  })

  await persistRound(sessionId, round4)
  log.info("Round 4 complete", {
    sessionId,
    equilibria: round4.outcomes.equilibria?.length ?? 0,
  })

  const definitions = getAllDefinitions()
  const allCompletedRounds: readonly SimulationRound[] = [...allRounds, round4]
  const metaGameHealth = computeMetaGameHealth(allCompletedRounds, definitions)

  const equilibria = round4.outcomes.equilibria ?? []
  const rankedIdeas = round4.outcomes.selectedIdeas

  log.info("Expert game complete", {
    sessionId,
    totalRounds: allCompletedRounds.length,
    rankedIdeas: rankedIdeas.length,
    equilibria: equilibria.length,
  })

  return { rounds: allCompletedRounds, equilibria, rankedIdeas, metaGameHealth }
}

// ─── Round 1: Divergent Generation ───────────────────────────────────────────

async function runDivergentGeneration(params: {
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
  readonly signalsContext?: string
}): Promise<SimulationRound> {
  const { sessionId, gameFormulation, mem0, userId, config, signal, signalsContext } = params
  const definitions = getAllDefinitions()

  log.info("Round 1: divergent generation", {
    sessionId,
    agentCount: definitions.length,
  })

  const tasks = definitions.map((def) => async () => {
    checkAborted(signal)
    return runSingleAgent({
      def,
      round: 1,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      roundContext: undefined,
      signalsContext,
    })
  })

  const results = await runAgentTasks(tasks, config.maxConcurrentAgents)
  const actions = filterActions(results, sessionId, 1)

  if (actions.length < 3) {
    throw new Error(
      `Round 1 produced only ${actions.length} successful agent(s) — need at least 3 for sufficient diversity`,
    )
  }

  const ideas = extractIdeasFromRound1(actions)
  const sortedIdeas = [...ideas].sort((a, b) => b.expertScore - a.expertScore)

  return {
    roundNumber: 1,
    roundType: "divergent_generation",
    agentActions: actions,
    outcomes: {
      selectedIdeas: sortedIdeas,
      eliminatedIdeas: [],
    },
  }
}

// ─── Round 2: Strategic Interaction ──────────────────────────────────────────

async function runStrategicInteraction(params: {
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly round1Results: SimulationRound
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
  readonly signalsContext?: string
}): Promise<SimulationRound> {
  const { sessionId, gameFormulation, round1Results, mem0, userId, config, signal, signalsContext } = params
  const definitions = getAllDefinitions()

  const roundContext = formatIdeasForPrompt(round1Results.outcomes.selectedIdeas)

  log.info("Round 2: strategic interaction", {
    sessionId,
    ideasInContext: round1Results.outcomes.selectedIdeas.length,
  })

  const tasks = definitions.map((def) => async () => {
    checkAborted(signal)
    return runSingleAgent({
      def,
      round: 2,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      roundContext,
      signalsContext,
    })
  })

  const results2 = await runAgentTasks(tasks, config.maxConcurrentAgents)
  const actions = filterActions(results2, sessionId, 2)

  const evaluations = extractEvaluationsFromRound2(actions)
  const newProposals = extractNewProposalsFromRound2(actions)

  const aggregated = aggregateIdeaScores(
    round1Results.outcomes.selectedIdeas,
    evaluations,
    newProposals,
  )
  const coalitions = identifyCoalitions(evaluations)
  const sortedIdeas = [...aggregated].sort((a, b) => b.expertScore - a.expertScore)

  return {
    roundNumber: 2,
    roundType: "strategic_interaction",
    agentActions: actions,
    outcomes: {
      selectedIdeas: sortedIdeas,
      eliminatedIdeas: [],
      coalitions,
    },
  }
}

// ─── Round 3: Evolutionary Tournament ────────────────────────────────────────

async function runEvolutionaryTournament(params: {
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly round2Results: SimulationRound
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
  readonly signalsContext?: string
}): Promise<SimulationRound> {
  const { sessionId, gameFormulation, round2Results, mem0, userId, config, signal, signalsContext } = params

  const topIdeas = round2Results.outcomes.selectedIdeas.slice(0, 15)
  log.info("Round 3: evolutionary tournament", {
    sessionId,
    seedIdeas: topIdeas.length,
  })

  let population: readonly ScoredIdea[] = topIdeas
  const allActions: AgentAction[] = []

  for (let gen = 1; gen <= 3; gen++) {
    checkAborted(signal)
    const { survivors, actions, evolved } = await runEvolutionaryGeneration({
      gen,
      population,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      signal,
      signalsContext,
    })
    allActions.push(...actions)
    population = evolved.length > 0 ? evolved : survivors
  }

  const sortedIdeas = [...population].sort((a, b) => b.expertScore - a.expertScore)

  return {
    roundNumber: 3,
    roundType: "evolutionary_tournament",
    agentActions: allActions,
    outcomes: {
      selectedIdeas: sortedIdeas,
      eliminatedIdeas: [],
    },
  }
}

// ─── Round 4: Equilibrium Analysis ───────────────────────────────────────────

async function runEquilibriumAnalysis(params: {
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly round3Results: SimulationRound
  readonly allRounds: readonly SimulationRound[]
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
  readonly signalsContext?: string
}): Promise<SimulationRound> {
  const { sessionId, gameFormulation, round3Results, mem0, userId, config, signal, signalsContext } = params

  const analyzerRoles: readonly StrategicAgentRole[] = [
    "rational_player",
    "mechanism_designer",
    "adversarial",
  ]
  const definitions = getAllDefinitions().filter((d) => analyzerRoles.includes(d.role))
  const roundContext = formatIdeasForPrompt(round3Results.outcomes.selectedIdeas)

  log.info("Round 4: equilibrium analysis", {
    sessionId,
    analyzers: definitions.length,
    ideasToAnalyze: round3Results.outcomes.selectedIdeas.length,
  })

  const tasks = definitions.map((def) => async () => {
    checkAborted(signal)
    return runSingleAgent({
      def,
      round: 4,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      roundContext,
      signalsContext,
    })
  })

  const results4 = await runAgentTasks(tasks, config.maxConcurrentAgents)
  const actions = filterActions(results4, sessionId, 4)

  const equilibria = extractEquilibria(actions, round3Results.outcomes.selectedIdeas)
  const finalRanked = applyFinalRankings(
    round3Results.outcomes.selectedIdeas,
    actions,
  )

  return {
    roundNumber: 4,
    roundType: "equilibrium_analysis",
    agentActions: actions,
    outcomes: {
      selectedIdeas: finalRanked,
      eliminatedIdeas: [],
      equilibria,
    },
  }
}

// ─── Single Agent Execution ───────────────────────────────────────────────────

async function runSingleAgent(params: {
  readonly def: StrategicAgentDefinition
  readonly round: RoundNumber
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly roundContext: string | undefined
  readonly signalsContext?: string
}): Promise<AgentAction> {
  const { def, round, sessionId, gameFormulation, mem0, userId, config, roundContext, signalsContext } = params

  const filter = def.defaultKnowledgeFilter
  const agentGraphView = await getFilteredGraphView(mem0, userId, def.role, filter)
  const graphContext = graphViewToPromptContext(agentGraphView)

  const systemPrompt = buildStrategicPrompt(
    def,
    gameFormulation,
    graphContext,
    round,
    roundContext,
    signalsContext,
  )

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: `You are the ${def.name}. Respond with valid JSON as instructed.`,
      timestamp: Date.now(),
    },
  ]

  const response = await chat(messages, {
    systemPrompt,
    model: config.agentModel,
    provider: config.provider ?? "alibaba",
    agentId: `sige:${def.role}`,
  })

  const agentId = `${def.role}:${sessionId}`
  return parseAgentAction(response.text, round, agentId, def.role)
}

// ─── Evolutionary Generation ──────────────────────────────────────────────────

async function runEvolutionaryGeneration(params: {
  readonly gen: number
  readonly population: readonly ScoredIdea[]
  readonly sessionId: string
  readonly gameFormulation: GameFormulation
  readonly mem0: Mem0Client
  readonly userId: string
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
  readonly signalsContext?: string
}): Promise<{
  readonly survivors: readonly ScoredIdea[]
  readonly actions: readonly AgentAction[]
  readonly evolved: readonly ScoredIdea[]
}> {
  const { gen, population, sessionId, gameFormulation, mem0, userId, config, signal, signalsContext } = params

  const allDefs = getAllDefinitions()
  const roundContext = formatIdeasForPrompt(population)

  // Fitness evaluation: all agents score the current population
  const evalTasks = allDefs.map((def) => async () => {
    checkAborted(signal)
    return runSingleAgent({
      def,
      round: 3,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      roundContext,
      signalsContext,
    })
  })

  const evalResults = await runAgentTasks(evalTasks, config.maxConcurrentAgents)
  const evalActions = filterActions(evalResults, sessionId, 3)

  // Fitness scores per idea from round-3 rankings
  const fitnessMap = buildFitnessMap(evalActions)

  // Select top 50% survivors
  const scored = population.map((idea) => ({
    idea,
    fitness: fitnessMap.get(idea.title) ?? idea.expertScore,
  }))
  scored.sort((a, b) => b.fitness - a.fitness)
  const survivors = scored
    .slice(0, Math.max(1, Math.ceil(population.length / 2)))
    .map((s) => ({ ...s.idea, expertScore: s.fitness }))

  // Mutation: Explorer + Founder propose variations
  const mutatorRoles: readonly StrategicAgentRole[] = ["explorer", "founder"]
  const mutatorDefs = allDefs.filter((d) => mutatorRoles.includes(d.role))
  const mutatorContext = formatIdeasForPrompt(survivors)

  const mutateTasks = mutatorDefs.map((def) => async () => {
    checkAborted(signal)
    return runSingleAgent({
      def,
      round: 3,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      roundContext: `## Generation ${gen} — Propose mutations of the surviving ideas:\n\n${mutatorContext}`,
      signalsContext,
    })
  })

  const mutateResults = await runAgentTasks(mutateTasks, config.maxConcurrentAgents)
  const mutateActions = filterActions(mutateResults, sessionId, 3)

  // Crossover: Designer + Domain Expert combine pairs
  const crossoverRoles: readonly StrategicAgentRole[] = ["designer", "domain_expert"]
  const crossoverDefs = allDefs.filter((d) => crossoverRoles.includes(d.role))

  const crossoverTasks = crossoverDefs.map((def) => async () => {
    checkAborted(signal)
    return runSingleAgent({
      def,
      round: 3,
      sessionId,
      gameFormulation,
      mem0,
      userId,
      config,
      roundContext: `## Generation ${gen} — Combine pairs of ideas into hybrids:\n\n${mutatorContext}`,
      signalsContext,
    })
  })

  const crossoverResults = await runAgentTasks(crossoverTasks, config.maxConcurrentAgents)
  const crossoverActions = filterActions(crossoverResults, sessionId, 3)

  const allActions = [...evalActions, ...mutateActions, ...crossoverActions]

  // Extract new ideas from mutations and crossovers
  const evolved = extractEvolvedIdeas(
    [...mutateActions, ...crossoverActions],
    gen,
    survivors,
  )

  return { survivors, actions: allActions, evolved }
}

// ─── Helper: Run Agent & Persist ─────────────────────────────────────────────

function filterActions(
  results: readonly (AgentAction | undefined)[],
  sessionId: string,
  round: number,
): readonly AgentAction[] {
  const actions: AgentAction[] = []

  for (const result of results) {
    if (result !== undefined) {
      actions.push(result)
    } else {
      log.debug("Skipping undefined agent result", { sessionId, round })
    }
  }

  return actions
}

async function persistRound(sessionId: string, round: SimulationRound): Promise<void> {
  const actionSaves = round.agentActions.map((action) =>
    saveAgentAction({
      id: crypto.randomUUID(),
      sessionId,
      round: round.roundNumber,
      agentRole: action.role,
      agentId: action.agentId,
      actionType: action.actionType,
      content: action.content,
      confidence: action.confidence,
      targetIdeasJson: action.targetIdeas ? JSON.stringify(action.targetIdeas) : undefined,
      reasoning: action.reasoning,
    }).catch((err) => {
      log.warn("Failed to persist agent action", {
        sessionId,
        agentId: action.agentId,
        err,
      })
    }),
  )

  await Promise.all(actionSaves)

  await saveSimulationResult({
    id: crypto.randomUUID(),
    sessionId,
    layer: "expert",
    round: round.roundNumber,
    resultJson: JSON.stringify(round),
  }).catch((err) => {
    log.warn("Failed to persist simulation result", { sessionId, round: round.roundNumber, err })
  })
}

// ─── Idea Extraction ──────────────────────────────────────────────────────────

function extractIdeasFromRound1(actions: readonly AgentAction[]): readonly ScoredIdea[] {
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

function extractEvaluationsFromRound2(
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

function extractNewProposalsFromRound2(
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

function extractEvolvedIdeas(
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

function extractEquilibria(
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

function applyFinalRankings(
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

function aggregateIdeaScores(
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

function buildFitnessMap(actions: readonly AgentAction[]): Map<string, number> {
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

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Expert game simulation aborted")
  }
}

// ─── Internal Utilities ───────────────────────────────────────────────────────

function getInfluenceWeight(role: StrategicAgentRole): number {
  const allDefs = getAllDefinitions()
  const def = allDefs.find((d) => d.role === role)
  return def?.defaultPersona.influenceWeight ?? 1.0
}

function isValidEquilibriumType(value: string): value is EquilibriumType {
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
