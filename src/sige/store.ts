import { getDb } from "../store/db"
import type {
  SigeSession,
  SigeSessionSummary,
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

  // last_activity_at: NULL for pre-migration rows — map to undefined. Bun.sql
  // returns BIGINT as a string, so convert (not just cast) to a real number —
  // otherwise numeric comparisons on lastActivityAt fail at runtime.
  const lastActivityAt =
    row.last_activity_at != null ? Number(row.last_activity_at) : undefined;

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
    lastActivityAt,
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
    if (TERMINAL_STATUSES.includes(status)) {
      await db`
        UPDATE sige_sessions
        SET
          status      = ${status},
          finished_at = COALESCE(finished_at, EXTRACT(EPOCH FROM NOW())::BIGINT)
        WHERE id = ${id}
      `
    } else {
      await db`
        UPDATE sige_sessions
        SET status = ${status}
        WHERE id = ${id}
      `
    }
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

// ─── Session Summary (light-weight list projection) ───────────────────────────

/**
 * Private row shape for the summary SELECT — only the light columns.
 * The heavy JSON artifact columns are intentionally absent.
 */
interface SigeSessionSummaryRow {
  readonly id: unknown;
  readonly origin: unknown;
  readonly status: unknown;
  readonly seed_input: unknown;
  readonly config_json: unknown;
  readonly created_at: unknown;
  readonly finished_at: unknown;
  readonly last_activity_at: unknown;
  readonly error: unknown;
}

/**
 * Maps a DB summary row to the `SigeSessionSummary` domain type.
 * Heavy artifact columns are NOT present — never pass a full `*` row here.
 */
export function rowToSessionSummary(row: SigeSessionSummaryRow): SigeSessionSummary {
  const config: SigeSessionConfig = JSON.parse(row.config_json as string)

  const seedInput = (row.seed_input as string | null) ?? undefined
  const origin = ((row.origin as string | null) ?? "human") as SigeSessionOrigin

  const lastActivityAt =
    row.last_activity_at != null ? Number(row.last_activity_at) : undefined

  return {
    id: row.id as string,
    seedInput,
    origin,
    status: row.status as SigeSessionStatus,
    config,
    createdAt: new Date((row.created_at as number) * 1000),
    finishedAt:
      row.finished_at != null
        ? new Date((row.finished_at as number) * 1000)
        : undefined,
    lastActivityAt,
    error: (row.error as string | null) ?? undefined,
  }
}

/**
 * List sessions returning only the light columns — omits the heavy artifact
 * JSON columns (`game_formulation_json`, `expert_result_json`,
 * `social_result_json`, `fused_scores_json`, `report`) that can push a
 * full list response into the tens of megabytes.
 *
 * Use `getSession` when the full hydrated session (including artifacts) is needed.
 */
export async function listSessionSummaries(options?: {
  readonly status?: SigeSessionStatus
  readonly limit?: number
  readonly offset?: number
}): Promise<readonly SigeSessionSummary[]> {
  const db = getDb()
  const limit = options?.limit ?? 50
  const offset = options?.offset ?? 0

  let rows: unknown[]

  if (options?.status) {
    rows = await db`
      SELECT id, origin, status, seed_input, config_json,
             created_at, finished_at, last_activity_at, error
      FROM sige_sessions
      WHERE status = ${options.status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  } else {
    rows = await db`
      SELECT id, origin, status, seed_input, config_json,
             created_at, finished_at, last_activity_at, error
      FROM sige_sessions
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  }

  return (rows as SigeSessionSummaryRow[]).map(rowToSessionSummary)
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

// ─── Agent Action Ledger Types ───────────────────────────────────────────────

/**
 * A single agent action as returned by the drill-down ledger endpoint.
 * Includes `score` and `createdAt` which rowToAgentAction (the simulation path)
 * intentionally drops — do NOT merge these types.
 */
export interface AgentActionRecord {
  readonly agentId: string;
  readonly role: string;
  readonly round: number;
  readonly actionType: string;
  /** Raw JSON string as stored in the DB (content column). */
  readonly content: string;
  readonly confidence: number;
  readonly score: number | null;
  readonly targetIdeas: readonly string[];
  readonly reasoning: string;
  /** Epoch seconds, Number()-converted from BIGINT. */
  readonly createdAt: number;
}

/**
 * Per-round simulation artifacts from sige_simulation_results.
 * Any field may be absent when not yet persisted.
 */
export interface RoundArtifacts {
  readonly equilibria?: unknown[];
  readonly coalitions?: unknown[];
  readonly selectedIdeasCount?: number;
  readonly eliminatedIdeasCount?: number;
  readonly metagameHealth?: unknown;
  readonly tasteFilter?: unknown;
}

/** One round of the expert game ledger — actions + optional simulation result. */
export interface RoundLedger {
  readonly round: number;
  readonly actions: readonly AgentActionRecord[];
  readonly artifacts: RoundArtifacts | null;
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

/**
 * Fetch agent actions as `AgentActionRecord[]` for the drill-down ledger.
 * Unlike `getAgentActions` (which uses `rowToAgentAction` and drops score /
 * createdAt to keep the domain type stable), this mapper includes all ledger
 * fields the UI needs. The two functions are intentionally separate.
 */
export async function getAgentActionLedger(
  sessionId: string,
  round?: number,
): Promise<readonly AgentActionRecord[]> {
  const db = getDb();

  let rows: unknown[];

  // Defensive ceiling: a normal session has ≤ a few hundred actions (≤4 expert
  // rounds × bounded agent count), but cap the payload as defense-in-depth so a
  // pathological session can't return an unbounded result set.
  const LEDGER_LIMIT = 5000;

  if (round !== undefined) {
    rows = await db`
      SELECT agent_id, agent_role, round, action_type, content, confidence,
             score, target_ideas_json, reasoning, created_at
      FROM sige_agent_actions
      WHERE session_id = ${sessionId} AND round = ${round}
      ORDER BY created_at ASC
      LIMIT ${LEDGER_LIMIT}
    `;
  } else {
    rows = await db`
      SELECT agent_id, agent_role, round, action_type, content, confidence,
             score, target_ideas_json, reasoning, created_at
      FROM sige_agent_actions
      WHERE session_id = ${sessionId}
      ORDER BY round ASC, created_at ASC
      LIMIT ${LEDGER_LIMIT}
    `;
  }

  return (rows as Record<string, unknown>[]).map(
    (row): AgentActionRecord => ({
      agentId: row.agent_id as string,
      role: row.agent_role as string,
      round: row.round as number,
      actionType: row.action_type as string,
      content: row.content as string,
      confidence: (row.confidence as number) ?? 0,
      score: row.score != null ? Number(row.score) : null,
      targetIdeas: row.target_ideas_json
        ? (JSON.parse(row.target_ideas_json as string) as string[])
        : [],
      reasoning: (row.reasoning as string) ?? "",
      // created_at is stored as BIGINT — Bun.sql returns BIGINT columns as
      // string. Number() converts safely; epoch seconds are well within f64.
      createdAt: Number(row.created_at),
    }),
  );
}

/**
 * Fetch simulation artifacts (equilibria, coalitions, metagame health, taste-
 * filter verdict) for a specific round of a session.
 *
 * We re-use `sige_simulation_results` where `layer = 'expert'`. The result_json
 * blob is a per-round ExpertGameResult partial; we extract the top-level keys
 * the ledger needs. Returns null (graceful-empty) when no row exists.
 */
export async function getRoundArtifacts(
  sessionId: string,
  round: number,
): Promise<RoundArtifacts | null> {
  const db = getDb();
  const rows = await db`
    SELECT result_json
    FROM sige_simulation_results
    WHERE session_id = ${sessionId} AND layer = 'expert' AND round = ${round}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const row = (rows as Record<string, unknown>[])[0];
  if (!row) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.result_json as string) as Record<string, unknown>;
  } catch {
    return null;
  }

  // result_json is a persisted SimulationRound: equilibria/coalitions and the
  // selected/eliminated idea sets live under `outcomes` (RoundOutcome), NOT at
  // the top level. metagameHealth is a whole-game artifact and may be absent
  // per-round; tasteFilter is kept best-effort for forward compatibility.
  const outcomes =
    parsed.outcomes != null && typeof parsed.outcomes === "object"
      ? (parsed.outcomes as Record<string, unknown>)
      : {};

  const artifacts: RoundArtifacts = {
    equilibria: Array.isArray(outcomes.equilibria)
      ? (outcomes.equilibria as unknown[])
      : undefined,
    coalitions: Array.isArray(outcomes.coalitions)
      ? (outcomes.coalitions as unknown[])
      : undefined,
    selectedIdeasCount: Array.isArray(outcomes.selectedIdeas)
      ? (outcomes.selectedIdeas as unknown[]).length
      : undefined,
    eliminatedIdeasCount: Array.isArray(outcomes.eliminatedIdeas)
      ? (outcomes.eliminatedIdeas as unknown[]).length
      : undefined,
    metagameHealth: parsed.metagameHealth ?? parsed.metaGameHealth ?? undefined,
    tasteFilter: parsed.tasteFilter ?? undefined,
  };

  // Graceful-null: if nothing was extractable, signal "no artifacts" rather
  // than an empty object the UI would have to special-case.
  const hasAny = Object.values(artifacts).some((v) => v !== undefined);
  return hasAny ? artifacts : null;
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

// ─── Activity Heartbeat ──────────────────────────────────────────────────────

/**
 * Bump the `last_activity_at` column to now (epoch seconds) for a session.
 *
 * Called at every stage transition and at round/substep completions in
 * expert-game and social-sim so the progress endpoint can detect stalled runs.
 * Cheap: a single UPDATE on the primary key, no read. Fire-and-forget safe —
 * callers may choose to swallow errors (non-fatal to the run itself).
 */
export async function touchSessionActivity(sessionId: string): Promise<void> {
  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  await db`
    UPDATE sige_sessions
    SET last_activity_at = ${nowSec}
    WHERE id = ${sessionId}
  `;
}

// ─── Progress Raw Data ────────────────────────────────────────────────────────

export interface SessionProgressRaw {
  readonly session: {
    readonly id: string;
    readonly status: SigeSessionStatus;
    readonly origin: "human" | "auto";
    readonly createdAt: number;
    readonly finishedAt: number | null;
    readonly lastActivityAt: number | null;
    readonly error: string | null;
  };
  /** Per-round timestamps from sige_agent_actions: round -> {minAt, maxAt, actionCount} */
  readonly expertRounds: ReadonlyMap<number, { readonly minAt: number; readonly maxAt: number; readonly actionCount: number }>;
  /** Per-round timestamps from sige_simulation_results for expert layer */
  readonly expertResultRounds: ReadonlyMap<number, { readonly createdAt: number }>;
  /** Taste-filter result: present when at least one expert action for round>2 exists (proxy) */
  readonly tasteFilterAt: number | null;
  /** Social simulation result created_at (null when not yet done) */
  readonly socialResultAt: number | null;
  /** Count of expert agent actions (used for substep detail) */
  readonly expertActionCount: ReadonlyMap<number, number>;
}

/**
 * Gather all raw data needed to derive SessionProgress in a few queries
 * (never N+1). Returns null when the session does not exist.
 */
export async function getSessionProgressRaw(
  sessionId: string,
): Promise<SessionProgressRaw | null> {
  const db = getDb();

  // ── Session row ──────────────────────────────────────────────────────────────
  const sessionRows = await db`
    SELECT id, status, origin, created_at, finished_at, last_activity_at, error
    FROM sige_sessions
    WHERE id = ${sessionId}
  `;
  const sessionRow = (sessionRows as Record<string, unknown>[])[0];
  if (!sessionRow) return null;

  // ── Expert rounds: min/max created_at and action count per round ─────────────
  const actionRows = await db`
    SELECT round,
           MIN(created_at) AS min_at,
           MAX(created_at) AS max_at,
           COUNT(*) AS action_count
    FROM sige_agent_actions
    WHERE session_id = ${sessionId}
    GROUP BY round
    ORDER BY round ASC
  `;

  const expertRounds = new Map<number, { readonly minAt: number; readonly maxAt: number; readonly actionCount: number }>();
  const expertActionCount = new Map<number, number>();
  for (const row of actionRows as Record<string, unknown>[]) {
    const r = row.round as number;
    expertRounds.set(r, {
      minAt: Number(row.min_at),
      maxAt: Number(row.max_at),
      actionCount: Number(row.action_count),
    });
    expertActionCount.set(r, Number(row.action_count));
  }

  // ── Simulation result rows: expert per-round timestamps ──────────────────────
  const simRows = await db`
    SELECT layer, round, created_at
    FROM sige_simulation_results
    WHERE session_id = ${sessionId}
    ORDER BY layer ASC, round ASC NULLS FIRST
  `;

  const expertResultRounds = new Map<number, { readonly createdAt: number }>();
  let socialResultAt: number | null = null;

  for (const row of simRows as Record<string, unknown>[]) {
    if (row.layer === "expert" && row.round != null) {
      expertResultRounds.set(row.round as number, { createdAt: Number(row.created_at) });
    } else if (row.layer === "social") {
      // Take the latest social result timestamp
      const t = Number(row.created_at);
      if (socialResultAt === null || t > socialResultAt) {
        socialResultAt = t;
      }
    }
  }

  // Taste filter is applied between rounds 2 and 3 of expert game. We infer it
  // completed when round 3 expert actions exist — that's the earliest reliable
  // signal without a dedicated column.
  const round3 = expertRounds.get(3);
  const tasteFilterAt = round3 !== undefined ? round3.minAt : null;

  return {
    session: {
      id: sessionRow.id as string,
      status: sessionRow.status as SigeSessionStatus,
      origin: ((sessionRow.origin as string | null) ?? "human") as "human" | "auto",
      createdAt: Number(sessionRow.created_at),
      finishedAt: sessionRow.finished_at != null ? Number(sessionRow.finished_at) : null,
      lastActivityAt: sessionRow.last_activity_at != null ? Number(sessionRow.last_activity_at) : null,
      error: (sessionRow.error as string | null) ?? null,
    },
    expertRounds,
    expertResultRounds,
    tasteFilterAt,
    socialResultAt,
    expertActionCount,
  };
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

// ─── Ideas Aggregation Query ──────────────────────────────────────────────────

/**
 * Lightweight row shape for the cross-run ideas aggregation query.
 * JSON columns are returned as raw strings and parsed defensively in
 * `aggregate.ts` — this layer never throws on malformed JSON.
 */
export interface AggregationSessionRow {
  readonly id: string;
  readonly seedInput: string | null;
  readonly origin: string;
  readonly status: string;
  readonly createdAt: Date;
  /** Raw JSON string for ExpertGameResult; may be null when not yet computed. */
  readonly expertResultJson: string | null;
  /** Raw JSON string for FusedScore[]; may be null when not yet computed. */
  readonly fusedScoresJson: string | null;
}

/**
 * Fetch the most recent `limit` sessions (by created_at DESC) selecting only
 * the columns needed for cross-run idea aggregation. A SINGLE query — no N+1
 * per-session hydration. JSON columns are returned raw; callers parse them.
 *
 * The `limit` is the number of *sessions* to scan, not the number of ideas.
 * The caller (aggregateIdeas) applies per-idea filters after the fact.
 */
export async function listRecentSessionsForAggregation(
  limit: number,
): Promise<readonly AggregationSessionRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT id, seed_input, origin, status, created_at,
           expert_result_json, fused_scores_json
    FROM sige_sessions
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return (rows as Record<string, unknown>[]).map(
    (row): AggregationSessionRow => ({
      id: row.id as string,
      seedInput: (row.seed_input as string | null) ?? null,
      origin: ((row.origin as string | null) ?? "human"),
      status: row.status as string,
      // created_at is stored as BIGINT (epoch seconds); Bun.sql returns BIGINT
      // as a string — convert to Date via epoch-ms arithmetic.
      createdAt: new Date(Number(row.created_at) * 1000),
      expertResultJson: (row.expert_result_json as string | null) ?? null,
      fusedScoresJson: (row.fused_scores_json as string | null) ?? null,
    }),
  );
}
