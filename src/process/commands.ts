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
  const rows = await db`
    SELECT * FROM process_commands
    WHERE target = ${target} AND acknowledged_at IS NULL
    ORDER BY created_at ASC
  `;

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    target: r.target as ProcessName,
    action: r.action as CommandAction,
    payload: JSON.parse((r.payload_json as string) || "{}"),
    createdAt: Number(r.created_at),
    acknowledgedAt: null,
  }));
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

export async function cleanupOldCommands(
  olderThanSeconds: number = 3600,
): Promise<void> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;

  await db`
    DELETE FROM process_commands
    WHERE created_at < ${cutoff}
  `;
}
