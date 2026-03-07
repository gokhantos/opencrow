import { getDb } from "./db";

export interface StoredSession {
  readonly id: string;
  readonly channel: string;
  readonly chatId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface SessionRow {
  id: string;
  channel: string;
  chat_id: string;
  created_at: number;
  updated_at: number;
}

function rowToSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    channel: row.channel,
    chatId: row.chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getOrCreateSession(
  channel: string,
  chatId: string,
): Promise<StoredSession> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const [row] = await db`
    INSERT INTO sessions (id, channel, chat_id, created_at, updated_at)
    VALUES (${id}, ${channel}, ${chatId}, ${now}, ${now})
    ON CONFLICT (channel, chat_id) DO UPDATE SET updated_at = ${now}
    RETURNING *
  `;

  if (!row) {
    throw new Error(`Failed to get or create session for ${channel}:${chatId}`);
  }

  return rowToSession(row as SessionRow);
}

export async function getAllSessions(
  limit = 200,
): Promise<readonly StoredSession[]> {
  const db = getDb();

  const rows = await db`
    SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ${limit}
  `;

  return (rows as SessionRow[]).map(rowToSession);
}
