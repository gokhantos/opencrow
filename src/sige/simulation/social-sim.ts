import { chat } from "../../agent/chat"
import type { ConversationMessage } from "../../agent/types"
import { createLogger } from "../../logger"
import { saveSimulationResult } from "../store"
import type {
  CitizenAgent,
  CitizenStance,
  SigeSessionConfig,
  SocialSimAction,
  SocialSimResult,
  ScoredIdea,
  RemixVariant,
} from "../types"
import { runWithConcurrency } from "./concurrency"

const log = createLogger("sige:social-sim")

// ─── Constants ────────────────────────────────────────────────────────────────

const PROFESSIONS: readonly string[] = [
  "software engineer",
  "teacher",
  "entrepreneur",
  "journalist",
  "student",
  "policy analyst",
  "investor",
  "scientist",
  "artist",
  "healthcare worker",
  "lawyer",
  "small business owner",
  "retiree",
  "community organizer",
  "data analyst",
]

const BATCH_SIZE = 10

// Stance distribution: ~40% neutral, ~25% supportive, ~20% opposing, ~15% observer
const STANCE_THRESHOLDS: readonly [number, CitizenStance][] = [
  [0.40, "neutral"],
  [0.65, "supportive"],
  [0.85, "opposing"],
  [1.00, "observer"],
]

// ─── Population Generation ────────────────────────────────────────────────────

/**
 * Deterministically generates a citizen population from a seed context.
 * No LLM calls — pure template-based persona creation.
 */
export function generateCitizenPopulation(
  count: number,
  seedContext: string,
): readonly CitizenAgent[] {
  const seed = hashSeed(seedContext)

  return Array.from({ length: count }, (_, i) => {
    const rng = seededRng(seed + i)

    const age = Math.floor(18 + rng() * 57) // 18-75
    const profession = PROFESSIONS[Math.floor(rng() * PROFESSIONS.length)] ?? "student"
    const stance = pickStance(rng())
    const sentimentBias = parseFloat((-0.5 + rng() * 1.0).toFixed(3))
    const activityLevel = parseFloat((0.1 + rng() * 0.9).toFixed(3))
    const influenceWeight = parseFloat((0.1 + rng() * 0.9).toFixed(3))

    const citizen: CitizenAgent = {
      id: `citizen-${i.toString().padStart(4, "0")}`,
      persona: buildPersonaDescription(age, profession, stance, sentimentBias),
      age,
      profession,
      sentimentBias,
      stance,
      activityLevel,
      influenceWeight,
    }
    return citizen
  })
}

function pickStance(r: number): CitizenStance {
  for (const [threshold, stance] of STANCE_THRESHOLDS) {
    if (r < threshold) return stance
  }
  return "observer"
}

function buildPersonaDescription(
  age: number,
  profession: string,
  stance: CitizenStance,
  sentimentBias: number,
): string {
  const sentimentLabel =
    sentimentBias > 0.2
      ? "optimistic"
      : sentimentBias < -0.2
        ? "skeptical"
        : "pragmatic"
  return `${age}-year-old ${profession}, ${sentimentLabel} disposition, ${stance} stance`
}

