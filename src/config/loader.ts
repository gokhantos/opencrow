import {
  opencrowConfigSchema,
  agentDefinitionSchema,
  type OpenCrowConfig,
} from "./schema";
import {
  getAllOverrides,
  getOverride,
  type ConfigOverride,
} from "../store/config-overrides";
import {
  getAgentOverrides,
  type AgentOverride,
} from "../store/agent-overrides";
import type { AgentDefinition } from "../agents/types";

function applyEnvOverrides(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };

  // --- channels.telegram ---
  const channels = (result.channels ?? {}) as Record<string, unknown>;
  let telegram = { ...((channels.telegram ?? {}) as Record<string, unknown>) };

  if (process.env.TELEGRAM_BOT_TOKEN) {
    telegram = {
      ...telegram,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    };
  }

  if (process.env.TELEGRAM_ALLOWED_USER_IDS) {
    const ids = process.env.TELEGRAM_ALLOWED_USER_IDS.split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => !Number.isNaN(id));
    telegram = { ...telegram, allowedUserIds: ids };
  }

  result.channels = { ...channels, telegram };

  // --- web ---
  const web = { ...((result.web ?? {}) as Record<string, unknown>) };
  if (process.env.OPENCROW_WEB_HOST) {
    web.host = process.env.OPENCROW_WEB_HOST;
  }
  if (process.env.OPENCROW_WEB_PORT) {
    web.port = Number(process.env.OPENCROW_WEB_PORT);
  }
  result.web = web;

  // --- postgres ---
  if (process.env.DATABASE_URL) {
    const postgres = {
      ...((result.postgres ?? {}) as Record<string, unknown>),
    };
    postgres.url = process.env.DATABASE_URL;
    result.postgres = postgres;
  }

  // --- logLevel ---
  if (process.env.LOG_LEVEL) {
    result.logLevel = process.env.LOG_LEVEL;
  }

  // --- browser ---
  if (process.env.OPENCROW_BROWSER_ENABLED === "true") {
    const existing = (result.browser ?? {}) as Record<string, unknown>;
    result.browser = { ...existing, enabled: true };
  }

  return result;
}

export function loadConfig(): OpenCrowConfig {
  const withEnv = applyEnvOverrides({});
  return opencrowConfigSchema.parse(withEnv);
}

function mergeChannelOverrides(
  base: OpenCrowConfig,
  channelOverrides: readonly ConfigOverride[],
): OpenCrowConfig {
  let channels = base.channels as Record<string, unknown>;
  for (const override of channelOverrides) {
    const existing = (channels[override.key] ?? {}) as Record<string, unknown>;
    const fields = override.value as Record<string, unknown>;
    channels = {
      ...channels,
      [override.key]: { ...existing, ...fields },
    };
  }

  return opencrowConfigSchema.parse({
    ...base,
    channels,
  });
}

/**
 * Apply feature toggle overrides from DB:
 * - features.enabledScrapers → sets scraperProcesses.scraperIds
 * - features.qdrantEnabled → toggles memorySearch on/off
 * - features.marketEnabled → toggles market on/off
 */
async function mergeFeatureOverrides(
  base: OpenCrowConfig,
): Promise<OpenCrowConfig> {
  const [enabledScrapers, qdrantEnabled, marketEnabled, sigeOverride] = await Promise.all([
    getOverride("features", "enabledScrapers"),
    getOverride("features", "qdrantEnabled"),
    getOverride("features", "marketEnabled"),
    getOverride("config", "sige"),
  ]);

  let result: Record<string, unknown> = { ...base };

  if (enabledScrapers !== null) {
    const ids = enabledScrapers as string[];
    const processes = { ...(base.processes as Record<string, unknown>) };
    const scraperProcesses = {
      ...(processes.scraperProcesses as Record<string, unknown>),
      scraperIds: ids,
    };
    result = { ...result, processes: { ...processes, scraperProcesses } };
  }

  if (qdrantEnabled !== null) {
    if (Boolean(qdrantEnabled)) {
      // Enable memorySearch with defaults if not already configured
      if (base.memorySearch === undefined) {
        result = { ...result, memorySearch: {} };
      }
    } else {
      // Disable by removing the memorySearch key
      const { memorySearch: _dropped, ...rest } = result as Record<
        string,
        unknown
      > & { memorySearch?: unknown };
      result = rest;
    }
  }

  if (marketEnabled !== null) {
    if (Boolean(marketEnabled)) {
      // Keep market as-is from base when enabling
    } else {
      // Disable by removing the market key
      const { market: _dropped, ...rest } = result as Record<
        string,
        unknown
      > & { market?: unknown };
      result = rest;
    }
  }

  if (sigeOverride !== null && typeof sigeOverride === "object") {
    result = { ...result, sige: sigeOverride };
  }

  return opencrowConfigSchema.parse(result);
}

