import { getDb } from "./db";
import { createLogger } from "../logger";

const log = createLogger("store:routing-rules");

/**
 * Maximum length permitted for a pattern matchValue. Patterns longer than this
 * are almost never legitimate routing values and can trigger catastrophic
 * backtracking in naive RegExp engines.
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * Simple nested-quantifier heuristic: reject patterns whose raw text contains
 * sub-patterns like (a+)+ or (a*)* that are the classic ReDoS shape. This is a
 * conservative heuristic — it may reject some valid patterns — but it never
 * throws and never mis-matches on the hot path.
 */
function isLikelyCatastrophic(pattern: string): boolean {
  return /(\(.*[+*]\))[+*]/.test(pattern);
}

/**
 * Per-process compiled-regex cache keyed by matchValue. A validated pattern is
 * compiled once at rule-load time and reused on every match call. Invalid or
 * rejected patterns are stored as null so we never attempt to recompile them.
 *
 * Exported for testing only — do not use outside of tests.
 */
export const regexCache = new Map<string, RegExp | null>();

/**
 * Compile and cache a routing regex. Returns null when the pattern is over
 * length, looks catastrophic, or fails to compile. Never throws.
 */
function compilePattern(matchValue: string): RegExp | null {
  const cached = regexCache.get(matchValue);
  if (cached !== undefined) return cached;

  if (matchValue.length > MAX_PATTERN_LENGTH) {
    log.warn("Routing rule pattern too long — will not match", {
      length: matchValue.length,
      preview: matchValue.slice(0, 40),
    });
    regexCache.set(matchValue, null);
    return null;
  }

  if (isLikelyCatastrophic(matchValue)) {
    log.warn("Routing rule pattern looks catastrophic — will not match", {
      preview: matchValue.slice(0, 80),
    });
    regexCache.set(matchValue, null);
    return null;
  }

  try {
    const re = new RegExp(matchValue);
    regexCache.set(matchValue, re);
    return re;
  } catch (err) {
    log.warn("Routing rule pattern failed to compile — will not match", {
      preview: matchValue.slice(0, 80),
      err,
    });
    regexCache.set(matchValue, null);
    return null;
  }
}

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

export function matchRule(
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
    case "pattern": {
      const re = compilePattern(rule.matchValue);
      return re !== null && re.test(chatId);
    }
    default:
      return false;
  }
}
