import { getDb } from "./db";

export interface RoutingRule {
  readonly id: string;
  readonly channel: string;
  readonly matchType: "chat" | "user" | "group" | "pattern";
  readonly matchValue: string;
  readonly agentId: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly notes: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function rowToRule(r: Record<string, unknown>): RoutingRule {
  return {
    id: r.id as string,
    channel: r.channel as string,
    matchType: r.match_type as RoutingRule["matchType"],
    matchValue: r.match_value as string,
    agentId: r.agent_id as string,
    priority: Number(r.priority ?? 0),
    enabled: Boolean(r.enabled),
    notes: (r.notes as string) ?? null,
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export async function listRoutingRules(
  limit = 100,
): Promise<RoutingRule[]> {
  const db = getDb();
  const rows =
    (await db`SELECT * FROM routing_rules ORDER BY priority DESC LIMIT ${limit}`) as Array<
      Record<string, unknown>
    >;
  return rows.map(rowToRule);
}

export async function getRoutingRulesForChannel(
  channel: string,
): Promise<RoutingRule[]> {
  const db = getDb();
  const rows = (await db`SELECT * FROM routing_rules
    WHERE enabled = true AND (channel = ${channel} OR channel = '*')
    ORDER BY priority DESC`) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

export async function addRoutingRule(
  rule: Omit<RoutingRule, "id" | "createdAt" | "updatedAt">,
): Promise<RoutingRule> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const rows = (await db`INSERT INTO routing_rules (
    id, channel, match_type, match_value, agent_id, priority, enabled, notes, created_at, updated_at
  ) VALUES (
    ${id}, ${rule.channel}, ${rule.matchType}, ${rule.matchValue},
    ${rule.agentId}, ${rule.priority}, ${rule.enabled}, ${rule.notes},
    ${now}, ${now}
  ) RETURNING *`) as Array<Record<string, unknown>>;

  return rowToRule(rows[0]!);
}

export async function updateRoutingRule(
  id: string,
  updates: Partial<
    Pick<RoutingRule, "agentId" | "priority" | "enabled" | "notes">
  >,
): Promise<RoutingRule | null> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const setClauses: string[] = [`updated_at = $1`];
  const params: unknown[] = [now];
  let idx = 2;

  if (updates.agentId !== undefined) {
    setClauses.push(`agent_id = $${idx}`);
    params.push(updates.agentId);
    idx++;
  }
  if (updates.priority !== undefined) {
    setClauses.push(`priority = $${idx}`);
    params.push(updates.priority);
    idx++;
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = $${idx}`);
    params.push(updates.enabled);
    idx++;
  }
  if (updates.notes !== undefined) {
    setClauses.push(`notes = $${idx}`);
    params.push(updates.notes);
    idx++;
  }

  params.push(id);
  const rows = (await db.unsafe(
    `UPDATE routing_rules SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  )) as Array<Record<string, unknown>>;

  return rows.length > 0 ? rowToRule(rows[0]!) : null;
}

export async function removeRoutingRule(id: string): Promise<boolean> {
  const db = getDb();
  const result = await db`DELETE FROM routing_rules WHERE id = ${id}`;
  return (result as { count?: number }).count !== undefined
    ? (result as { count: number }).count > 0
    : (result as unknown[]).length > 0;
}

export async function resolveAgentForMessage(
  channel: string,
  chatId: string,
  senderId: string,
): Promise<string | null> {
  const rules = await getRoutingRulesForChannel(channel);

  for (const rule of rules) {
    const matched = matchRule(rule, chatId, senderId);
    if (matched) {
      return rule.agentId;
    }
  }

  return null;
}

function matchRule(
  rule: RoutingRule,
  chatId: string,
  senderId: string,
): boolean {
  switch (rule.matchType) {
    case "chat":
      return rule.matchValue === chatId;
    case "user":
      return rule.matchValue === senderId;
    case "group":
      return rule.matchValue === chatId;
    case "pattern":
      try {
        const re = new RegExp(rule.matchValue);
        return re.test(chatId);
      } catch {
        return false;
      }
    default:
      return false;
  }
}
