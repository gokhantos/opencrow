import { getDb } from "../../store/db";

export interface ResearchSignal {
  readonly id: string;
  readonly agent_id: string;
  readonly signal_type: string;
  readonly title: string;
  readonly detail: string;
  readonly source: string;
  readonly source_url: string;
  readonly strength: number;
  readonly themes: string;
  readonly created_at: number;
  readonly consumed: boolean;
}

export interface InsertSignalInput {
  readonly agent_id: string;
  readonly signal_type: string;
  readonly title: string;
  readonly detail: string;
  readonly source: string;
  readonly source_url?: string;
  readonly strength?: number;
  readonly themes?: string;
}

export async function ensureSignalsTable(): Promise<void> {
  const db = getDb();
  await db`
    CREATE TABLE IF NOT EXISTS research_signals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      signal_type TEXT NOT NULL DEFAULT 'trend',
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      strength INTEGER NOT NULL DEFAULT 3,
      themes TEXT NOT NULL DEFAULT '',
      consumed BOOLEAN NOT NULL DEFAULT false,
      created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::int)
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_signals_agent ON research_signals (agent_id, consumed, created_at DESC)`;
}

export async function insertSignal(
  input: InsertSignalInput,
): Promise<ResearchSignal> {
  const db = getDb();
  const id = crypto.randomUUID();

  const rows = await db`
    INSERT INTO research_signals (id, agent_id, signal_type, title, detail, source, source_url, strength, themes)
    VALUES (
      ${id},
      ${input.agent_id},
      ${input.signal_type},
      ${input.title},
      ${input.detail},
      ${input.source},
      ${input.source_url ?? ""},
      ${input.strength ?? 3},
      ${input.themes ?? ""}
    )
    RETURNING *
  `;

  return rows[0] as ResearchSignal;
}

export async function getUnconsumedSignals(
  agentId: string,
  limit = 30,
  maxAgeDays = 0,
): Promise<readonly ResearchSignal[]> {
  const db = getDb();
  if (maxAgeDays > 0) {
    const since = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    return db`
      SELECT * FROM research_signals
      WHERE agent_id = ${agentId} AND consumed = false AND created_at >= ${since}
      ORDER BY strength DESC, created_at DESC
      LIMIT ${limit}
    ` as Promise<ResearchSignal[]>;
  }
  return db`
    SELECT * FROM research_signals
    WHERE agent_id = ${agentId} AND consumed = false
    ORDER BY strength DESC, created_at DESC
    LIMIT ${limit}
  ` as Promise<ResearchSignal[]>;
}

export async function getRecentSignals(
  agentId: string,
  limit = 20,
): Promise<readonly ResearchSignal[]> {
  const db = getDb();
  return db`
    SELECT * FROM research_signals
    WHERE agent_id = ${agentId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  ` as Promise<ResearchSignal[]>;
}

export async function markSignalsConsumed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db`
    UPDATE research_signals
    SET consumed = true
    WHERE id = ANY(${ids as string[]})
  `;
}

export async function getSignalThemes(
  agentId: string,
  daysBack = 14,
): Promise<readonly { theme: string; count: number }[]> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  return db`
    SELECT unnest(string_to_array(themes, ',')) AS theme, COUNT(*)::int AS count
    FROM research_signals
    WHERE agent_id = ${agentId} AND created_at >= ${since} AND themes != ''
    GROUP BY theme
    ORDER BY count DESC
    LIMIT 20
  ` as Promise<{ theme: string; count: number }[]>;
}

export async function getCrossDomainSignals(
  excludeAgentId: string,
  limit = 20,
  maxAgeDays = 14,
): Promise<readonly ResearchSignal[]> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  return db`
    SELECT * FROM research_signals
    WHERE agent_id != ${excludeAgentId}
      AND consumed = false
      AND created_at >= ${since}
      AND strength >= 3
    ORDER BY strength DESC, created_at DESC
    LIMIT ${limit}
  ` as Promise<ResearchSignal[]>;
}

export async function getCrossDomainThemes(
  excludeAgentId: string,
  daysBack = 14,
): Promise<readonly { theme: string; count: number; agents: string }[]> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  return db`
    SELECT
      unnest(string_to_array(themes, ',')) AS theme,
      COUNT(*)::int AS count,
      string_agg(DISTINCT agent_id, ', ') AS agents
    FROM research_signals
    WHERE agent_id != ${excludeAgentId}
      AND created_at >= ${since}
      AND themes != ''
    GROUP BY theme
    ORDER BY count DESC
    LIMIT 20
  ` as Promise<{ theme: string; count: number; agents: string }[]>;
}

export async function archiveStaleSignals(
  maxAgeDays = 14,
): Promise<number> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  const rows = await db`
    UPDATE research_signals
    SET consumed = true
    WHERE consumed = false AND created_at < ${cutoff}
    RETURNING id
  `;
  return rows.length;
}
