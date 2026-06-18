import { getDb } from "../store/db";
import type { ProcessName, ProcessCommand, CommandAction } from "./types";

export async function sendCommand(
  target: ProcessName,
  action: CommandAction,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const payloadJson = JSON.stringify(payload);

  await db`
    INSERT INTO process_commands (id, target, action, payload_json)
    VALUES (${id}, ${target}, ${action}, ${payloadJson})
  `;

  return id;
}

export async function consumePendingCommands(
  target: ProcessName,
): Promise<readonly ProcessCommand[]> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Atomic claim: a single UPDATE ... RETURNING flips acknowledged_at on every
  // currently-pending row and hands them back. This is the claim — not a
  // read-then-update — so two overlapping consumers (e.g. an old + new
  // supervisor briefly co-existing during a takeover) can never both pull the
  // same command and double-execute it. Only the consumer whose UPDATE won the
  // row (NULL → now) receives it; the loser's WHERE clause no longer matches.
  const rows = await db`
    UPDATE process_commands
    SET acknowledged_at = ${now}
    WHERE target = ${target} AND acknowledged_at IS NULL
    RETURNING id, target, action, payload_json, created_at
  `;

  return rows
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      target: r.target as ProcessName,
      action: r.action as CommandAction,
      payload: JSON.parse((r.payload_json as string) || "{}"),
      createdAt: Number(r.created_at),
      acknowledgedAt: now,
    }))
    .sort((a: ProcessCommand, b: ProcessCommand) => a.createdAt - b.createdAt);
}

export async function acknowledgeCommand(id: string): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  await db`
    UPDATE process_commands
    SET acknowledged_at = ${now}
    WHERE id = ${id}
  `;
}

/**
 * Default retention for processed commands, in seconds (15 min).
 *
 * Reconciled with the supervisor's CLEANUP_INTERVAL_MS (5 min): the sweep runs
 * every 5 min and reaps rows older than this, so a processed command lives at
 * most ~retention + one sweep interval. 15 min keeps a short audit window
 * without the previous 1-hour pile-up that the 5-min sweep never matched.
 */
export const DEFAULT_COMMAND_RETENTION_SEC = 900;

export async function cleanupOldCommands(
  olderThanSeconds: number = DEFAULT_COMMAND_RETENTION_SEC,
): Promise<void> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;

  await db`
    DELETE FROM process_commands
    WHERE created_at < ${cutoff}
  `;
}
