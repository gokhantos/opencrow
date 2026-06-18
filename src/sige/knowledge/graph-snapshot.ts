/**
 * graph-snapshot.ts
 *
 * Persists the last non-empty GraphView per userId so the knowledge-graph
 * endpoint can serve a stale-but-useful response when Mem0 is unavailable or
 * returns an empty result.
 *
 * Table: sige_graph_snapshots (created by migration 023_graph_snapshots.sql)
 *   user_id   TEXT PRIMARY KEY
 *   graph_json TEXT NOT NULL        — JSON-serialised GraphView
 *   saved_at   BIGINT NOT NULL      — epoch seconds
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import type { GraphView } from "./graph-query";

const log = createLogger("sige:graph-snapshot");

// ─── Row Type ─────────────────────────────────────────────────────────────────

interface GraphSnapshotRow {
  readonly user_id: string;
  readonly graph_json: string;
  readonly saved_at: number;
}

// ─── Domain Type ──────────────────────────────────────────────────────────────

export interface GraphSnapshot {
  readonly userId: string;
  readonly graph: GraphView;
  readonly savedAt: Date;
}

// ─── Row → Domain ─────────────────────────────────────────────────────────────

function rowToGraphSnapshot(row: GraphSnapshotRow): GraphSnapshot {
  return {
    userId: row.user_id,
    graph: JSON.parse(row.graph_json) as GraphView,
    savedAt: new Date(row.saved_at * 1000),
  };
}

// ─── Store Operations ─────────────────────────────────────────────────────────

/**
 * Loads the most-recently saved snapshot for `userId`.
 * Returns `null` when no snapshot exists yet.
 */
export async function loadSnapshot(userId: string): Promise<GraphSnapshot | null> {
  const db = getDb();
  const rows = await db<GraphSnapshotRow[]>`
    SELECT user_id, graph_json, saved_at
    FROM sige_graph_snapshots
    WHERE user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) return null;
  return rowToGraphSnapshot(row);
}

/**
 * Upserts `graph` as the current snapshot for `userId`.
 * Only call this for non-empty graphs — the graph endpoint checks before saving.
 */
export async function saveSnapshot(userId: string, graph: GraphView): Promise<void> {
  const db = getDb();
  const graphJson = JSON.stringify(graph);
  const savedAt = Math.floor(Date.now() / 1000);

  await db`
    INSERT INTO sige_graph_snapshots (user_id, graph_json, saved_at)
    VALUES (${userId}, ${graphJson}, ${savedAt})
    ON CONFLICT (user_id) DO UPDATE
      SET graph_json = EXCLUDED.graph_json,
          saved_at   = EXCLUDED.saved_at
  `;

  log.debug("graph-snapshot: saved", { userId, savedAt });
}