/**
 * Loads config from file and applies both channel AND agent overrides from DB.
 * This is the primary loader for runtime use — file stays read-only.
 */
export async function loadConfigWithOverrides(): Promise<OpenCrowConfig> {
  const base = loadConfig();
  const channelOverrides = await getAllOverrides("channels");
  const agentOverrides = await getAgentOverrides();
  const withChannels = mergeChannelOverrides(base, channelOverrides);
  const withAgents = mergeAgentOverrides(withChannels, agentOverrides);
  return mergeFeatureOverrides(withAgents);
}

export type AgentSource = "file" | "file+db" | "db";

export interface AgentWithSource extends AgentDefinition {
  readonly _source: AgentSource;
}

/**
 * Merge agent overrides on top of file-defined agents.
 * - File agent with no override → keep as-is (source: "file")
 * - File agent with DB override → spread DB fields on top (source: "file+db")
 * - File agent with _deleted tombstone → exclude
 * - DB-only agent (not in file) → add (source: "db")
 */
function mergeAgentOverrides(
  base: OpenCrowConfig,
  overrides: readonly AgentOverride[],
): OpenCrowConfig {
  const overrideMap = new Map(overrides.map((o) => [o.id, o]));
  const fileAgentIds = new Set(base.agents.map((a) => a.id));

  // Process file agents
  const merged: AgentDefinition[] = [];
  for (const agent of base.agents) {
    const override = overrideMap.get(agent.id);
    if (!override) {
      merged.push(agent);
      continue;
    }

    // Tombstoned — skip
    if ("_deleted" in override.definition && override.definition._deleted) {
      continue;
    }

    // Merge DB fields on top of file agent
    const { _deleted, ...fields } = override.definition as unknown as Record<
      string,
      unknown
    >;
    const combined = { ...agent, ...fields, id: agent.id };
    merged.push(agentDefinitionSchema.parse(combined));
  }

  // Add DB-only agents
  for (const override of overrides) {
    if (fileAgentIds.has(override.id)) continue;
    if ("_deleted" in override.definition && override.definition._deleted)
      continue;
    merged.push(agentDefinitionSchema.parse(override.definition));
  }

  return opencrowConfigSchema.parse({ ...base, agents: merged });
}

/**
 * Returns merged agents with source annotations for the UI.
 */
export async function getMergedAgentsWithSource(): Promise<
  readonly AgentWithSource[]
> {
  const base = loadConfig();
  const overrides = await getAgentOverrides();
  const overrideMap = new Map(overrides.map((o) => [o.id, o]));
  const fileAgentIds = new Set(base.agents.map((a) => a.id));

  const result: AgentWithSource[] = [];

  for (const agent of base.agents) {
    const override = overrideMap.get(agent.id);
    if (!override) {
      result.push({ ...agent, _source: "file" });
      continue;
    }
    if ("_deleted" in override.definition && override.definition._deleted) {
      continue;
    }
    const { _deleted, ...fields } = override.definition as unknown as Record<
      string,
      unknown
    >;
    const combined = agentDefinitionSchema.parse({
      ...agent,
      ...fields,
      id: agent.id,
    });
    result.push({ ...combined, _source: "file+db" });
  }

  for (const override of overrides) {
    if (fileAgentIds.has(override.id)) continue;
    if ("_deleted" in override.definition && override.definition._deleted)
      continue;
    const parsed = agentDefinitionSchema.parse(override.definition);
    result.push({ ...parsed, _source: "db" });
  }

  return result;
}

/**
 * Compute a hash of the merged agent list for optimistic concurrency.
 */
export function computeMergedAgentHash(
  agents: readonly AgentDefinition[],
): string {
  const canonical = JSON.stringify(agents.map((a) => a.id).sort());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex").slice(0, 16);
}
