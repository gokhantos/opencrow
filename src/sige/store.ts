import { getDb } from "../store/db"
import type {
  SigeSession,
  SigeSessionStatus,
  SigeSessionConfig,
  AgentAction,
  StrategicAgentRole,
  FusedScore,
  IncentiveBreakdown,
  GameFormulation,
  ExpertGameResult,
  SocialSimResult,
} from "./types"

// ─── Row Mappers ─────────────────────────────────────────────────────────────

function rowToSession(row: Record<string, unknown>): SigeSession {
  const config: SigeSessionConfig = JSON.parse(row.config_json as string)

  const gameFormulation: GameFormulation | undefined =
    row.game_formulation_json
      ? JSON.parse(row.game_formulation_json as string)
      : undefined

  const expertResult: ExpertGameResult | undefined =
    row.expert_result_json
      ? JSON.parse(row.expert_result_json as string)
      : undefined

  const socialResult: SocialSimResult | undefined =
    row.social_result_json
      ? JSON.parse(row.social_result_json as string)
      : undefined

  const fusedScores: readonly FusedScore[] | undefined =
    row.fused_scores_json
      ? JSON.parse(row.fused_scores_json as string)
      : undefined

  return {
    id: row.id as string,
    seedInput: row.seed_input as string,
    status: row.status as SigeSessionStatus,
    config,
    gameFormulation,
    expertResult,
    socialResult,
    fusedScores,
    report: row.report as string | undefined,
    createdAt: new Date((row.created_at as number) * 1000),
    finishedAt:
      row.finished_at != null
        ? new Date((row.finished_at as number) * 1000)
        : undefined,
    error: row.error as string | undefined,
  }
}

function rowToAgentAction(row: Record<string, unknown>): AgentAction {
  return {
    agentId: row.agent_id as string,
    role: row.agent_role as StrategicAgentRole,
    round: row.round as number,
    actionType: row.action_type as string,
    content: row.content as string,
    confidence: (row.confidence as number) ?? 0,
    targetIdeas:
      row.target_ideas_json
        ? JSON.parse(row.target_ideas_json as string)
        : undefined,
    reasoning: (row.reasoning as string) ?? "",
  }
}

function rowToFusedScore(row: Record<string, unknown>): FusedScore {
  const breakdown: IncentiveBreakdown =
    row.incentive_json
      ? JSON.parse(row.incentive_json as string)
      : {
          diversityBonus: 0,
          buildingBonus: 0,
          surpriseBonus: 0,
          accuracyPenalty: 0,
          memoryReward: 0,
          coalitionStability: 0,
          signalCredibility: 0,
          socialViability: 0,
        }

  return {
    ideaId: row.idea_id as string,
    expertScore: (row.expert_score as number) ?? 0,
    socialScore: (row.social_score as number) ?? 0,
    fusedScore: (row.fused_score as number) ?? 0,
    alpha: 0.5,
    breakdown,
  }
}

// ─── Session Operations ───────────────────────────────────────────────────────

export async function createSession(session: {
  readonly id: string
  readonly seedInput: string
  readonly status: SigeSessionStatus
  readonly configJson: string
}): Promise<void> {
  const db = getDb()
  await db`
    INSERT INTO sige_sessions (id, seed_input, status, config_json)
    VALUES (${session.id}, ${session.seedInput}, ${session.status}, ${session.configJson})
  `
}

export async function getSession(id: string): Promise<SigeSession | null> {
  const db = getDb()
  const rows = await db`
    SELECT * FROM sige_sessions WHERE id = ${id}
  `
  if (rows.length === 0) return null
  return rowToSession(rows[0] as Record<string, unknown>)
}

