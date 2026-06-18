import { createLogger } from "../../logger"
import type { GiantAxisScores } from "../../pipelines/ideas/giant"
import {
  getAllDefinitions,
  type StrategicAgentDefinition,
} from "../strategic-agents"
import type { GraphView } from "../knowledge/graph-query"
import { Mem0Client } from "../knowledge/mem0-client"
import type { GameFormulation } from "../types"
import { runTasteFilter } from "../taste-filter"
import type {
  ExpertGameResult,
  SigeSessionConfig,
  SimulationRound,
  StrategicAgentRole,
  StrategicMetadata,
} from "../types"
import {
  buildEvidenceRefByTitle,
  extractDivergentCandidates,
  mapCandidatesToScoredIdeas,
  nonEmpty,
  normTitle,
  synthesizeFallbackSeed,
} from "./expert-game-scoring"
import { checkAborted, computeDissentByTitle, computeMetaGameHealth } from "./expert-game-metrics"
import {
  buildPlaceholderGameFormulation,
  filterActions,
  persistRound,
  runAgentTasks,
  runDivergentGeneration,
  runEquilibriumAnalysis,
  runEvolutionaryTournament,
  runSingleAgent,
  runStrategicInteraction,
} from "./expert-game-sim"

const log = createLogger("sige:expert-game")

/**
 * Last-resort Mem0 client for callers that fail to thread one through. Reads the
 * SAME env the config loader uses (OPENCROW_SIGE_MEM0_URL + OPENCROW_INTERNAL_TOKEN)
 * so a missed wiring still targets the correct in-container host (mem0:8000) with
 * the shared bearer token, instead of an unreachable bare localhost that silently
 * yields an empty knowledge graph. The real fix is always to pass `mem0`
 * explicitly — this only bounds the blast radius of the next missed wiring.
 */
function fallbackMem0Client(): Mem0Client {
  return new Mem0Client({
    baseUrl: process.env.OPENCROW_SIGE_MEM0_URL ?? "http://localhost:8000",
    apiToken: process.env.OPENCROW_INTERNAL_TOKEN || undefined,
  })
}

// ─── Public re-exports (preserve the original "./expert-game" import surface) ──

export {
  buildEvidenceRefByTitle,
  createScoredIdea,
  extractDivergentCandidates,
  extractSignalIds,
  formatIdeasForPrompt,
  identifyCoalitions,
  mapCandidatesToScoredIdeas,
  synthesizeFallbackSeed,
} from "./expert-game-scoring"
export type { CandidateIdea, DivergentCandidate } from "./expert-game-scoring"
export {
  checkAborted,
  computeDissentByTitle,
  computeMetaGameHealth,
} from "./expert-game-metrics"

import type { CandidateIdea, DivergentCandidate } from "./expert-game-scoring"

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
      provider: config.provider ?? "anthropic",
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

// ─── Evaluate-Only Mode (headless, candidate-injectable) ──────────────────────
//
// Unlike runExpertGame (which begins with Round-1 divergent *generation*),
// evaluateCandidates SKIPS generation entirely and seeds the
// strategic-interaction / evolutionary / equilibrium rounds with
// externally-supplied candidate ideas. This lets the ideas pipeline (or any
// other caller) submit pre-generated candidates and get back per-candidate
// expert scores graded by the 9-agent strategic tournament.
//
// This path is fully DECOUPLED from config.sige.enabled — that gate only
// governs the standalone polling process; evaluateCandidates is callable
// regardless (the caller is responsible for any feature flagging, e.g. the
// ideas pipeline gates this behind smart.sigeValuation).
//
// ── Candidate → ScoredIdea mapping ──
//   incoming.title       → ScoredIdea.title        (required; blank titles dropped)
//   incoming.summary     → ScoredIdea.description  (falls back to "" when absent)
//   incoming.expertScore → ScoredIdea.expertScore  (clamped to [0,1]; default 0.5 —
//                          acts as the seed/prior confidence the agents revise)
//   incoming.id          → ScoredIdea.id           (preserved when supplied so the
//                          caller can map results back; otherwise a UUID is minted)
//   proposedBy           → "external:candidate"    (synthetic — not an agent role)
//   round                → 1                        (treated as if generated in R1)
// Internally, rounds 2–4 re-score ideas by *title*, matching the existing game's
// title-keyed aggregation. The returned title is therefore the join key callers
// should use to reconcile results with their inputs.

