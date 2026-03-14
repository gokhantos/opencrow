import { createLogger } from "../logger"
import { chat } from "../agent/chat"
import type { ConversationMessage } from "../agent/types"
import { insightForge, quickSearch } from "./memory/retrieval-modes"
import type { ZepClient } from "./knowledge/zep-client"
import { getAgentActions, getIdeaScores } from "./store"
import { createSemaphore } from "./simulation/concurrency"
import type {
  SigeSession,
  SigeReport,
  FusedScore,
  ScoredIdea,
  IdeaAnalysis,
  MetaGameHealth,
  AgentAction,
  AgentSupportStance,
} from "./types"

const log = createLogger("sige:report-agent")

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GenerateReportParams {
  readonly session: SigeSession
  readonly fusedScores: readonly FusedScore[]
  readonly zep: ZepClient
  readonly userId: string
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}

export async function generateReport(
  params: GenerateReportParams,
): Promise<SigeReport> {
  const { session, fusedScores, zep, userId, model, provider } = params

  log.info("generateReport: starting", {
    sessionId: session.id,
    fusedScoreCount: fusedScores.length,
  })

  const topScores = [...fusedScores]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, 5)

  const [allActions, storedScores] = await Promise.all([
    getAgentActions(session.id).catch((err) => {
      log.warn("generateReport: failed to load agent actions", { err })
      return [] as readonly AgentAction[]
    }),
    getIdeaScores(session.id).catch((err) => {
      log.warn("generateReport: failed to load idea scores", { err })
      return [] as readonly FusedScore[]
    }),
  ])

  const effectiveScores = storedScores.length > 0 ? storedScores : fusedScores

  const topIdeas = resolveTopIdeas(topScores, session)

  // Run sections with concurrency limit (max 3 parallel LLM calls)
  const sem = createSemaphore(3)
  async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    await sem.acquire()
    try {
      return await fn()
    } finally {
      sem.release()
    }
  }

  const sectionResults = await Promise.allSettled([
    throttled(() => generateExecutiveSummary({ session, topScores, topIdeas, model, provider })),
    throttled(() => generateTopIdeasSection({ topIdeas, topScores, allActions, model, provider })),
    throttled(() => generatePerIdeaAnalysis({ session, topIdeas, topScores, allActions, model, provider })),
    throttled(() => generateOpportunityMap({ session, effectiveScores, zep, userId, model, provider })),
    throttled(() => generateRiskAssessment({ session, allActions, topScores, model, provider })),
    throttled(() => generateMetaGameHealthSection({ session, model, provider })),
    throttled(() => generateRecommendedNextSession({ session, topScores, zep, userId, model, provider })),
  ])

  const [
    execSummaryResult,
    topIdeasSectionResult,
    perIdeaAnalysisResult,
    opportunityMapResult,
    riskResult,
    metaHealthResult,
    nextSessionResult,
  ] = sectionResults

  const executiveSummary = extractSettledString(
    execSummaryResult,
    "executive_summary",
    `Session ${session.id} produced ${fusedScores.length} scored ideas. ` +
      `Top idea scored ${topScores[0]?.fusedScore.toFixed(3) ?? "N/A"}.`,
  )

  const topIdeasSection = extractSettledString(
    topIdeasSectionResult,
    "top_ideas_section",
    "",
  )

  const perIdeaAnalysisParsed = extractSettledAnalysis(
    perIdeaAnalysisResult,
    topIdeas,
    topScores,
    allActions,
    session,
  )

  const opportunityMap = extractSettledString(
    opportunityMapResult,
    "opportunity_map",
    "Opportunity mapping unavailable for this session.",
  )

  const riskAssessment = extractSettledString(
    riskResult,
    "risk_assessment",
    "Risk assessment unavailable for this session.",
  )

  const metaGameHealth = extractSettledHealth(
    metaHealthResult,
    session,
  )

  const recommendedNextSession = extractSettledString(
    nextSessionResult,
    "recommended_next_session",
    `Continue exploring the domain seeded by: "${session.seedInput}".`,
  )

  log.info("generateReport: complete", { sessionId: session.id })

  return assembleReport({
    executiveSummary,
    topIdeasSection,
    topIdeas,
    perIdeaAnalysis: perIdeaAnalysisParsed,
    opportunityMap,
    riskAssessment,
    metaGameHealth,
    recommendedNextSession,
    session,
    fusedScores,
  })
}