export async function updateSessionStatus(
  id: string,
  status: SigeSessionStatus,
  extra?: {
    readonly gameFormulationJson?: string
    readonly expertResultJson?: string
    readonly socialResultJson?: string
    readonly fusedScoresJson?: string
    readonly report?: string
    readonly error?: string
    readonly finishedAt?: number
  },
): Promise<void> {
  const db = getDb()

  if (!extra || Object.keys(extra).length === 0) {
    await db`
      UPDATE sige_sessions
      SET status = ${status}
      WHERE id = ${id}
    `
    return
  }

  const {
    gameFormulationJson,
    expertResultJson,
    socialResultJson,
    fusedScoresJson,
    report,
    error,
    finishedAt,
  } = extra

  await db`
    UPDATE sige_sessions
    SET
      status                 = ${status},
      game_formulation_json  = COALESCE(${gameFormulationJson ?? null}, game_formulation_json),
      expert_result_json     = COALESCE(${expertResultJson ?? null}, expert_result_json),
      social_result_json     = COALESCE(${socialResultJson ?? null}, social_result_json),
      fused_scores_json      = COALESCE(${fusedScoresJson ?? null}, fused_scores_json),
      report                 = COALESCE(${report ?? null}, report),
      error                  = COALESCE(${error ?? null}, error),
      finished_at            = COALESCE(${finishedAt ?? null}, finished_at)
    WHERE id = ${id}
  `
}

export async function listSessions(options?: {
  readonly status?: SigeSessionStatus
  readonly limit?: number
  readonly offset?: number
}): Promise<readonly SigeSession[]> {
  const db = getDb()
  const limit = options?.limit ?? 50
  const offset = options?.offset ?? 0

  let rows: unknown[]

  if (options?.status) {
    rows = await db`
      SELECT * FROM sige_sessions
      WHERE status = ${options.status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  } else {
    rows = await db`
      SELECT * FROM sige_sessions
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  }

  return (rows as Record<string, unknown>[]).map(rowToSession)
}

export async function getPendingSessions(): Promise<readonly SigeSession[]> {
  const db = getDb()
  const rows = await db`
    SELECT * FROM sige_sessions
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `
  return (rows as Record<string, unknown>[]).map(rowToSession)
}

// ─── Agent Action Operations ──────────────────────────────────────────────────

export async function saveAgentAction(action: {
  readonly id: string
  readonly sessionId: string
  readonly round: number
  readonly agentRole: string
  readonly agentId: string
  readonly actionType: string
  readonly content: string
  readonly confidence?: number
  readonly targetIdeasJson?: string
  readonly reasoning?: string
  readonly score?: number
}): Promise<void> {
  const db = getDb()
  await db`
    INSERT INTO sige_agent_actions
      (id, session_id, round, agent_role, agent_id, action_type, content, confidence, target_ideas_json, reasoning, score)
    VALUES
      (${action.id}, ${action.sessionId}, ${action.round}, ${action.agentRole}, ${action.agentId},
       ${action.actionType}, ${action.content}, ${action.confidence ?? null},
       ${action.targetIdeasJson ?? null}, ${action.reasoning ?? null}, ${action.score ?? null})
  `
}

export async function getAgentActions(
  sessionId: string,
  round?: number,
): Promise<readonly AgentAction[]> {
  const db = getDb()

  let rows: unknown[]

  if (round !== undefined) {
    rows = await db`
      SELECT * FROM sige_agent_actions
      WHERE session_id = ${sessionId} AND round = ${round}
      ORDER BY created_at ASC
    `
  } else {
    rows = await db`
      SELECT * FROM sige_agent_actions
      WHERE session_id = ${sessionId}
      ORDER BY round ASC, created_at ASC
    `
  }

  return (rows as Record<string, unknown>[]).map(rowToAgentAction)
}

// ─── Simulation Result Operations ─────────────────────────────────────────────

export async function saveSimulationResult(result: {
  readonly id: string
  readonly sessionId: string
  readonly layer: "expert" | "social"
  readonly round?: number
  readonly resultJson: string
  readonly score?: number
}): Promise<void> {
  const db = getDb()
  await db`
    INSERT INTO sige_simulation_results (id, session_id, layer, round, result_json, score)
    VALUES (${result.id}, ${result.sessionId}, ${result.layer}, ${result.round ?? null}, ${result.resultJson}, ${result.score ?? null})
  `
}