/** Context/dependencies for the headless evaluate-only path. */
export interface EvaluateCandidatesContext {
  /** Mem0 client used by strategic agents for per-role knowledge filtering. */
  readonly mem0?: Mem0Client
  /** Mem0 user id (graph namespace); defaults to "sige-global". */
  readonly userId?: string
  /** Session id used purely for logging/keying; a UUID is minted if absent. */
  readonly sessionId?: string
  /**
   * Game formulation to ground agent reasoning. When omitted a minimal
   * placeholder is synthesized so the path remains callable standalone.
   */
  readonly gameFormulation?: GameFormulation
  /** SIGE session config; defaults to DEFAULT_EVALUATE_CONFIG when absent. */
  readonly config?: SigeSessionConfig
  /** Optional synthesized-signals prompt context (from signal-synthesis). */
  readonly signalsContext?: string
  /** Optional enriched seed string used by the taste filter quality gate. */
  readonly enrichedSeed?: string
  readonly signal?: AbortSignal
}

/**
 * Per-candidate result returned by evaluateCandidates.
 *
 * Phase-3 SIGE hardening extends this contract with optional fields the
 * pipeline-side jury / Pareto-selection step consumes. ALL new fields are
 * OPTIONAL so existing callers (and the legacy title-join read-back) keep
 * compiling and behaving:
 *
 *   description    the evolved/evaluated candidate's text (so the pipeline can
 *                  re-bind Round-3 evolved children it never saw before).
 *   giantScores    per-axis GIANT assessment from the expert agents when they
 *                  emit one; otherwise left undefined for the pipeline jury to
 *                  fill (the native critique never blocks on this).
 *   evidenceRef    signal ids / source refs carried from the candidate so the
 *                  pipeline can re-ground evolved children through verifyEvidence.
 *   dissent        first-class red-team / contrarian disagreement in [0,1]
 *                  (1 = maximally polarizing) — surfaced rather than mean-pooled.
 *   juryScore      0..5 GIANT composite from the independent cross-family jury
 *                  (populated pipeline-side; SIGE leaves it undefined).
 *   juryAgreement  0..1 conformity (inverse of dissent) from the jury.
 *   origin         "seed" for candidates the caller supplied, "evolved" for
 *                  Round-3 mutated/recombined children the title-join used to
 *                  silently drop. The pipeline UNIONs evolved children back in.
 */
export interface CandidateEvaluation {
  readonly title: string
  readonly description?: string
  readonly expertScore: number
  readonly strategicMetadata: StrategicMetadata
  readonly giantScores?: GiantAxisScores
  readonly evidenceRef?: readonly string[]
  readonly dissent?: number
  readonly juryScore?: number
  readonly juryAgreement?: number
  readonly origin?: "seed" | "evolved"
}

const DEFAULT_EVALUATE_CONFIG: SigeSessionConfig = {
  expertRounds: 4,
  socialAgentCount: 20,
  socialRounds: 3,
  maxConcurrentAgents: 4,
  alpha: 0.5,
  incentiveWeights: {
    diversity: 0.25,
    building: 0.2,
    surprise: 0.15,
    accuracyPenalty: 0.1,
    socialViability: 0.3,
  },
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  agentModel: "claude-sonnet-4-6",
}

/**
 * Evaluate externally-supplied candidate ideas through the strategic
 * tournament (rounds 2–4), skipping Round-1 generation.
 *
 * Returns one entry per *retained* candidate AND every Round-3 evolved /
 * recombined child (UNIONed in rather than dropped by a title-join) carrying
 * the agent-graded expertScore, strategic metadata, a first-class `dissent`
 * signal, description + evidenceRef (so the pipeline can re-bind evolved
 * children through verifyEvidence) and an `origin` flag ("seed" | "evolved").
 *
 * SIGE-side fields giantScores/juryScore/juryAgreement are left undefined here;
 * the pipeline's independent cross-family jury fills them. Results are keyed by
 * title (the pipeline reconciles seed entries to its inputs; evolved entries are
 * new titles it never saw before — hence the union).
 *
 * Pipeline-phase entry signature:
 *   evaluateCandidates(candidates, context) =>
 *     Promise<{ title, description?, expertScore, strategicMetadata,
 *               dissent?, evidenceRef?, origin? }[]>
 */