/** Deterministic integer hash from a string. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h
}

/** Returns a simple seeded pseudo-random function (LCG). */
function seededRng(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

// ─── Batch LLM Call ───────────────────────────────────────────────────────────

interface BatchLlmResponse {
  readonly actions: ReadonlyArray<{
    readonly citizenId: string
    readonly actionType: string
    readonly targetIdeaId: string
    readonly content?: string
    readonly sentiment: number
  }>
  readonly emergentThemes: readonly string[]
  readonly remixes: ReadonlyArray<{
    readonly citizenId: string
    readonly originalIdeaId: string
    readonly remixedContent: string
  }>
}

async function simulateBatch(
  citizens: readonly CitizenAgent[],
  ideas: readonly ScoredIdea[],
  priorContext: string,
  model: string,
  provider?: "openrouter" | "agent-sdk" | "alibaba" | "anthropic",
  signal?: AbortSignal,
): Promise<BatchLlmResponse> {
  const citizenList = citizens
    .map(
      (c) =>
        `- ID: ${c.id} | ${c.persona} | activity: ${c.activityLevel.toFixed(2)}`,
    )
    .join("\n")

  const ideaList = ideas
    .map(
      (idea, idx) =>
        `${idx + 1}. [${idea.id}] "${idea.title}": ${idea.description}`,
    )
    .join("\n")

  const contextBlock =
    priorContext.length > 0
      ? `\nPrevious discussion context:\n${priorContext}\n`
      : ""

  const systemPrompt = [
    "You are a social simulation engine. You simulate realistic citizen reactions",
    "to strategic policy ideas on a public discussion platform.",
    "Always return valid JSON matching the specified schema exactly.",
  ].join(" ")

  const userPrompt = `You are simulating ${citizens.length} citizens reacting to strategic ideas on a discussion platform.

Citizens:
${citizenList}
${contextBlock}
Ideas being discussed:
${ideaList}

For each citizen, decide how they react to each idea based on their persona and stance.
Each citizen should react to the idea that fits their profile most naturally (1 reaction per citizen minimum).
Active citizens (activityLevel > 0.6) may react to multiple ideas.

Each citizen can:
- adopt: actively support and share the idea
- resist: push back with arguments against it
- remix: modify the idea with their own spin
- combine: merge with another idea
- oppose: formally oppose
- ignore: not engage

Return JSON only, no markdown:
{
  "actions": [
    { "citizenId": "...", "actionType": "adopt|resist|remix|combine|oppose|ignore", "targetIdeaId": "...", "content": "brief reaction", "sentiment": 0.0 }
  ],
  "emergentThemes": ["themes that emerged from discussion"],
  "remixes": [
    { "citizenId": "...", "originalIdeaId": "...", "remixedContent": "the modified idea" }
  ]
}`

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: userPrompt,
      timestamp: Date.now(),
    },
  ]

  const response = await chat(messages, {
    systemPrompt,
    model,
    provider: provider ?? "agent-sdk",
    abortSignal: signal,
    rawSystemPrompt: true,
  })

  return parseBatchResponse(response.text)
}

