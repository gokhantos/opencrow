import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("agent:message-bus");

export interface AgentMessage {
  readonly id: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly topic: string;
  readonly payload: string;
  readonly status: "pending" | "consumed";
  readonly createdAt: number;
  readonly consumedAt: number | null;
}

type MessageHandler = (message: AgentMessage) => void | Promise<void>;

const subscribers = new Map<string, MessageHandler>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Send an async message from one agent to another.
 */
export async function sendAgentMessage(
  fromAgentId: string,
  toAgentId: string,
  topic: string,
  payload: string,
): Promise<string> {
  const db = getDb();
  const rows = await db`
    INSERT INTO agent_messages (from_agent_id, to_agent_id, topic, payload)
    VALUES (${fromAgentId}, ${toAgentId}, ${topic}, ${payload})
    RETURNING id
  `;
  const id = (rows[0] as { id: string }).id;
  log.info("Message sent", { id, from: fromAgentId, to: toAgentId, topic });
  return id;
}

/**
 * Consume pending messages for a given agent. Marks them as consumed atomically.
 */
export async function consumeMessages(
  agentId: string,
  limit = 10,
): Promise<readonly AgentMessage[]> {
  const db = getDb();
  const rows = await db`
    UPDATE agent_messages
    SET status = 'consumed', consumed_at = NOW()
    WHERE id IN (
      SELECT id FROM agent_messages
      WHERE to_agent_id = ${agentId} AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${limit}
    )
    RETURNING
      id,
      from_agent_id  AS "fromAgentId",
      to_agent_id    AS "toAgentId",
      topic,
      payload,
      status,
      EXTRACT(EPOCH FROM created_at)::INT  AS "createdAt",
      EXTRACT(EPOCH FROM consumed_at)::INT AS "consumedAt"
  `;
  return rows as AgentMessage[];
}

/**
 * Get pending message count for an agent.
 */
export async function getPendingCount(agentId: string): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT COUNT(*)::INT AS count
    FROM agent_messages
    WHERE to_agent_id = ${agentId} AND status = 'pending'
  `;
  return (rows[0] as { count: number }).count;
}

/**
 * Get recent messages (for API/debugging).
 */
export async function getRecentMessages(
  agentId?: string,
  limit = 50,
): Promise<readonly AgentMessage[]> {
  const db = getDb();
  const rows = agentId
    ? await db`
        SELECT
          id,
          from_agent_id  AS "fromAgentId",
          to_agent_id    AS "toAgentId",
          topic, payload, status,
          EXTRACT(EPOCH FROM created_at)::INT  AS "createdAt",
          EXTRACT(EPOCH FROM consumed_at)::INT AS "consumedAt"
        FROM agent_messages
        WHERE from_agent_id = ${agentId} OR to_agent_id = ${agentId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    : await db`
        SELECT
          id,
          from_agent_id  AS "fromAgentId",
          to_agent_id    AS "toAgentId",
          topic, payload, status,
          EXTRACT(EPOCH FROM created_at)::INT  AS "createdAt",
          EXTRACT(EPOCH FROM consumed_at)::INT AS "consumedAt"
        FROM agent_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
  return rows as AgentMessage[];
}

/**
 * Subscribe to messages for a given agent. The handler is called for each
 * consumed message during polling.
 */
export function subscribeAgent(
  agentId: string,
  handler: MessageHandler,
): void {
  subscribers.set(agentId, handler);
  log.debug("Agent subscribed to message bus", { agentId });
}

/**
 * Start polling for pending messages. Call once per process.
 */
export function startMessageBusPolling(intervalMs = 5_000): void {
  if (pollTimer) return;

  pollTimer = setInterval(async () => {
    for (const [agentId, handler] of subscribers) {
      try {
        const messages = await consumeMessages(agentId);
        for (const msg of messages) {
          try {
            await handler(msg);
          } catch (err) {
            log.error("Message handler failed", {
              messageId: msg.id,
              agentId,
              error: err,
            });
          }
        }
      } catch (err) {
        log.error("Message bus poll failed", {
          agentId,
          error: err,
        });
      }
    }
  }, intervalMs);

  log.info("Message bus polling started", {
    intervalMs,
    subscribers: [...subscribers.keys()],
  });
}

/**
 * Stop polling.
 */
export function stopMessageBusPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