export async function evaluateCandidates(
  candidates: readonly CandidateIdea[],
  context: EvaluateCandidatesContext = {},
): Promise<readonly CandidateEvaluation[]> {
  const { evaluations } = await evaluateCandidatesDetailed(candidates, context)
  return evaluations
}

/**
 * Minimal convergence signal exposed on the detailed result so the pipeline can
 * apply the CONVERGENCE-VETO (sige-select.convergenceVeto). Structurally a
 * subset of MetaGameHealth (which is assignable to it).
 */
export interface ConvergenceSignal {
  readonly convergenceRate: number
  readonly diversityIndex: number
}

/** Detailed evaluate-only result: per-candidate evaluations + convergence. */
export interface EvaluateCandidatesResult {
  readonly evaluations: readonly CandidateEvaluation[]
  /**
   * The round's convergence/diversity signal (from computeMetaGameHealth). When
   * convergenceRate exceeds the pipeline's convergenceVetoThreshold the round
   * has collapsed (sycophancy) and the caller should fall back / widen rather
   * than trust the converged top-K.
   */
  readonly convergence: ConvergenceSignal
}

/**
 * Detailed variant of {@link evaluateCandidates} that ALSO surfaces the
 * convergence signal so the pipeline can apply the convergence-veto. The thin
 * {@link evaluateCandidates} wrapper preserves the original array return for
 * existing callers.
 */