export async function getSimulationResults(
  sessionId: string,
  layer?: "expert" | "social",
): Promise<
  readonly {
    readonly id: string
    readonly sessionId: string
    readonly layer: string
    readonly round: number | null
    readonly resultJson: string
    readonly score: number | null
  }[]
> {
  const db = getDb()

  let rows: unknown[]

  if (layer !== undefined) {
    rows = await db`
      SELECT id, session_id, layer, round, result_json, score
      FROM sige_simulation_results
      WHERE session_id = ${sessionId} AND layer = ${layer}
      ORDER BY round ASC NULLS FIRST, created_at ASC
    `
  } else {
    rows = await db`
      SELECT id, session_id, layer, round, result_json, score
      FROM sige_simulation_results
      WHERE session_id = ${sessionId}
      ORDER BY layer ASC, round ASC NULLS FIRST, created_at ASC
    `
  }

  return (rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    layer: row.layer as string,
    round: row.round as number | null,
    resultJson: row.result_json as string,
    score: row.score as number | null,
  }))
}

// ─── Idea Score Operations ────────────────────────────────────────────────────

export async function saveIdeaScore(score: {
  readonly id: string
  readonly ideaId: string
  readonly sessionId: string
  readonly expertScore?: number
  readonly socialScore?: number
  readonly fusedScore?: number
  readonly incentiveJson?: string
  readonly strategicMetadataJson?: string
}): Promise<void> {
  const db = getDb()
  await db`
    INSERT INTO sige_idea_scores
      (id, idea_id, session_id, expert_score, social_score, fused_score, incentive_json, strategic_metadata_json)
    VALUES
      (${score.id}, ${score.ideaId}, ${score.sessionId},
       ${score.expertScore ?? null}, ${score.socialScore ?? null}, ${score.fusedScore ?? null},
       ${score.incentiveJson ?? null}, ${score.strategicMetadataJson ?? null})
  `
}

export async function getIdeaScores(
  sessionId: string,
): Promise<readonly FusedScore[]> {
  const db = getDb()
  const rows = await db`
    SELECT * FROM sige_idea_scores
    WHERE session_id = ${sessionId}
    ORDER BY fused_score DESC NULLS LAST
  `
  return (rows as Record<string, unknown>[]).map(rowToFusedScore)
}

export async function getTopIdeas(
  sessionId: string,
  limit = 10,
): Promise<readonly FusedScore[]> {
  const db = getDb()
  const rows = await db`
    SELECT * FROM sige_idea_scores
    WHERE session_id = ${sessionId}
    ORDER BY fused_score DESC NULLS LAST
    LIMIT ${limit}
  `
  return (rows as Record<string, unknown>[]).map(rowToFusedScore)
}

// ─── Population Dynamics Operations ──────────────────────────────────────────

export async function savePopulationDynamic(entry: {
  readonly id: string
  readonly sessionId: string
  readonly strategy: string
  readonly fitness: number
  readonly generation: number
  readonly metadataJson?: string
}): Promise<void> {
  const db = getDb()
  await db`
    INSERT INTO sige_population_dynamics (id, session_id, strategy, fitness, generation, metadata_json)
    VALUES (${entry.id}, ${entry.sessionId}, ${entry.strategy}, ${entry.fitness}, ${entry.generation}, ${entry.metadataJson ?? null})
  `
}

export async function getPopulationDynamics(
  sessionId: string,
): Promise<readonly { readonly strategy: string; readonly fitness: number; readonly generation: number }[]> {
  const db = getDb()
  const rows = await db`
    SELECT strategy, fitness, generation
    FROM sige_population_dynamics
    WHERE session_id = ${sessionId}
    ORDER BY generation ASC, fitness DESC
  `
  return (rows as Record<string, unknown>[]).map((row) => ({
    strategy: row.strategy as string,
    fitness: row.fitness as number,
    generation: row.generation as number,
  }))
}
