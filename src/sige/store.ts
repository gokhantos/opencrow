import { getDb } from "../store/db"
import type {
  SigeSession,
  SigeSessionOrigin,
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

  // seed_input is nullable after migration 020; map NULL -> undefined.
  const seedInput = (row.seed_input as string | null) ?? undefined;
  // origin column added by migration 019; default 'human' for pre-migration rows.
  const origin = ((row.origin as string | null) ?? "human") as SigeSessionOrigin;

  return {
    id: row.id as string,
    seedInput,
    origin,
    // Derive mode from the hydrated origin/seedInput so `session.mode` is always
    // trustworthy for callers (run.ts branches on it; without this it would always
    // be undefined for DB-loaded sessions).
    mode: origin === "auto" || seedInput === undefined ? "autonomous" : "seeded",
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

// ─── Terminal Status ───────────────────────────────────────────────────────────

/**
 * Statuses from which a session never advances. `cancelled` is sticky: once set
 * (by the cancel route, in the WEB process) it must NOT be overwritten by a
 * later `completed`/`failed` write from the still-unwinding run — see
 * `updateSessionStatus`.
 */
const TERMINAL_STATUSES: readonly SigeSessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
]

/** True when `status` is one from which a session never advances. */
export function isTerminalStatus(status: SigeSessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

// ─── Session Operations ───────────────────────────────────────────────────────

export async function createSession(session: {
  readonly id: string
  readonly seedInput?: string | null
  readonly origin: SigeSessionOrigin
  readonly status: SigeSessionStatus
  readonly configJson: string
}): Promise<void> {
  const db = getDb()
  await db`
    INSERT INTO sige_sessions (id, seed_input, origin, status, config_json)
    VALUES (${session.id}, ${session.seedInput ?? null}, ${session.origin}, ${session.status}, ${session.configJson})
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

/**
 * Lightweight status-only read for a session. Returns the current `status`
 * column, or `null` when the session does not exist. Used by the cross-process
 * cancel watcher (`cancel-watcher.ts`) which polls frequently and must not pay
 * the cost of hydrating the full session (config + artifact JSON columns).
 */
export async function getSessionStatus(
  id: string,
): Promise<SigeSessionStatus | null> {
  const db = getDb()
  const rows = await db`
    SELECT status FROM sige_sessions WHERE id = ${id}
  `
  const row = (rows as Record<string, unknown>[])[0]
  if (!row) return null
  return row.status as SigeSessionStatus
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

  // Status-write guard. Two cases require re-reading the current status first:
  //   1. A non-terminal write onto an already-terminal session (legacy guard:
  //      never resurrect a completed/failed/cancelled session to a running stage).
  //   2. A terminal write (completed/failed) onto an already-`cancelled` session.
  //      `cancelled` is sticky: it is set out-of-band by the cancel route while
  //      the run is still unwinding. The run's terminal `completed` write (run.ts)
  //      and the entry's `failed` write on the abort error (entries/sige.ts) would
  //      otherwise clobber it, hiding the cancellation. Cancellation wins.
  const writingTerminal = TERMINAL_STATUSES.includes(status)
  if (!writingTerminal || status !== "cancelled") {
    const existing = await db`SELECT status FROM sige_sessions WHERE id = ${id}`
    const existingStatus = existing.length > 0 ? (existing[0].status as string) : null
    if (existingStatus !== null) {
      if (!writingTerminal && TERMINAL_STATUSES.includes(existingStatus as SigeSessionStatus)) {
        return
      }
      if (writingTerminal && existingStatus === "cancelled") {
        return
      }
    }
  }

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

/**
 * Atomically claim the oldest pending session: flip it off 'pending' (to the
 * first pipeline stage) so no other poll cycle or process can pick it up, and
 * return it. Race-safe via FOR UPDATE SKIP LOCKED — concurrent callers each get
 * a different session or null. Returns null when nothing is pending.
 *
 * Replaces a "SELECT pending then advisory-lock" approach, which was not
 * race-safe under Bun.sql's connection pool (advisory locks are connection-
 * scoped) and left a long window where a slow first stage kept the row 'pending'
 * and re-selectable, spawning duplicate concurrent runs.
 */
export async function claimNextPendingSession(): Promise<SigeSession | null> {
  const db = getDb()
  const rows = await db`
    UPDATE sige_sessions
    SET status = 'knowledge_construction'
    WHERE id = (
      SELECT id FROM sige_sessions
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `
  const row = (rows as Record<string, unknown>[])[0]
  return row ? rowToSession(row) : null
}

// ─── Resume Context ───────────────────────────────────────────────────────────

/**
 * Context persisted to survive a process restart mid-session.
 * Stored as JSONB in `resume_context_json` and read back on the first poll
 * after a restart so the session skips enrichment/discovery and jumps straight
 * into `runSeededSteps`.
 */
export interface ResumeContext {
  readonly enrichedSeed: string;
  readonly signalsContext: string | undefined;
  readonly isScrapedSeed: boolean;
}

/**
 * Persist the resume context for a session. Called once after signal synthesis
 * so a process restart can skip the expensive enrichment/discovery pass.
 */
export async function saveResumeContext(
  sessionId: string,
  ctx: ResumeContext,
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE sige_sessions
    SET resume_context_json = ${JSON.stringify(ctx)}::jsonb
    WHERE id = ${sessionId}
  `;
}

/**
 * Load the persisted resume context for a session. Returns null when no context
 * has been saved (fresh session or context was never reached).
 */
export async function loadResumeContext(
  sessionId: string,
): Promise<ResumeContext | null> {
  const db = getDb();
  const rows = await db`
    SELECT resume_context_json FROM sige_sessions WHERE id = ${sessionId}
  `;
  const row = (rows as Record<string, unknown>[])[0];
  if (!row || row.resume_context_json == null) return null;
  return JSON.parse(row.resume_context_json as string) as ResumeContext;
}

/**
 * Atomically claim the oldest interrupted session: a session stuck in a
 * non-terminal, non-pending status (e.g. expert_game) with no running process.
 * Race-safe via FOR UPDATE SKIP LOCKED. Returns null when nothing is interrupted.
 *
 * On a single-SIGE-process deployment, any such session at startup is guaranteed
 * to be orphaned — its process died. We re-use its current status as the running
 * status (no flip needed beyond the lock).
 */
export async function claimInterruptedSession(): Promise<SigeSession | null> {
  const db = getDb();
  // SET status = status touches the row (acquiring the lock) without changing it.
  // RETURNING * gives us the full row for rowToSession.
  const rows = await db`
    UPDATE sige_sessions
    SET status = status
    WHERE id = (
      SELECT id FROM sige_sessions
      WHERE status NOT IN ('pending', 'completed', 'failed', 'cancelled')
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  const row = (rows as Record<string, unknown>[])[0];
  return row ? rowToSession(row) : null;
}

/**
 * Count autonomous sessions that are currently active (not in a terminal state).
 * Used by the scheduler to enforce single-flight before enqueuing a new session.
 */
export async function countActiveAutonomousSessions(): Promise<number> {
  const db = getDb()
  const rows = await db`
    SELECT COUNT(*) AS cnt FROM sige_sessions
    WHERE origin = 'auto'
      AND status NOT IN ('completed', 'failed', 'cancelled')
  `
  return Number((rows[0] as { cnt: string | number }).cnt)
}

/**
 * Count sessions that are still pending (queued but not yet started), across
 * both human and autonomous origins. Used by the POST /sige/sessions route to
 * enforce a pending-queue ceiling (DoS guard).
 *
 * NOTE: Stage C introduces `countRunnableSessions()` in src/sige/auto/run-guard.ts
 * which also accounts for in-flight (non-terminal) sessions. Once that lands, the
 * route should switch to it; this helper is the minimal pending-only stand-in.
 */
export async function countPendingSessions(): Promise<number> {
  const db = getDb()
  const rows = await db`
    SELECT COUNT(*) AS cnt FROM sige_sessions
    WHERE status = 'pending'
  `
  return Number((rows[0] as { cnt: string | number }).cnt)
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