export async function evaluateCandidatesDetailed(
  candidates: readonly CandidateIdea[],
  context: EvaluateCandidatesContext = {},
): Promise<EvaluateCandidatesResult> {
  const sessionId = context.sessionId ?? crypto.randomUUID()
  const userId = context.userId ?? "sige-global"
  const config = context.config ?? DEFAULT_EVALUATE_CONFIG
  const mem0 = context.mem0 ?? fallbackMem0Client()
  const gameFormulation =
    context.gameFormulation ?? buildPlaceholderGameFormulation(sessionId)
  const { signal, signalsContext } = context

  const seededIdeas = mapCandidatesToScoredIdeas(candidates)

  if (seededIdeas.length === 0) {
    log.warn("evaluateCandidates: no usable candidates after mapping — returning empty", {
      sessionId,
      received: candidates.length,
    })
    return { evaluations: [], convergence: { convergenceRate: 0, diversityIndex: 0 } }
  }

  // ── Provenance + grounding lookups (by lowercased title) ──
  // origin: titles present in the seed are "seed"; anything introduced by the
  //   rounds (Round-2 proposals, Round-3 mutations/crossovers) is "evolved".
  // evidenceRef: carried straight from the caller's candidate so evolved
  //   children can be re-grounded pipeline-side via verifyEvidence.
  const seedTitleKeys = new Set(seededIdeas.map((i) => normTitle(i.title)))
  const evidenceByTitle = buildEvidenceRefByTitle(candidates)

  // ── NON-EMPTY enrichedSeed (taste-filter grounding gate must never silently
  // skip). Prefer the caller's enrichedSeed; otherwise synthesize a fallback
  // from the candidates' own text so the grounding gate always has something to
  // anchor on. ──
  const enrichedSeed =
    nonEmpty(context.enrichedSeed) ?? synthesizeFallbackSeed(seededIdeas)

  log.info("evaluateCandidates: starting evaluate-only path", {
    sessionId,
    candidates: seededIdeas.length,
  })

  checkAborted(signal)

  // Synthetic Round 1: candidates injected as if they were generated, so the
  // downstream rounds can consume them via the same SimulationRound contract.
  const sortedSeed = [...seededIdeas].sort((a, b) => b.expertScore - a.expertScore)
  const seedRound: SimulationRound = {
    roundNumber: 1,
    roundType: "divergent_generation",
    agentActions: [],
    outcomes: {
      selectedIdeas: sortedSeed,
      eliminatedIdeas: [],
    },
  }

  // ── Round 2: strategic interaction (agents evaluate the injected candidates) ──
  const round2 = await runStrategicInteraction({
    sessionId,
    gameFormulation,
    round1Results: seedRound,
    mem0,
    userId,
    config,
    signal,
    signalsContext,
  })

  checkAborted(signal)

  // ── Taste filter quality gate (same as the full game) ──
  // enrichedSeed is guaranteed non-empty above, so the grounding gate always
  // runs (never silently skips). A filter failure still degrades gracefully to
  // the unfiltered Round-2 ideas.
  let filteredRound2 = round2
  try {
    const tasteResult = await runTasteFilter({
      ideas: round2.outcomes.selectedIdeas,
      enrichedSeed,
      model: config.model,
      provider: config.provider ?? "anthropic",
      minPassCount: 5,
    })
    filteredRound2 = {
      ...round2,
      outcomes: {
        ...round2.outcomes,
        selectedIdeas: tasteResult.passed,
        eliminatedIdeas: tasteResult.eliminated.map((e) => e.idea.title),
      },
    }
  } catch (err) {
    log.warn("evaluateCandidates: taste filter failed — using unfiltered Round 2", {
      sessionId,
      err,
    })
  }

  // ── Round 3: evolutionary tournament ──
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

  checkAborted(signal)

  // ── Round 4: equilibrium analysis ──
  const round4 = await runEquilibriumAnalysis({
    sessionId,
    gameFormulation,
    round3Results: round3,
    allRounds: [seedRound, round2, round3],
    mem0,
    userId,
    config,
    signal,
    signalsContext,
  })

  const rankedIdeas = round4.outcomes.selectedIdeas

  // ── First-class DISSENT (per title) ──
  // Computed from the spread of the red-team / contrarian evaluators against the
  // rest of the panel, gathered from every round's raw agent evaluations. The
  // legacy aggregation mean-pools these into a single expertScore; here we keep
  // dissent as its own signal so the pipeline's Pareto / Bradley-Terry step can
  // treat a high-dissent + high-score idea as POLARIZING (not noise to penalize).
  // filteredRound2 carries the SAME agentActions as round2 (only its
  // selectedIdeas are taste-filtered), so we include the filtered view alone to
  // avoid double-counting round-2 actions in dissent/health.
  const allRounds: readonly SimulationRound[] = [
    seedRound,
    filteredRound2,
    round3,
    round4,
  ]
  const dissentByTitle = computeDissentByTitle(allRounds)

  // ── CONVERGENCE-VETO signal ──
  // Expose the convergence/diversity signal so the pipeline can gate on a
  // collapsed (over-converged) round rather than trust the top-K. Reuses the
  // same MetaGameHealth machinery as the full game; never throws.
  const health = computeMetaGameHealth(allRounds, getAllDefinitions())
  const convergence: ConvergenceSignal = {
    convergenceRate: health.convergenceRate,
    diversityIndex: health.diversityIndex,
  }

  const evolvedCount = rankedIdeas.filter(
    (idea) => !seedTitleKeys.has(normTitle(idea.title)),
  ).length

  log.info("evaluateCandidates: complete", {
    sessionId,
    evaluated: rankedIdeas.length,
    evolvedChildren: evolvedCount,
    convergenceRate: convergence.convergenceRate,
    diversityIndex: convergence.diversityIndex,
  })

  const evaluations = rankedIdeas.map((idea): CandidateEvaluation => {
    const key = normTitle(idea.title)
    const origin: "seed" | "evolved" = seedTitleKeys.has(key) ? "seed" : "evolved"
    const evidenceRef = evidenceByTitle.get(key)
    const dissent = dissentByTitle.get(key)
    return {
      title: idea.title,
      description: idea.description,
      expertScore: idea.expertScore,
      strategicMetadata: idea.strategicMetadata,
      origin,
      ...(evidenceRef !== undefined ? { evidenceRef } : {}),
      ...(dissent !== undefined ? { dissent } : {}),
    }
  })

  return { evaluations, convergence }
}

// ─── Generation-Only Divergent Entry (flag-gated, pool-merge) ─────────────────
//
// Unlike runExpertGame (full 4-round session) and evaluateCandidates
// (rounds 2–4 scoring), generateDivergentCandidates runs ONLY Round-1
// divergent *generation* across the strongly-divergent personas and returns
// raw candidate ideas — NO scoring, NO social sim, NO equilibrium analysis.
//
// Intended consumer: the ideas synthesizer's "generate wide" path, which
// merges these candidates into its pool (Phase 1) to be scored by the GIANT
// scorecard / evaluated by SIGE later (Phase 3). Because the personas are fed
// the pipeline's grounded chain-of-evidence signals (signalsContext), the
// candidates stay tethered to real signals rather than free-associating.
//
// This path is fully DECOUPLED from config.sige.enabled — that gate only
// governs the standalone polling process. The caller (ideas pipeline) gates
// this behind smart.generateWide.sigeDivergent.

