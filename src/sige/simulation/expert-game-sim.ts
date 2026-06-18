import { chat } from "../../agent/chat"
import type { ConversationMessage } from "../../agent/types"
import { createLogger } from "../../logger"
import {
  getAllDefinitions,
  buildStrategicPrompt,
  parseAgentAction,
  type StrategicAgentDefinition,
} from "../strategic-agents"
import {
  getFilteredGraphView,
  graphViewToPromptContext,
} from "../knowledge/graph-query"
import type { Mem0Client } from "../knowledge/mem0-client"
import { saveAgentAction, saveSimulationResult } from "../store"
import type { GameFormulation } from "../types"
import type {
  AgentAction,
  RoundNumber,
  ScoredIdea,
  SigeSessionConfig,
  SimulationRound,
  StrategicAgentRole,
} from "../types"
import { runWithConcurrency } from "./concurrency"
import {
  aggregateIdeaScores,
  applyFinalRankings,
  buildFitnessMap,
  extractEquilibria,
  extractEvaluationsFromRound2,
  extractEvolvedIdeas,
  extractIdeasFromRound1,
  extractNewProposalsFromRound2,
  formatIdeasForPrompt,
  identifyCoalitions,
  normTitle,
} from "./expert-game-scoring"
import { checkAborted } from "./expert-game-metrics"

const log = createLogger("sige:expert-game")

// ─── Fault-Tolerant Concurrency ───────────────────────────────────────────────

/**
 * Runs all tasks with the given concurrency limit.
 * Per-task errors are caught and returned as undefined rather than propagating.
 */
export async function runAgentTasks(
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

// ─── Placeholder Game Formulation ─────────────────────────────────────────────

/**
 * Minimal placeholder GameFormulation for headless callers that don't run the
 * formulation step. Provides just enough structure for prompt building.
 */
export function buildPlaceholderGameFormulation(sessionId: string): GameFormulation {
  return {
    id: crypto.randomUUID(),
    sessionId,
    gameType: "simultaneous",
    players: [],
    strategies: {},
    informationStructure: {
      visibility: {},
      asymmetries: [],
      commonKnowledge: [],
    },
    moveSequence: "simultaneous",
    constraints: [],
  }
}

// ─── Round 1: Divergent Generation ───────────────────────────────────────────

export async function runDivergentGeneration(params: {
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

export async function runStrategicInteraction(params: {
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

export async function runEvolutionaryTournament(params: {
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
  // UNION accumulator: every survivor + evolved child seen across generations,
  // deduped by title. Previously evolved children REPLACED the population, so
  // the seed-evaluated parents were silently dropped before Round 4 and the
  // pipeline's title-join could never reconcile them. We now retain BOTH camps
  // and surface origin downstream; the next-gen seed is a bounded top slice so
  // the genetic search stays focused without losing provenance.
  const unionByTitle = new Map<string, ScoredIdea>()
  for (const idea of topIdeas) unionByTitle.set(normTitle(idea.title), idea)

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

    // Record survivors (refreshed scores) and evolved children in the union.
    for (const idea of survivors) unionByTitle.set(normTitle(idea.title), idea)
    for (const idea of evolved) {
      const key = normTitle(idea.title)
      if (!unionByTitle.has(key)) unionByTitle.set(key, idea)
    }

    // Next generation breeds from the strongest of (survivors ∪ evolved),
    // bounded so the population doesn't blow up across generations.
    const nextSeed = evolved.length > 0 ? [...survivors, ...evolved] : survivors
    population = [...nextSeed]
      .sort((a, b) => b.expertScore - a.expertScore)
      .slice(0, EVOLUTION_POPULATION_CAP)
  }

  const sortedIdeas = [...unionByTitle.values()].sort(
    (a, b) => b.expertScore - a.expertScore,
  )

  log.info("Round 3: evolutionary union", {
    sessionId,
    retained: sortedIdeas.length,
    seedRetained: topIdeas.length,
  })

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

/**
 * Cap on the breeding population carried into each subsequent evolutionary
 * generation. The full union of survivors + evolved children is still RETAINED
 * for the Round-3 output / read-back; this only bounds the genetic search seed.
 */
const EVOLUTION_POPULATION_CAP = 15

// ─── Round 4: Equilibrium Analysis ───────────────────────────────────────────

export async function runEquilibriumAnalysis(params: {
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

export async function runSingleAgent(params: {
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
    provider: config.provider ?? "anthropic",
    agentId: `sige:${def.role}`,
    rawSystemPrompt: true,
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

export function filterActions(
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

export async function persistRound(sessionId: string, round: SimulationRound): Promise<void> {
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
