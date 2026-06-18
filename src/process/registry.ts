import { getDb } from "../store/db";
import type { ProcessName, ProcessRecord } from "./types";

export async function registerProcess(
  name: ProcessName,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const pid = process.pid;
  const metadataJson = JSON.stringify(metadata);

  await db`
    INSERT INTO process_registry (name, pid, started_at, last_heartbeat, metadata_json)
    VALUES (${name}, ${pid}, ${now}, ${now}, ${metadataJson})
    ON CONFLICT (name) DO UPDATE SET
      pid = ${pid},
      started_at = ${now},
      last_heartbeat = ${now},
      metadata_json = ${metadataJson}
  `;
}

export async function heartbeat(
  name: ProcessName,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const pid = process.pid;
  const metadataJson = JSON.stringify(metadata);

  // Carry real metadata on BOTH branches. The INSERT branch fires only when the
  // row is missing (e.g. an orphan sweep deleted it); writing the caller's
  // metadata there keeps the instanceId present instead of blanking it to '{}',
  // which would weaken the single-instance guard (instance-guard.ts treats a
  // row without instanceId as ambiguous / non-attributable). The ON CONFLICT
  // branch refreshes metadata too so a recovered row regains its instanceId.
  await db`
    INSERT INTO process_registry (name, pid, started_at, last_heartbeat, metadata_json)
    VALUES (${name}, ${pid}, ${now}, ${now}, ${metadataJson})
    ON CONFLICT (name) DO UPDATE SET
      last_heartbeat = ${now},
      pid = ${pid},
      metadata_json = ${metadataJson}
  `;
}

export async function unregisterProcess(name: ProcessName): Promise<void> {
  const db = getDb();
  await db`DELETE FROM process_registry WHERE name = ${name}`;
}

/** Metadata key set on a process's registry row when it enters crash-loop. */
export const CRASH_LOOP_KEY = "crashLoopAt";

/**
 * Persist a crash-loop transition so other processes can observe it.
 *
 * The orchestrator detects crash-loops in-memory, but the monitor runs in a
 * separate process and shares no in-memory state — so the signal must go
 * through Postgres (the cross-process channel). The crash-looped child is dead
 * and no longer heartbeating, so writing this marker onto its own
 * `process_registry` row is safe (nothing else updates that row). The monitor
 * reads it via {@link listProcesses} and raises a critical alert.
 */
export async function markProcessCrashLoop(name: ProcessName): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const metadataJson = JSON.stringify({ [CRASH_LOOP_KEY]: now });

  await db`
    INSERT INTO process_registry (name, pid, started_at, last_heartbeat, metadata_json)
    VALUES (${name}, ${process.pid}, ${now}, ${now}, ${metadataJson})
    ON CONFLICT (name) DO UPDATE SET
      metadata_json = ${metadataJson}
  `;
}

/**
 * Clear a crash-loop marker once the process is (re)spawned and healthy again.
 * No-op if the row is absent.
 */
export async function clearProcessCrashLoop(name: ProcessName): Promise<void> {
  const db = getDb();
  await db`
    UPDATE process_registry
    SET metadata_json = '{}'
    WHERE name = ${name}
      AND jsonb_exists(metadata_json::jsonb, ${CRASH_LOOP_KEY})
  `;
}

export async function listProcesses(): Promise<readonly ProcessRecord[]> {
  const db = getDb();
  const rows = await db`SELECT * FROM process_registry ORDER BY name`;

  return rows.map((r: Record<string, unknown>) => ({
    name: r.name as ProcessName,
    pid: Number(r.pid),
    startedAt: Number(r.started_at),
    lastHeartbeat: Number(r.last_heartbeat),
    metadata: JSON.parse((r.metadata_json as string) || "{}"),
  }));
}

export async function getProcess(
  name: ProcessName,
): Promise<ProcessRecord | null> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM process_registry WHERE name = ${name}
  `;

  if (rows.length === 0) return null;

  const r = rows[0] as Record<string, unknown>;
  return {
    name: r.name as ProcessName,
    pid: Number(r.pid),
    startedAt: Number(r.started_at),
    lastHeartbeat: Number(r.last_heartbeat),
    metadata: JSON.parse((r.metadata_json as string) || "{}"),
  };
}
