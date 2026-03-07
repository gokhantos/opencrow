import { getDb } from "./db";

export type ObservationType =
  | "preference"
  | "decision"
  | "capability"
  | "context"
  | "task"
  | "discovery";

export interface Observation {
  readonly id: string;
  readonly agentId: string;
  readonly channel: string;
  readonly chatId: string;
  readonly observationType: ObservationType;
  readonly title: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly concepts: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly sourceMessageCount: number;
  readonly createdAt: number;
}

interface ObservationRow {
  id: string;
  agent_id: string;
  channel: string;
  chat_id: string;
  observation_type: string;
  title: string;
  summary: string;
  facts_json: string;
  concepts_json: string;
  tools_used_json: string;
  source_message_count: number;
  created_at: number;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    chatId: row.chat_id,
    observationType: row.observation_type as ObservationType,
    title: row.title,
    summary: row.summary,
    facts: JSON.parse(row.facts_json),
    concepts: JSON.parse(row.concepts_json),
    toolsUsed: JSON.parse(row.tools_used_json),
    sourceMessageCount: row.source_message_count,
    createdAt: row.created_at,
  };
}

export async function saveObservations(
  observations: readonly Observation[],
): Promise<void> {
  if (observations.length === 0) return;

  const db = getDb();
  await db.begin(async (tx) => {
    for (const obs of observations) {
      await tx`
        INSERT INTO conversation_observations
          (id, agent_id, channel, chat_id, observation_type, title, summary, facts_json, concepts_json, tools_used_json, source_message_count, created_at)
        VALUES
          (${obs.id}, ${obs.agentId}, ${obs.channel}, ${obs.chatId}, ${obs.observationType}, ${obs.title}, ${obs.summary}, ${JSON.stringify(obs.facts)}, ${JSON.stringify(obs.concepts)}, ${JSON.stringify(obs.toolsUsed)}, ${obs.sourceMessageCount}, ${obs.createdAt})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  });
}

export async function getRecentObservations(
  agentId: string,
  limit: number = 10,
): Promise<readonly Observation[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM conversation_observations
    WHERE agent_id = ${agentId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return (rows as ObservationRow[]).map(rowToObservation);
}

export async function getObservationsByChat(
  channel: string,
  chatId: string,
  limit: number = 10,
): Promise<readonly Observation[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM conversation_observations
    WHERE channel = ${channel} AND chat_id = ${chatId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return (rows as ObservationRow[]).map(rowToObservation);
}

export async function clearObservationsByChat(
  channel: string,
  chatId: string,
): Promise<number> {
  const db = getDb();

  return db.begin(async (tx) => {
    // 1. Get observation IDs for this chat
    const obsRows = await tx`
      SELECT id FROM conversation_observations
      WHERE channel = ${channel} AND chat_id = ${chatId}
    `;
    const obsIds = obsRows.map((r: { id: string }) => r.id);

    if (obsIds.length === 0) return 0;

    // 2. Find memory_sources that indexed any of these observations
    //    Uses JSONB containment instead of LIKE scan
    const obsIdArray = `{${obsIds.join(",")}}`;
    const matchedSourceRows = await tx`
      SELECT DISTINCT id FROM memory_sources
      WHERE kind = 'observation'
      AND metadata_json::JSONB -> 'observationIds' ?| ${obsIdArray}::TEXT[]
    `;
    const sourceIds = matchedSourceRows.map((r: { id: string }) => r.id);

    // 3. Delete memory_chunks and memory_sources for matched sources
    if (sourceIds.length > 0) {
      await tx`DELETE FROM memory_chunks WHERE source_id IN ${tx(sourceIds)}`;
      await tx`DELETE FROM memory_sources WHERE id IN ${tx(sourceIds)}`;
    }

    // 4. Delete from conversation_observations
    const result = await tx`
      DELETE FROM conversation_observations
      WHERE channel = ${channel} AND chat_id = ${chatId}
    `;

    return result.count;
  });
}

export function formatObservationBlock(
  observations: readonly Observation[],
): string {
  if (observations.length === 0) return "";

  const lines = observations.map((obs) => {
    const factsStr =
      obs.facts.length > 0 ? `\n    Facts: ${obs.facts.join("; ")}` : "";
    return `  - [${obs.observationType}] ${obs.title}: ${obs.summary}${factsStr}`;
  });

  return `## Observations from Past Conversations\n${lines.join("\n")}`;
}