/** Persona roles that lead Round-1 divergent generation. */
const DIVERGENT_PERSONA_ROLES: readonly StrategicAgentRole[] = [
  "contrarian_investor",
  "explorer",
  "founder",
  "user_researcher",
]

/** Options for the generation-only divergent path. */
export interface GenerateDivergentCandidatesOptions {
  /** Grounded chain-of-evidence signals prompt context (keeps candidates tethered). */
  readonly signalsContext?: string
  /** Mem0 client for per-role knowledge filtering; a localhost client is used if absent. */
  readonly mem0?: Mem0Client
  /** Mem0 user id (graph namespace); defaults to "sige-global". */
  readonly userId?: string
  /** Session id used purely for logging/keying; a UUID is minted if absent. */
  readonly sessionId?: string
  /** Game formulation to ground reasoning; a minimal placeholder is synthesized if absent. */
  readonly gameFormulation?: GameFormulation
  /** SIGE session config; defaults to DEFAULT_EVALUATE_CONFIG when absent. */
  readonly config?: SigeSessionConfig
  /**
   * Which divergent persona roles to run. Defaults to
   * [contrarian_investor, explorer, founder, user_researcher].
   */
  readonly roles?: readonly StrategicAgentRole[]
  /** Optional cap on total returned candidates (after extraction). */
  readonly maxCandidates?: number
  readonly signal?: AbortSignal
}

/**
 * Run ONLY Round-1 divergent generation across the divergent personas and
 * return raw candidate ideas for pool merge. Never runs rounds 2–4, social
 * sim, or scoring.
 *
 * Reuses the same Round-1 machinery the full game uses (runSingleAgent →
 * parseAgentAction round 1 → JSON `ideas` array). Fully fault-tolerant: a
 * per-agent failure is swallowed by runAgentTasks; an empty/zero-persona run
 * returns []; the caller's pipeline must never break because this path failed.
 *
 * Pipeline-phase entry signature:
 *   generateDivergentCandidates(opts) =>
 *     Promise<{ title, summary, supportingSignalIds?, proposedBy }[]>
 */
export async function generateDivergentCandidates(
  opts: GenerateDivergentCandidatesOptions = {},
): Promise<readonly DivergentCandidate[]> {
  const sessionId = opts.sessionId ?? crypto.randomUUID()
  const userId = opts.userId ?? "sige-global"
  const config = opts.config ?? DEFAULT_EVALUATE_CONFIG
  const mem0 = opts.mem0 ?? fallbackMem0Client()
  const gameFormulation =
    opts.gameFormulation ?? buildPlaceholderGameFormulation(sessionId)
  const { signalsContext, signal } = opts

  const requestedRoles =
    opts.roles && opts.roles.length > 0 ? opts.roles : DIVERGENT_PERSONA_ROLES

  // Resolve to the subset of requested roles that have definitions, preserving
  // order and dropping unknowns/dupes.
  const allDefs = getAllDefinitions()
  const byRole = new Map(allDefs.map((d) => [d.role, d]))
  const seen = new Set<StrategicAgentRole>()
  const definitions: StrategicAgentDefinition[] = []
  for (const role of requestedRoles) {
    if (seen.has(role)) continue
    seen.add(role)
    const def = byRole.get(role)
    if (def) definitions.push(def)
  }

  if (definitions.length === 0) {
    log.warn("generateDivergentCandidates: no valid divergent personas — returning empty", {
      sessionId,
      requestedRoles,
    })
    return []
  }

  log.info("generateDivergentCandidates: starting generation-only divergent path", {
    sessionId,
    personas: definitions.map((d) => d.role),
  })

  checkAborted(signal)

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

  const candidates = extractDivergentCandidates(actions)

  const capped =
    typeof opts.maxCandidates === "number" && opts.maxCandidates >= 0
      ? candidates.slice(0, opts.maxCandidates)
      : candidates

  log.info("generateDivergentCandidates: complete", {
    sessionId,
    personasResponded: actions.length,
    generated: candidates.length,
    returned: capped.length,
  })

  return capped
}
