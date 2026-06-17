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

  // --- embeddings ---
  const embeddings = {
    ...((result.embeddings ?? {}) as Record<string, unknown>),
  };
  let embeddingsChanged = false;
  if (process.env.OPENCROW_EMBEDDINGS_PROVIDER) {
    embeddings.provider = process.env.OPENCROW_EMBEDDINGS_PROVIDER;
    embeddingsChanged = true;
  }
  if (process.env.OPENCROW_EMBEDDINGS_BASE_URL) {
    embeddings.baseUrl = process.env.OPENCROW_EMBEDDINGS_BASE_URL;
    embeddingsChanged = true;
  }
  if (process.env.OPENCROW_EMBEDDINGS_MODEL) {
    embeddings.model = process.env.OPENCROW_EMBEDDINGS_MODEL;
    embeddingsChanged = true;
  }
  if (process.env.OPENCROW_EMBEDDINGS_DIMENSIONS) {
    const dims = Number(process.env.OPENCROW_EMBEDDINGS_DIMENSIONS);
    if (!Number.isNaN(dims)) {
      embeddings.dimensions = dims;
      embeddingsChanged = true;
    }
  }
  if (embeddingsChanged) {
    result.embeddings = embeddings;
  }

  // --- pipelines.ideas.smart (env toggles for the smart-pipeline feature flags) ---
  const smartEnv: Record<string, unknown> = {};
  const boolEnv = (name: string): boolean | undefined => {
    const v = process.env[name];
    if (v === undefined) return undefined;
    return v === "true" || v === "1";
  };
  const smartFacets = boolEnv("OPENCROW_SMART_SIGNAL_FACETS");
  if (smartFacets !== undefined) smartEnv.signalFacets = smartFacets;
  const smartRanking = boolEnv("OPENCROW_SMART_SIGNAL_RANKING");
  if (smartRanking !== undefined) smartEnv.signalRanking = smartRanking;
  if (process.env.OPENCROW_SMART_SIGNAL_IMPORTANCE_FLOOR) {
    smartEnv.signalImportanceFloor =
      process.env.OPENCROW_SMART_SIGNAL_IMPORTANCE_FLOOR;
  }
  // OPENCROW_SMART_SIGE_AUTO_* overrides for the autonomous SIGE feature block.
  const sigeAutoEnv: Record<string, unknown> = {};
  const sigeAutoEnabled = boolEnv("OPENCROW_SMART_SIGE_AUTO_ENABLED");
  if (sigeAutoEnabled !== undefined) sigeAutoEnv.enabled = sigeAutoEnabled;
  const sigeAutoMaxDeepFrontiers = Number(process.env.OPENCROW_SMART_SIGE_AUTO_MAX_DEEP_FRONTIERS ?? "");
  if (!Number.isNaN(sigeAutoMaxDeepFrontiers) && process.env.OPENCROW_SMART_SIGE_AUTO_MAX_DEEP_FRONTIERS !== undefined) {
    sigeAutoEnv.maxDeepFrontiers = sigeAutoMaxDeepFrontiers;
  }
  const sigeAutoBroadPoolSize = Number(process.env.OPENCROW_SMART_SIGE_AUTO_BROAD_POOL_SIZE ?? "");
  if (!Number.isNaN(sigeAutoBroadPoolSize) && process.env.OPENCROW_SMART_SIGE_AUTO_BROAD_POOL_SIZE !== undefined) {
    sigeAutoEnv.broadPoolSize = sigeAutoBroadPoolSize;
  }
  if (process.env.OPENCROW_SMART_SIGE_AUTO_CADENCE) {
    sigeAutoEnv.cadence = process.env.OPENCROW_SMART_SIGE_AUTO_CADENCE;
  }
  const sigeAutoMaxConcurrent = Number(process.env.OPENCROW_SMART_SIGE_AUTO_MAX_CONCURRENT ?? "");
  if (!Number.isNaN(sigeAutoMaxConcurrent) && process.env.OPENCROW_SMART_SIGE_AUTO_MAX_CONCURRENT !== undefined) {
    sigeAutoEnv.maxConcurrent = sigeAutoMaxConcurrent;
  }
  const sigeAutoMemoryWriteback = boolEnv("OPENCROW_SMART_SIGE_AUTO_MEMORY_WRITEBACK");
  if (sigeAutoMemoryWriteback !== undefined) sigeAutoEnv.memoryWriteback = sigeAutoMemoryWriteback;

  if (Object.keys(smartEnv).length > 0 || Object.keys(sigeAutoEnv).length > 0) {
    const pipelines = { ...((result.pipelines ?? {}) as Record<string, unknown>) };
    const ideas = { ...((pipelines.ideas ?? {}) as Record<string, unknown>) };
    const existingSmart = (ideas.smart ?? {}) as Record<string, unknown>;
    const smart: Record<string, unknown> = { ...existingSmart, ...smartEnv };
    if (Object.keys(sigeAutoEnv).length > 0) {
      const existingSigeAuto = (existingSmart.sigeAuto ?? {}) as Record<string, unknown>;
      smart.sigeAuto = { ...existingSigeAuto, ...sigeAutoEnv };
    }
    result.pipelines = { ...pipelines, ideas: { ...ideas, smart } };
  }

  // --- sige (Strategic Intelligence Game Engine) ---
  // Env-based enable so SIGE can be turned on consistently across both
  // loadConfig() (no DB) and loadConfigWithOverrides() (DB), instead of
  // relying solely on a DB override that only the override-aware loader sees.
  const sigeEnabled = boolEnv("OPENCROW_SIGE_ENABLED");
  const sigeMem0Url = process.env.OPENCROW_SIGE_MEM0_URL;
  if (sigeEnabled !== undefined || sigeMem0Url) {
    const sige = { ...((result.sige ?? {}) as Record<string, unknown>) };
    if (sigeEnabled !== undefined) sige.enabled = sigeEnabled;
    if (sigeMem0Url) {
      const mem0 = { ...((sige.mem0 ?? {}) as Record<string, unknown>) };
      mem0.baseUrl = sigeMem0Url;
      sige.mem0 = mem0;
    }
    result.sige = sige;
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
 * Deep-merge a DB sige override onto the base sige object derived from
 * env/file configuration.
 *
 * Semantics:
 * - Scalar values present in `override` win over `base`.
 * - Nested object values are shallow-merged (one level deep): keys present in
 *   the override's nested object win; keys absent in the override survive from
 *   `base`. This ensures a DB override of `{"enabled":true}` does not discard
 *   env-derived `mem0.baseUrl`, while a DB override of
 *   `{"mem0":{"baseUrl":"http://x"}}` still lets `mem0.userId` survive from
 *   `base`.
 * - Never mutates either input — builds and returns a new object.
 */
export function deepMergeSigeOverride(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    // Skip prototype-polluting keys. The override originates from a JSON-parsed
    // DB row (config_overrides), so a crafted value could carry an own
    // "__proto__"/"constructor"/"prototype" key. The schema parse downstream
    // strips them, but guard here so the helper stays safe in isolation.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      // Both sides are plain objects: shallow-merge so override keys win but
      // base keys absent from override survive.
      merged[key] = {
        ...(baseVal as Record<string, unknown>),
        ...(overrideVal as Record<string, unknown>),
      };
    } else {
      merged[key] = overrideVal;
    }
  }
  return merged;
}

/**
 * Apply feature toggle overrides from DB:
 * - features.enabledScrapers → sets scraperProcesses.scraperIds
 * - features.qdrantEnabled → toggles memorySearch on/off
 */
async function mergeFeatureOverrides(
  base: OpenCrowConfig,
): Promise<OpenCrowConfig> {
  const [enabledScrapers, qdrantEnabled, sigeOverride] = await Promise.all([
    getOverride("features", "enabledScrapers"),
    getOverride("features", "qdrantEnabled"),
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

  if (sigeOverride !== null && typeof sigeOverride === "object") {
    const baseSige = (result.sige ?? {}) as Record<string, unknown>;
    result = { ...result, sige: deepMergeSigeOverride(baseSige, sigeOverride as Record<string, unknown>) };
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
