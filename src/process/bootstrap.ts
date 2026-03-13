import type { OpenCrowConfig } from "../config/schema";
import type { AgentOptions, ProgressEvent } from "../agent/types";
import type { ToolRegistry } from "../tools/registry";
import type { ResolvedAgent } from "../agents/types";
import type { MemoryManager } from "../memory/types";
import type { CronToolConfig } from "../tools/cron";
import { initDb } from "../store/db";
import { createToolRegistry } from "../tools/registry";
import { createToolRouter } from "../tools/router";
import { createAgentRegistry, type AgentRegistry } from "../agents/registry";
import { loadConfigWithOverrides } from "../config/loader";
import { createSubAgentTracker } from "../agents/tracker";
import { createListSkillsTool } from "../tools/list-skills";
import { createUseSkillTool } from "../tools/use-skill";
import { readSkillContent } from "../skills/loader";
import { getAgentMemories, formatMemoryBlock } from "../store/memory";
import {
  getRecentObservations,
  formatObservationBlock,
} from "../store/observations";
import {
  createObservationHook,
  type ObservationHook,
} from "../memory/observation-hook";
import { buildSdkHooks } from "../agent/hooks";
import { createMemoryManager } from "../memory/manager";
import { createEmbeddingProviderFromConfig } from "../memory/embeddings";
import { createQdrantClient } from "../memory/qdrant";
import { initQuestDBReadOnly } from "../sources/markets/questdb";
import {
  buildRegistryForAgent as buildRegistry,
  buildWorkflowToolRegistry,
  type ToolBuilderDeps,
} from "./tool-builder";
import {
  createLogger,
  setLogLevel,
  setProcessName,
  startLogPersistence,
} from "../logger";

const log = createLogger("bootstrap");

export interface BootstrapContext {
  readonly config: OpenCrowConfig;
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry | null;
  readonly workflowToolRegistry: ToolRegistry | null;
  readonly memoryManager: MemoryManager | null;
  readonly observationHook: ObservationHook | null;
  readonly subAgentTracker: ReturnType<typeof createSubAgentTracker>;
  readonly buildRegistryForAgent: (
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
  ) => ToolRegistry | null;
  readonly buildOptionsForAgent: (
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
    cwd?: string,
  ) => Promise<AgentOptions>;
  readonly enrichSystemPrompt: (
    agent: ResolvedAgent,
    basePrompt: string,
  ) => Promise<string>;
  /** Invalidate the per-agent tool registry cache. Called automatically on agentRegistry.reload(). */
  readonly clearRegistryCache: () => void;
  /** Release background timers (e.g. Qdrant recovery probe). Call on shutdown. */
  readonly dispose: () => void;
  // Mutable: set by gateway after cron is initialized
  cronToolConfig: CronToolConfig | null;
}

export interface BootstrapOpts {
  readonly config: OpenCrowConfig;
  readonly processName?: string;
  readonly skipMemory?: boolean;
  readonly skipObservations?: boolean;
  readonly dbPoolSize?: number;
}

function buildAgentOptions(
  agent: ResolvedAgent,
  toolRegistry: ToolRegistry | null,
  maxIterations: number,
  cwd?: string,
): AgentOptions {
  return {
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    provider: agent.provider,
    toolsEnabled: toolRegistry !== null,
    agentId: agent.id,
    toolRegistry: toolRegistry ?? undefined,
    maxToolIterations: maxIterations,
    maxOutputTokens: agent.maxOutputTokens,
    reasoning: agent.reasoning,
    modelParams: agent.modelParams,
    browserEnabled: agent.mcpServers?.browser ?? false,
    githubEnabled: agent.mcpServers?.github ?? false,
    context7Enabled: agent.mcpServers?.context7 ?? false,
    sequentialThinkingEnabled: agent.mcpServers?.sequentialThinking ?? false,
    dbhubEnabled: agent.mcpServers?.dbhub ?? false,
    filesystemEnabled: agent.mcpServers?.filesystem ?? false,
    gitEnabled: agent.mcpServers?.git ?? false,
    qdrantEnabled: agent.mcpServers?.qdrant ?? false,
    braveSearchEnabled: agent.mcpServers?.braveSearch ?? false,
    firecrawlEnabled: agent.mcpServers?.firecrawl ?? false,
    serenaEnabled: agent.mcpServers?.serena ?? false,
    hooksConfig: agent.hooks,
    cwd: cwd ?? process.cwd(),
  };
}

