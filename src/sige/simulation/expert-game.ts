import { createLogger } from "../../logger"
import { chat } from "../../agent/chat"
import type { ConversationMessage } from "../../agent/types"
import type { GiantAxisScores } from "../../pipelines/ideas/giant"
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
import { Mem0Client } from "../knowledge/mem0-client"
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
  StrategicMetadata,
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
  const mem0 = context.mem0 ?? new Mem0Client({ baseUrl: "http://localhost:8000" })
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

/** Lowercased, trimmed title used as the stable join key across rounds. */
function normTitle(title: string): string {
  return title.toLowerCase().trim()
}

/** Non-empty string or undefined (trims and treats whitespace-only as empty). */
function nonEmpty(value: string | undefined): string | undefined {
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
 * Minimal placeholder GameFormulation for headless callers that don't run the
 * formulation step. Provides just enough structure for prompt building.
 */
function buildPlaceholderGameFormulation(sessionId: string): GameFormulation {
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
  const mem0 = opts.mem0 ?? new Mem0Client({ baseUrl: "http://localhost:8000" })
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
