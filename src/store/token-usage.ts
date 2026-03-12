import { getDb } from "./db";

export interface TokenUsageRecord {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  readonly provider: string;
  readonly channel: string;
  readonly chatId: string;
  readonly source: "message" | "cron" | "web" | "subagent" | "workflow";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly toolUseCount: number;
  readonly createdAt: number;
}

export interface UsageSummary {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCostUsd: number;
  readonly totalRequests: number;
}

export interface AgentUsageSummary {
  readonly agentId: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCostUsd: number;
  readonly requestCount: number;
}

export interface ModelUsageSummary {
  readonly model: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCostUsd: number;
  readonly requestCount: number;
}

export interface UsageTimePoint {
  readonly bucket: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly requestCount: number;
}

export async function recordTokenUsage(entry: TokenUsageRecord): Promise<void> {
  const db = getDb();
  await db`INSERT INTO token_usage (
    id, agent_id, model, provider, channel, chat_id, source,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    cost_usd, duration_ms, tool_use_count, created_at
  ) VALUES (
    ${entry.id}, ${entry.agentId}, ${entry.model}, ${entry.provider},
    ${entry.channel}, ${entry.chatId}, ${entry.source},
    ${entry.inputTokens}, ${entry.outputTokens},
    ${entry.cacheReadTokens}, ${entry.cacheCreationTokens},
    ${entry.costUsd}, ${entry.durationMs}, ${entry.toolUseCount},
    ${entry.createdAt}
  )`;
}

function buildWhereClause(options: { since?: number; until?: number }): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.since) {
    conditions.push(`created_at >= $${idx}`);
    params.push(options.since);
    idx++;
  }
  if (options.until) {
    conditions.push(`created_at <= $${idx}`);
    params.push(options.until);
    idx++;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

export async function getUsageSummary(options: {
  since?: number;
  until?: number;
}): Promise<UsageSummary> {
  const db = getDb();
  const { where, params } = buildWhereClause(options);
  const rows = (await db.unsafe(
    `SELECT
      COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_input,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
      COALESCE(SUM(cost_usd), 0) AS total_cost,
      COUNT(*) AS total_requests
    FROM token_usage ${where}`,
    params,
  )) as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  return {
    totalInputTokens: Number(row.total_input ?? 0),
    totalOutputTokens: Number(row.total_output ?? 0),
    totalCacheReadTokens: Number(row.total_cache_read ?? 0),
    totalCacheCreationTokens: Number(row.total_cache_creation ?? 0),
    totalCostUsd: Number(row.total_cost ?? 0),
    totalRequests: Number(row.total_requests ?? 0),
  };
}

export async function getUsageByAgent(options: {
  since?: number;
  until?: number;
}): Promise<AgentUsageSummary[]> {
  const db = getDb();
  const { where, params } = buildWhereClause(options);
  const rows = (await db.unsafe(
    `SELECT
      agent_id,
      COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_input,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
      COALESCE(SUM(cost_usd), 0) AS total_cost,
      COUNT(*) AS request_count
    FROM token_usage ${where}
    GROUP BY agent_id
    ORDER BY total_cost DESC`,
    params,
  )) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    agentId: r.agent_id as string,
    totalInputTokens: Number(r.total_input ?? 0),
    totalOutputTokens: Number(r.total_output ?? 0),
    totalCacheReadTokens: Number(r.total_cache_read ?? 0),
    totalCacheCreationTokens: Number(r.total_cache_creation ?? 0),
    totalCostUsd: Number(r.total_cost ?? 0),
    requestCount: Number(r.request_count ?? 0),
  }));
}

export async function getUsageByModel(options: {
  since?: number;
  until?: number;
}): Promise<ModelUsageSummary[]> {
  const db = getDb();
  const { where, params } = buildWhereClause(options);
  const rows = (await db.unsafe(
    `SELECT
      model,
      COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_input,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
      COALESCE(SUM(cost_usd), 0) AS total_cost,
      COUNT(*) AS request_count
    FROM token_usage ${where}
    GROUP BY model
    ORDER BY total_cost DESC`,
    params,
  )) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    model: r.model as string,
    totalInputTokens: Number(r.total_input ?? 0),
    totalOutputTokens: Number(r.total_output ?? 0),
    totalCacheReadTokens: Number(r.total_cache_read ?? 0),
    totalCacheCreationTokens: Number(r.total_cache_creation ?? 0),
    totalCostUsd: Number(r.total_cost ?? 0),
    requestCount: Number(r.request_count ?? 0),
  }));
}

export async function getUsageTimeSeries(options: {
  since?: number;
  granularity: "hour" | "day";
}): Promise<UsageTimePoint[]> {
  const db = getDb();
  const truncInterval = options.granularity === "hour" ? 3600 : 86400;
  const params: unknown[] = [truncInterval];
  let idx = 2;

  const conditions: string[] = [];
  if (options.since) {
    conditions.push(`created_at >= $${idx}`);
    params.push(options.since);
    idx++;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = (await db.unsafe(
    `SELECT
      (created_at / $1) * $1 AS bucket,
      COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_input,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
      COALESCE(SUM(cost_usd), 0) AS total_cost,
      COUNT(*) AS request_count
    FROM token_usage ${where}
    GROUP BY bucket
    ORDER BY bucket ASC`,
    params,
  )) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000).toISOString(),
    inputTokens: Number(r.total_input ?? 0),
    outputTokens: Number(r.total_output ?? 0),
    cacheReadTokens: Number(r.total_cache_read ?? 0),
    cacheCreationTokens: Number(r.total_cache_creation ?? 0),
    costUsd: Number(r.total_cost ?? 0),
    requestCount: Number(r.request_count ?? 0),
  }));
}

export async function getRecentUsage(
  limit: number,
  since?: number,
): Promise<TokenUsageRecord[]> {
  const db = getDb();
  const clampedLimit = Math.max(1, Math.min(limit, 500));
  const params: unknown[] = [clampedLimit];
  let query = "SELECT * FROM token_usage";
  if (since) {
    query += " WHERE created_at >= $2";
    params.push(since);
  }
  query += " ORDER BY created_at DESC LIMIT $1";
  const rows = (await db.unsafe(query, params)) as Array<
    Record<string, unknown>
  >;

  return rows.map((r) => ({
    id: r.id as string,
    agentId: r.agent_id as string,
    model: r.model as string,
    provider: r.provider as string,
    channel: r.channel as string,
    chatId: r.chat_id as string,
    source: r.source as TokenUsageRecord["source"],
    inputTokens:
      Number(r.input_tokens ?? 0) +
      Number(r.cache_read_tokens ?? 0) +
      Number(r.cache_creation_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(r.cache_creation_tokens ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    durationMs: Number(r.duration_ms ?? 0),
    toolUseCount: Number(r.tool_use_count ?? 0),
    createdAt: Number(r.created_at ?? 0),
  }));
}
