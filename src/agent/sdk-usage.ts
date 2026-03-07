/**
 * Usage tracking types and extraction utilities for the Agent SDK.
 */

export interface SdkUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

export function createEmptyUsage(): SdkUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
}

/**
 * Extract usage data from a result message and accumulate into existing usage.
 * Handles both modelUsage (preferred) and top-level usage (fallback) formats.
 */
export function extractUsageFromResult(
  msg: Record<string, unknown>,
  usage: SdkUsage,
): SdkUsage {
  let {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    durationMs,
  } = usage;

  const modelUsage = msg.modelUsage as
    | Record<string, Record<string, unknown>>
    | undefined;

  if (modelUsage) {
    for (const mu of Object.values(modelUsage)) {
      inputTokens += Number(mu.inputTokens ?? 0);
      outputTokens += Number(mu.outputTokens ?? 0);
      cacheReadTokens += Number(mu.cacheReadInputTokens ?? 0);
      cacheCreationTokens += Number(mu.cacheCreationInputTokens ?? 0);
      costUsd += Number(mu.costUSD ?? 0);
    }
  }

  durationMs += Number(msg.duration_ms ?? 0);

  // Fallback: use top-level usage fields if modelUsage isn't present
  if (!modelUsage && msg.usage) {
    const u = msg.usage as Record<string, unknown>;
    inputTokens += Number(u.input_tokens ?? u.inputTokens ?? 0);
    outputTokens += Number(u.output_tokens ?? u.outputTokens ?? 0);
    cacheReadTokens += Number(
      u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0,
    );
    cacheCreationTokens += Number(
      u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0,
    );
  }

  if (typeof msg.total_cost_usd === "number") {
    costUsd = msg.total_cost_usd;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    durationMs,
  };
}