// ─── Section Generators ───────────────────────────────────────────────────────

async function generateExecutiveSummary(params: {
  readonly session: SigeSession
  readonly topScores: readonly FusedScore[]
  readonly topIdeas: readonly ScoredIdea[]
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<string> {
  const { session, topScores, topIdeas, model, provider } = params

  const context = buildSectionContext("executive_summary", session, topScores)

  const systemPrompt = `You are a strategic intelligence analyst. Write a concise executive summary (2-3 paragraphs) for a game-theoretic simulation session.

Focus on:
- The primary strategic question explored
- The most significant findings and top-ranked ideas
- The overall quality and balance of the simulation

Output plain prose only. No headers, no lists, no markdown.`

  const userMessage = `SESSION CONTEXT:
${context}

TOP IDEAS:
${topIdeas
  .map(
    (idea, i) =>
      `${i + 1}. "${idea.title}" — fused score ${
        topScores.find((s) => s.ideaId === idea.id)?.fusedScore.toFixed(3) ?? "N/A"
      }`,
  )
  .join("\n")}

Write the executive summary.`

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ]

  const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
  return parseReportSection(response.text, "executive_summary")
}

async function generateTopIdeasSection(params: {
  readonly topIdeas: readonly ScoredIdea[]
  readonly topScores: readonly FusedScore[]
  readonly allActions: readonly AgentAction[]
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<string> {
  const { topIdeas, topScores, allActions, model, provider } = params

  const supportingActions = allActions.filter(
    (a) =>
      a.targetIdeas?.some((tid) => topIdeas.some((idea) => idea.id === tid)),
  )

  const systemPrompt = `You are a strategic intelligence analyst. Describe the top-ranked ideas from a game-theoretic simulation.

For each idea, explain:
- Why it scored highly (strategic properties)
- Which agents supported or opposed it
- Its equilibrium properties (Nash, Pareto, etc.)

Output a ranked description in clear prose. Each idea gets a short paragraph.`

  const userMessage = `TOP IDEAS (ranked by fused score):
${topIdeas
  .map((idea, i) => {
    const score = topScores.find((s) => s.ideaId === idea.id)
    return `${i + 1}. ID: ${idea.id}
   Title: "${idea.title}"
   Proposed by: ${idea.proposedBy} (round ${idea.round})
   Expert score: ${idea.expertScore.toFixed(3)} | Social score: ${idea.socialScore?.toFixed(3) ?? "N/A"} | Fused: ${score?.fusedScore.toFixed(3) ?? "N/A"}
   Nash equilibrium: ${idea.strategicMetadata.nashEquilibrium}
   Pareto optimal: ${idea.strategicMetadata.paretoOptimal}
   Dominant strategy: ${idea.strategicMetadata.dominantStrategy}
   Description: ${idea.description.slice(0, 200)}`
  })
  .join("\n\n")}

AGENT ACTIONS TARGETING THESE IDEAS:
${supportingActions.slice(0, 20).map((a) => `- [${a.role}] Round ${a.round}: ${a.actionType} — "${a.content.slice(0, 120)}"`).join("\n")}

Write the top ideas analysis.`

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ]

  const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
  return parseReportSection(response.text, "top_ideas")
}

async function generatePerIdeaAnalysis(params: {
  readonly session: SigeSession
  readonly topIdeas: readonly ScoredIdea[]
  readonly topScores: readonly FusedScore[]
  readonly allActions: readonly AgentAction[]
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<readonly IdeaAnalysis[]> {
  const { session, topIdeas, topScores, allActions, model, provider } = params

  const systemPrompt = `You are a strategic intelligence analyst. Provide a deep analysis of a single idea from a game-theoretic simulation.

Output JSON matching this schema exactly:
{
  "gameContext": "<which game type and round produced this idea>",
  "equilibriumMembership": ["<equilibrium type>", ...],
  "agentSupport": { "<agentId>": "support" | "oppose" | "neutral", ... },
  "socialReception": "<one paragraph on how citizens/social sim received this idea>"
}

Output only valid JSON, no additional text.`

  const analyses = await Promise.allSettled(
    topIdeas.map(async (idea): Promise<IdeaAnalysis> => {
      const ideaActions = allActions.filter(
        (a) => a.targetIdeas?.includes(idea.id),
      )

      const fusedScore = topScores.find((s) => s.ideaId === idea.id)
      const socialActions = session.socialResult?.citizenActions.filter(
        (ca) => ca.targetIdeaId === idea.id,
      ) ?? []

      const userMessage = `IDEA:
ID: ${idea.id}
Title: "${idea.title}"
Description: ${idea.description}
Proposed by: ${idea.proposedBy} (round ${idea.round})
Expert score: ${idea.expertScore.toFixed(3)}
Social score: ${fusedScore?.socialScore.toFixed(3) ?? "N/A"}
Game type: ${session.gameFormulation?.gameType ?? "unknown"}
Equilibria: ${
        session.expertResult?.equilibria
          .filter((eq) => eq.ideas.includes(idea.id))
          .map((eq) => eq.type)
          .join(", ") || "none"
      }

AGENT ACTIONS ON THIS IDEA:
${ideaActions.slice(0, 10).map((a) => `- [${a.agentId}/${a.role}] ${a.actionType}: "${a.content.slice(0, 100)}"`).join("\n") || "None"}

SOCIAL ACTIONS:
${socialActions.slice(0, 8).map((ca) => `- [${ca.citizenId}] ${ca.actionType} (sentiment ${ca.sentiment.toFixed(2)})`).join("\n") || "None"}

Produce the analysis JSON.`

      const messages: readonly ConversationMessage[] = [
        { role: "user", content: userMessage, timestamp: Date.now() },
      ]

      const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
      const parsed = parseIdeaAnalysisJson(response.text, idea, allActions)
      return parsed
    }),
  )

  return analyses.map((result, i) => {
    if (result.status === "fulfilled") return result.value
    log.warn("generatePerIdeaAnalysis: section failed for idea", {
      ideaId: topIdeas[i]?.id,
      err: result.reason,
    })
    return buildFallbackIdeaAnalysis(topIdeas[i]!, allActions)
  })
}

async function generateOpportunityMap(params: {
  readonly session: SigeSession
  readonly effectiveScores: readonly FusedScore[]
  readonly zep: ZepClient
  readonly userId: string
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<string> {
  const { session, effectiveScores, zep, userId, model, provider } = params

  const forgeResult = await insightForge(
    zep,
    userId,
    `unexplored strategy space around: ${session.seedInput}`,
    { maxResults: 12 },
  ).catch((err) => {
    log.warn("generateOpportunityMap: insightForge failed", { err })
    return { facts: [], nodes: [], score: 0 } as const
  })

  const systemPrompt = `You are a strategic intelligence analyst. Identify unexplored opportunities in the strategy space of a simulation session.

Focus on:
- Quadrants of the strategy space that produced no ideas
- Combinations of agent roles that never formed coalitions
- Topics in the knowledge graph that were not addressed by any idea

Output 2-3 paragraphs of plain prose. No headers or lists.`

  const userMessage = `SESSION SEED: "${session.seedInput}"

IDEAS PRODUCED: ${effectiveScores.length}
COVERED IDEA IDs: ${effectiveScores.map((s) => s.ideaId).join(", ")}

KNOWLEDGE GRAPH INSIGHTS (unexplored territory):
${forgeResult.facts.slice(0, 12).map((f) => `- ${f}`).join("\n") || "No graph data available"}

ADJACENT CONCEPTS FROM GRAPH:
${forgeResult.nodes
  .slice(0, 8)
  .map((n) => `- ${n.name} (${n.entityType}): ${n.summary?.slice(0, 80) ?? ""}`)
  .join("\n") || "No adjacent nodes found"}

Describe the unexplored opportunities.`

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ]

  const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
  return parseReportSection(response.text, "opportunity_map")
}

async function generateRiskAssessment(params: {
  readonly session: SigeSession
  readonly allActions: readonly AgentAction[]
  readonly topScores: readonly FusedScore[]
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<string> {
  const { session, allActions, topScores, model, provider } = params

  const adversarialActions = allActions.filter(
    (a) => a.role === "adversarial" || a.actionType === "oppose",
  )

  const eliminatedIdeas = session.expertResult?.rounds.flatMap(
    (r) => r.outcomes.eliminatedIdeas,
  ) ?? []

  const systemPrompt = `You are a strategic intelligence analyst. Assess risks identified during a game-theoretic simulation.

Focus on:
- Ideas that were proposed but eliminated (and why)
- Adversarial agent findings and attack vectors
- Systemic vulnerabilities across the top ideas
- Concrete mitigation strategies for top risks

Output 2-3 paragraphs of plain prose. No headers or lists.`

  const userMessage = `TOP IDEAS (to assess risks for):
${topScores
  .slice(0, 5)
  .map(
    (s) =>
      `- ${s.ideaId}: expert=${s.expertScore.toFixed(3)}, social=${s.socialScore.toFixed(3)}`,
  )
  .join("\n")}

ELIMINATED IDEAS: ${eliminatedIdeas.slice(0, 10).join(", ") || "None recorded"}

ADVERSARIAL / OPPOSING ACTIONS:
${adversarialActions.slice(0, 15).map((a) => `- [${a.role}] Round ${a.round}: "${a.content.slice(0, 120)}"`).join("\n") || "No adversarial actions recorded"}

EMERGENT OPPOSITION FROM SOCIAL SIM:
${session.socialResult?.emergentOpposition.slice(0, 5).join(", ") || "None"}

Write the risk assessment with mitigation strategies.`

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ]

  const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
  return parseReportSection(response.text, "risk_assessment")
}

async function generateMetaGameHealthSection(params: {
  readonly session: SigeSession
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<MetaGameHealth> {
  const { session, model, provider } = params

  const existingHealth = session.expertResult?.metaGameHealth
  if (existingHealth) return existingHealth

  const systemPrompt = `You are a strategic intelligence analyst. Evaluate the meta-game health of a simulation.

Output JSON matching this schema exactly:
{
  "agentBalanceScores": {
    "rational_player": <0-1>,
    "boundedly_rational": <0-1>,
    "cooperative": <0-1>,
    "adversarial": <0-1>,
    "evolutionary": <0-1>,
    "mechanism_designer": <0-1>,
    "explorer": <0-1>,
    "contrarian": <0-1>,
    "signaler": <0-1>,
    "abductive_reasoner": <0-1>
  },
  "diversityIndex": <0-1>,
  "convergenceRate": <0-1>,
  "noveltyScore": <0-1>
}

Output only valid JSON, no additional text.`

  const userMessage = `SESSION CONFIG:
Expert rounds: ${session.config.expertRounds}
Social agent count: ${session.config.socialAgentCount}
Social rounds: ${session.config.socialRounds}
Alpha (expert/social blend): ${session.config.alpha}

ROUNDS COMPLETED: ${session.expertResult?.rounds.length ?? 0}
EQUILIBRIA FOUND: ${session.expertResult?.equilibria.length ?? 0}
TOTAL RANKED IDEAS: ${session.expertResult?.rankedIdeas.length ?? 0}

Produce the meta-game health JSON.`

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ]

  const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
  return parseMetaGameHealthJson(response.text)
}

async function generateRecommendedNextSession(params: {
  readonly session: SigeSession
  readonly topScores: readonly FusedScore[]
  readonly zep: ZepClient
  readonly userId: string
  readonly model: string
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba"
}): Promise<string> {
  const { session, topScores, zep, userId, model, provider } = params

  const adjacentQuery = `strategic follow-up to: ${session.seedInput}`
  const adjacentResult = await quickSearch(zep, userId, adjacentQuery, {
    maxResults: 8,
  }).catch((err) => {
    log.warn("generateRecommendedNextSession: quickSearch failed", { err })
    return { facts: [], nodes: [], score: 0 } as const
  })

  const systemPrompt = `You are a strategic intelligence analyst. Recommend the focus for the next simulation session.

Provide:
- 2-3 concrete seed inputs for the next session
- Which game types would be most productive to explore
- Which agent roles should be emphasized
- What knowledge gaps should be addressed first

Output 2 paragraphs of plain prose followed by a short bulleted list of concrete recommendations.`

  const userMessage = `CURRENT SESSION SEED: "${session.seedInput}"

TOP PERFORMING IDEAS THIS SESSION:
${topScores
  .slice(0, 5)
  .map((s) => `- ${s.ideaId}: fused=${s.fusedScore.toFixed(3)}`)
  .join("\n")}

ADJACENT TOPICS IN KNOWLEDGE GRAPH:
${adjacentResult.facts.slice(0, 8).map((f) => `- ${f}`).join("\n") || "No adjacent facts found"}

ADJACENT ENTITIES:
${adjacentResult.nodes
  .slice(0, 6)
  .map((n) => `- ${n.name} (${n.entityType})`)
  .join("\n") || "None"}

Write the recommended next session plan.`

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ]

  const response = await chat(messages, { systemPrompt, model, provider: provider ?? "alibaba" })
  return parseReportSection(response.text, "recommended_next_session")
}

// ─── Context Builder ──────────────────────────────────────────────────────────

function buildSectionContext(
  section: string,
  session: SigeSession,
  fusedScores: readonly FusedScore[],
): string {
  const baseContext = [
    `Session ID: ${session.id}`,
    `Seed input: "${session.seedInput}"`,
    `Status: ${session.status}`,
    `Game type: ${session.gameFormulation?.gameType ?? "not formulated"}`,
    `Expert rounds: ${session.config.expertRounds}`,
    `Social agents: ${session.config.socialAgentCount}`,
    `Alpha (blend): ${session.config.alpha}`,
    `Total fused scores: ${fusedScores.length}`,
  ]

  if (section === "executive_summary" || section === "top_ideas") {
    const topN = [...fusedScores]
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, 5)
    baseContext.push(
      `Top fused scores: ${topN.map((s) => s.fusedScore.toFixed(3)).join(", ")}`,
    )
  }

  if (section === "meta_game_health") {
    const health = session.expertResult?.metaGameHealth
    if (health) {
      baseContext.push(
        `Diversity index: ${health.diversityIndex.toFixed(3)}`,
        `Convergence rate: ${health.convergenceRate.toFixed(3)}`,
        `Novelty score: ${health.noveltyScore.toFixed(3)}`,
      )
    }
  }

  return baseContext.join("\n")
}

// ─── Output Parsers ───────────────────────────────────────────────────────────

function parseReportSection(rawOutput: string, section: string): string {
  const trimmed = rawOutput.trim()

  // Strip any accidental JSON wrapping
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const key = Object.keys(parsed)[0]
      if (key && typeof parsed[key] === "string") {
        return (parsed[key] as string).trim()
      }
    } catch {
      // Fall through to return raw
    }
  }

  log.debug("parseReportSection: parsed", { section, length: trimmed.length })
  return trimmed
}

function parseIdeaAnalysisJson(
  rawOutput: string,
  idea: ScoredIdea,
  allActions: readonly AgentAction[],
): IdeaAnalysis {
  const trimmed = rawOutput.trim()
  const jsonStart = trimmed.indexOf("{")
  const jsonEnd = trimmed.lastIndexOf("}")

  if (jsonStart === -1 || jsonEnd === -1) {
    return buildFallbackIdeaAnalysis(idea, allActions)
  }

  try {
    const jsonStr = trimmed.slice(jsonStart, jsonEnd + 1)
    const parsed = JSON.parse(jsonStr) as {
      gameContext?: string
      equilibriumMembership?: string[]
      agentSupport?: Record<string, string>
      socialReception?: string
    }

    return {
      idea,
      gameContext: typeof parsed.gameContext === "string" ? parsed.gameContext : "",
      equilibriumMembership: Array.isArray(parsed.equilibriumMembership)
        ? parsed.equilibriumMembership
        : [],
      agentSupport: buildAgentSupportMap(
        parsed.agentSupport ?? {},
        allActions,
        idea.id,
      ),
      socialReception:
        typeof parsed.socialReception === "string" ? parsed.socialReception : "",
    }
  } catch {
    return buildFallbackIdeaAnalysis(idea, allActions)
  }
}

function parseMetaGameHealthJson(rawOutput: string): MetaGameHealth {
  const trimmed = rawOutput.trim()
  const jsonStart = trimmed.indexOf("{")
  const jsonEnd = trimmed.lastIndexOf("}")

  const fallback: MetaGameHealth = {
    agentBalanceScores: {
      rational_player: 0.5,
      boundedly_rational: 0.5,
      cooperative: 0.5,
      adversarial: 0.5,
      evolutionary: 0.5,
      mechanism_designer: 0.5,
      explorer: 0.5,
      contrarian: 0.5,
      signaler: 0.5,
      abductive_reasoner: 0.5,
    },
    diversityIndex: 0.5,
    convergenceRate: 0.5,
    noveltyScore: 0.5,
  }

  if (jsonStart === -1 || jsonEnd === -1) return fallback

  try {
    const jsonStr = trimmed.slice(jsonStart, jsonEnd + 1)
    const parsed = JSON.parse(jsonStr) as Partial<MetaGameHealth>
    return {
      agentBalanceScores: {
        ...fallback.agentBalanceScores,
        ...(typeof parsed.agentBalanceScores === "object"
          ? parsed.agentBalanceScores
          : {}),
      },
      diversityIndex:
        typeof parsed.diversityIndex === "number"
          ? parsed.diversityIndex
          : fallback.diversityIndex,
      convergenceRate:
        typeof parsed.convergenceRate === "number"
          ? parsed.convergenceRate
          : fallback.convergenceRate,
      noveltyScore:
        typeof parsed.noveltyScore === "number"
          ? parsed.noveltyScore
          : fallback.noveltyScore,
    }
  } catch {
    return fallback
  }
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

function assembleReport(params: {
  readonly executiveSummary: string
  readonly topIdeasSection: string
  readonly topIdeas: readonly ScoredIdea[]
  readonly perIdeaAnalysis: readonly IdeaAnalysis[]
  readonly opportunityMap: string
  readonly riskAssessment: string
  readonly metaGameHealth: MetaGameHealth
  readonly recommendedNextSession: string
  readonly session: SigeSession
  readonly fusedScores: readonly FusedScore[]
}): SigeReport {
  const {
    executiveSummary,
    topIdeas,
    perIdeaAnalysis,
    opportunityMap,
    riskAssessment,
    metaGameHealth,
    recommendedNextSession,
  } = params

  return {
    executiveSummary,
    topIdeas,
    perIdeaAnalysis,
    opportunityMap,
    riskAssessment,
    metaGameHealth,
    recommendedNextSession,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTopIdeas(
  topScores: readonly FusedScore[],
  session: SigeSession,
): readonly ScoredIdea[] {
  const ranked = session.expertResult?.rankedIdeas ?? []

  return topScores.map((score): ScoredIdea => {
    const found = ranked.find((r) => r.id === score.ideaId)
    if (found) return found

    // Minimal stub when idea is not in expertResult (social-only session)
    return {
      id: score.ideaId,
      title: score.ideaId,
      description: "",
      proposedBy: "unknown",
      round: 0,
      expertScore: score.expertScore,
      socialScore: score.socialScore,
      fusedScore: score.fusedScore,
      incentiveBreakdown: score.breakdown,
      strategicMetadata: {
        paretoOptimal: false,
        dominantStrategy: false,
        evolutionarilyStable: false,
        nashEquilibrium: false,
      },
    }
  })
}

function buildAgentSupportMap(
  raw: Record<string, string>,
  allActions: readonly AgentAction[],
  ideaId: string,
): Readonly<Record<string, AgentSupportStance>> {
  // Start from LLM output
  const result: Record<string, AgentSupportStance> = {}

  for (const [agentId, stance] of Object.entries(raw)) {
    if (stance === "support" || stance === "oppose" || stance === "neutral") {
      result[agentId] = stance
    }
  }

  // Supplement with action data for agents not already covered
  for (const action of allActions) {
    if (result[action.agentId]) continue
    if (!action.targetIdeas?.includes(ideaId)) continue

    if (action.actionType === "oppose") {
      result[action.agentId] = "oppose"
    } else if (
      action.actionType === "support" ||
      action.actionType === "propose" ||
      action.actionType === "build"
    ) {
      result[action.agentId] = "support"
    } else {
      result[action.agentId] = "neutral"
    }
  }

  return result
}

function buildFallbackIdeaAnalysis(
  idea: ScoredIdea,
  allActions: readonly AgentAction[],
): IdeaAnalysis {
  return {
    idea,
    gameContext: "Analysis unavailable",
    equilibriumMembership: [],
    agentSupport: buildAgentSupportMap({}, allActions, idea.id),
    socialReception: "Social reception analysis unavailable.",
  }
}

function extractSettledString(
  result: PromiseSettledResult<string>,
  section: string,
  fallback: string,
): string {
  if (result.status === "fulfilled") return result.value
  log.warn("generateReport: section failed", { section, err: result.reason })
  return fallback
}

function extractSettledAnalysis(
  result: PromiseSettledResult<readonly IdeaAnalysis[]>,
  topIdeas: readonly ScoredIdea[],
  _topScores: readonly FusedScore[],
  allActions: readonly AgentAction[],
  _session: SigeSession,
): readonly IdeaAnalysis[] {
  if (result.status === "fulfilled") return result.value
  log.warn("generateReport: per_idea_analysis failed", { err: result.reason })
  return topIdeas.map((idea) => buildFallbackIdeaAnalysis(idea, allActions))
}

function extractSettledHealth(
  result: PromiseSettledResult<MetaGameHealth>,
  session: SigeSession,
): MetaGameHealth {
  if (result.status === "fulfilled") return result.value
  log.warn("generateReport: meta_game_health section failed", {
    err: result.reason,
  })

  // Return health from expertResult if available, otherwise a neutral default
  return (
    session.expertResult?.metaGameHealth ?? {
      agentBalanceScores: {
        rational_player: 0.5,
        boundedly_rational: 0.5,
        cooperative: 0.5,
        adversarial: 0.5,
        evolutionary: 0.5,
        mechanism_designer: 0.5,
        explorer: 0.5,
        contrarian: 0.5,
        signaler: 0.5,
        abductive_reasoner: 0.5,
      },
      diversityIndex: 0.5,
      convergenceRate: 0.5,
      noveltyScore: 0.5,
    }
  )
}