export async function bootstrap(
  opts: BootstrapOpts,
): Promise<BootstrapContext> {
  const { config } = opts;

  if (opts.processName) setProcessName(opts.processName);
  setLogLevel(config.logLevel);

  const dbUrl = process.env.DATABASE_URL ?? config.postgres.url;
  const db = await initDb(dbUrl, { max: opts.dbPoolSize ?? 5 });
  startLogPersistence(db);
  log.info("Database initialized (PostgreSQL)");

  const mergedConfig = await loadConfigWithOverrides();

  const { getOverride } = await import("../store/config-overrides");
  const disabledToolsRaw = await getOverride("tools", "disabledTools");
  const disabledTools = new Set<string>(
    Array.isArray(disabledToolsRaw) ? (disabledToolsRaw as string[]) : [],
  );

  const agentRegistry = createAgentRegistry(mergedConfig.agents, mergedConfig.agent);
  const subAgentTracker = createSubAgentTracker();

  let baseToolRegistry: ToolRegistry | null = null;
  let toolRouter: ReturnType<typeof createToolRouter> | null = null;
  if (config.tools !== undefined) {
    const registry = createToolRegistry(config.tools).withTools([
      createListSkillsTool(),
      createUseSkillTool(),
    ]);
    toolRouter = createToolRouter(registry.definitions);
    baseToolRegistry = registry.withRouter(toolRouter);
    log.info("Tool registry initialized", {
      toolCount: baseToolRegistry.definitions.length,
      allowedDirs: config.tools.allowedDirectories,
      smartRouting: true,
    });
  }

  let memoryManager: MemoryManager | null = null;
  let qdrantClientRef: import("../memory/qdrant").QdrantClient | null = null;
  if (!opts.skipMemory && mergedConfig.memorySearch !== undefined) {
    const { getSecret } = await import("../config/secrets");
    const { getOverride } = await import("../store/config-overrides");
    const { embeddingsConfigSchema } = await import("../config/schema");
    const embeddingsOverride = await getOverride("features", "embeddings");
    const embeddingsConfig = embeddingsConfigSchema.parse(
      embeddingsOverride ?? mergedConfig.embeddings ?? {},
    );
    const apiKey =
      (await getSecret("OPENROUTER_API_KEY")) ?? (await getSecret("VOYAGE_API_KEY")) ?? undefined;
    const embeddingProvider = createEmbeddingProviderFromConfig(
      embeddingsConfig,
      apiKey,
    );

    const memSearch = mergedConfig.memorySearch!;
    const qdrantUrl = (await getSecret("QDRANT_URL")) ?? memSearch.qdrant.url;
    const qdrantCollection = memSearch.qdrant.collection;
    const qdrantClient = await createQdrantClient({
      url: qdrantUrl,
      apiKey: memSearch.qdrant.apiKey,
    });
    qdrantClientRef = qdrantClient;

    if (qdrantClient.available) {
      await qdrantClient.ensureCollection(qdrantCollection, embeddingsConfig.dimensions);
    }

    memoryManager = createMemoryManager({
      embeddingProvider,
      qdrantClient,
      qdrantCollection,
      shared: memSearch.shared,
      defaultLimit: memSearch.defaultLimit,
      minScore: memSearch.minScore,
      vectorWeight: memSearch.vectorWeight,
      textWeight: memSearch.textWeight,
      mmrLambda: memSearch.mmrLambda,
    });
    log.info("Memory search initialized", {
      provider: embeddingsConfig.provider,
      vectorEnabled: Boolean(embeddingProvider),
      qdrantAvailable: qdrantClient.available,
      autoIndex: memSearch.autoIndex,
    });

    if (baseToolRegistry && embeddingProvider && qdrantClient.available) {
      try {
        baseToolRegistry = await baseToolRegistry.withSemanticIndex(
          embeddingProvider,
          qdrantClient,
          embeddingsConfig.dimensions,
        );
      } catch (err) {
        log.warn("Semantic tool index init failed — using keyword routing", {
          error: err,
        });
      }
    } else {
      log.warn("Semantic tool routing disabled", {
        hasEmbeddings: Boolean(embeddingProvider),
        qdrantAvailable: qdrantClient.available,
        hasToolRegistry: Boolean(baseToolRegistry),
      });
    }
  }

  let observationHook: ObservationHook | null = null;
  if (!opts.skipObservations) {
    const obsConfig = config.observations;
    if (obsConfig !== undefined) {
      observationHook = createObservationHook({
        memoryManager,
        minMessages: obsConfig.minMessages ?? 4,
        maxPerConversation: obsConfig.maxPerConversation ?? 3,
        debounceSec: obsConfig.debounceSec ?? 300,
      });
      log.info("Observation hook initialized");
    }
  }

  try {
    await initQuestDBReadOnly();
  } catch {
    // QuestDB unavailable — market tools will fail gracefully at runtime
  }

  const workflowToolRegistry = baseToolRegistry
    ? buildWorkflowToolRegistry(
        baseToolRegistry,
        mergedConfig,
        memoryManager,
        disabledTools,
      )
    : null;

  // Mutable ref for cronToolConfig — set by caller after cron is initialized
  let cronToolConfig: CronToolConfig | null = null;

  // No-op: registry cache was removed; kept for interface compatibility.
  function clearRegistryCache(): void {}

  // Wrap agentRegistry.reload so dependent state stays in sync on config reload.
  const originalReload = agentRegistry.reload.bind(agentRegistry);
  agentRegistry.reload = (agentConfigs, globalDefaults) => {
    originalReload(agentConfigs, globalDefaults);
    clearRegistryCache();
  };

  async function loadSkillContents(
    skillIds: readonly string[],
  ): Promise<string | null> {
    const blocks: string[] = [];
    for (const id of skillIds) {
      const content = await readSkillContent(id);
      if (content) {
        blocks.push(`<skill id="${id}">\n${content}\n</skill>`);
      }
    }
    return blocks.length > 0
      ? `<preloaded-skills>\n${blocks.join("\n\n")}\n</preloaded-skills>`
      : null;
  }

  async function enrichSystemPrompt(
    agent: ResolvedAgent,
    basePrompt: string,
  ): Promise<string> {
    let prompt = basePrompt;

    if (agent.skills.length > 0) {
      const skillBlocks = await loadSkillContents(agent.skills);
      if (skillBlocks) {
        prompt = `${prompt}\n\n${skillBlocks}`;
      }
    }

    return prompt;
  }

  function buildRegistryForAgent(
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
  ): ToolRegistry | null {
    if (!baseToolRegistry) return null;

    const deps: ToolBuilderDeps = {
      config: mergedConfig,
      agentRegistry,
      baseToolRegistry,
      subAgentTracker,
      memoryManager,
      disabledTools,
      enrichSystemPrompt,
      getCronToolConfig: () => cronToolConfig,
    };

    return buildRegistry(agent, deps, onProgress);
  }

  async function buildOptionsForAgent(
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
    cwd?: string,
  ): Promise<AgentOptions> {
    const agentPrompt = agent.systemPrompt;

    const memories = await getAgentMemories(agent.id);
    const memoryBlock = formatMemoryBlock(memories);

    const maxInPrompt = config.observations?.maxRecentInPrompt ?? 10;
    let observationBlock = "";
    if (maxInPrompt > 0) {
      try {
        const observations = await getRecentObservations(agent.id, maxInPrompt);
        observationBlock = formatObservationBlock(observations);
      } catch (err) {
        log.warn("Failed to load recent observations", {
          agentId: agent.id,
          error: err,
        });
      }
    }

    const basePrompt = [agentPrompt, memoryBlock, observationBlock]
      .filter(Boolean)
      .join("\n\n");
    const systemPrompt = await enrichSystemPrompt(agent, basePrompt);

    const reg = buildRegistryForAgent(agent, onProgress);
    const iterations = agent.maxIterations ?? config.tools.maxIterations;
    const agentOpts = buildAgentOptions(
      { ...agent, systemPrompt },
      reg,
      iterations,
      cwd,
    );

    const sdkHooks = buildSdkHooks({
      agentId: agent.id,
      hooksConfig: agent.hooks,
      onProgress,
    });

    return { ...agentOpts, sdkHooks, ...(onProgress ? { onProgress } : {}) };
  }

  return {
    config: mergedConfig,
    agentRegistry,
    baseToolRegistry,
    workflowToolRegistry,
    memoryManager,
    observationHook,
    subAgentTracker,
    buildRegistryForAgent,
    buildOptionsForAgent,
    enrichSystemPrompt,
    clearRegistryCache,
    dispose(): void {
      qdrantClientRef?.dispose();
    },
    get cronToolConfig() {
      return cronToolConfig;
    },
    set cronToolConfig(value: CronToolConfig | null) {
      cronToolConfig = value;
      clearRegistryCache();
    },
  };
}