function parseBatchResponse(raw: string): BatchLlmResponse {
  try {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim()
    const parsed = JSON.parse(cleaned) as BatchLlmResponse
    return {
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      emergentThemes: Array.isArray(parsed.emergentThemes)
        ? parsed.emergentThemes
        : [],
      remixes: Array.isArray(parsed.remixes) ? parsed.remixes : [],
    }
  } catch {
    log.warn("Failed to parse batch LLM response, returning empty batch")
    return { actions: [], emergentThemes: [], remixes: [] }
  }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

interface RoundAccumulator {
  readonly allActions: SocialSimAction[]
  readonly allRemixes: RemixVariant[]
  readonly allThemes: string[]
}

function mergeBatchResult(
  acc: RoundAccumulator,
  batch: BatchLlmResponse,
): RoundAccumulator {
  const newActions: SocialSimAction[] = batch.actions
    .filter(
      (a) =>
        a.citizenId &&
        a.targetIdeaId &&
        typeof a.sentiment === "number",
    )
    .map((a) => ({
      citizenId: a.citizenId,
      actionType: a.actionType as SocialSimAction["actionType"],
      targetIdeaId: a.targetIdeaId,
      content: a.content,
      sentiment: Math.max(-1, Math.min(1, a.sentiment)),
    }))

  const newRemixes: RemixVariant[] = batch.remixes
    .filter((r) => r.citizenId && r.originalIdeaId && r.remixedContent)
    .map((r) => ({
      originalIdeaId: r.originalIdeaId,
      citizenId: r.citizenId,
      remixedContent: r.remixedContent,
      adoptionRate: 0, // filled during final aggregation
    }))

  return {
    allActions: [...acc.allActions, ...newActions],
    allRemixes: [...acc.allRemixes, ...newRemixes],
    allThemes: [...acc.allThemes, ...batch.emergentThemes],
  }
}

function aggregateResults(
  accumulated: RoundAccumulator,
  citizenCount: number,
  ideas: readonly ScoredIdea[],
): SocialSimResult {
  const { allActions, allRemixes, allThemes } = accumulated

  const adoptionCounts = new Map<string, number>(ideas.map((i) => [i.id, 0]))
  const sentimentSums = new Map<string, number>(ideas.map((i) => [i.id, 0]))
  const sentimentCounts = new Map<string, number>(ideas.map((i) => [i.id, 0]))
  const remixCounts = new Map<string, number>(ideas.map((i) => [i.id, 0]))

  for (const action of allActions) {
    const id = action.targetIdeaId
    if (action.actionType === "adopt") {
      adoptionCounts.set(id, (adoptionCounts.get(id) ?? 0) + 1)
    }
    if (action.actionType === "remix") {
      remixCounts.set(id, (remixCounts.get(id) ?? 0) + 1)
    }
    sentimentSums.set(id, (sentimentSums.get(id) ?? 0) + action.sentiment)
    sentimentCounts.set(id, (sentimentCounts.get(id) ?? 0) + 1)
  }

  const finalAdoptionRates = Object.fromEntries(
    ideas.map((idea) => [
      idea.id,
      citizenCount > 0 ? (adoptionCounts.get(idea.id) ?? 0) / citizenCount : 0,
    ]),
  )

  const finalSentiment = Object.fromEntries(
    ideas.map((idea) => {
      const cnt = sentimentCounts.get(idea.id) ?? 0
      return [
        idea.id,
        cnt > 0 ? (sentimentSums.get(idea.id) ?? 0) / cnt : 0,
      ]
    }),
  )

  const remixesWithAdoption: readonly RemixVariant[] = allRemixes.map((r) => ({
    ...r,
    adoptionRate:
      citizenCount > 0 ? (remixCounts.get(r.originalIdeaId) ?? 0) / citizenCount : 0,
  }))

  const uniqueThemes = [...new Set(allThemes)].slice(0, 10)

  return {
    citizenActions: allActions,
    adoptionRates: finalAdoptionRates,
    sentimentDistribution: finalSentiment,
    remixVariants: remixesWithAdoption,
    emergentOpposition: uniqueThemes,
  }
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

export async function runSocialSimulation(params: {
  readonly sessionId: string
  readonly ideas: readonly ScoredIdea[]
  readonly citizenCount: number
  readonly rounds: number
  readonly config: SigeSessionConfig
  readonly signal?: AbortSignal
}): Promise<SocialSimResult> {
  const { sessionId, ideas, citizenCount, rounds, config, signal } = params

  log.info("Starting social simulation", { sessionId, citizenCount, rounds, ideaCount: ideas.length })

  const citizens = generateCitizenPopulation(citizenCount, sessionId)
  const batches = chunkArray(citizens, BATCH_SIZE)

  let accumulated: RoundAccumulator = {
    allActions: [],
    allRemixes: [],
    allThemes: [],
  }

  let priorContext = ""

  for (let round = 1; round <= rounds; round++) {
    if (signal?.aborted) {
      log.info("Social simulation aborted", { sessionId, round })
      break
    }

    log.info("Simulating round", { sessionId, round, batchCount: batches.length })

    const batchTasks = batches.map(
      (batch) => () =>
        simulateBatch(batch, ideas, priorContext, config.model, config.provider, signal).catch(
          (err) => {
            log.error("Batch simulation failed, skipping batch", { err, sessionId, round })
            return { actions: [], emergentThemes: [], remixes: [] } as BatchLlmResponse
          },
        ),
    )

    const batchResults = await runWithConcurrency(
      batchTasks,
      config.maxConcurrentAgents,
    )

    for (const result of batchResults) {
      accumulated = mergeBatchResult(accumulated, result)
    }

    const themes = [...new Set(accumulated.allThemes)].slice(0, 5)
    priorContext =
      themes.length > 0
        ? `Round ${round} discussion themes: ${themes.join(", ")}`
        : ""
  }

  const result = aggregateResults(accumulated, citizenCount, ideas)

  await saveSimulationResult({
    id: crypto.randomUUID(),
    sessionId,
    layer: "social",
    resultJson: JSON.stringify(result),
  }).catch((err) =>
    log.error("Failed to persist social simulation result", { err, sessionId }),
  )

  log.info("Social simulation complete", { sessionId, actionCount: result.citizenActions.length })

  return result
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size) as T[])
  }
  return chunks
}
