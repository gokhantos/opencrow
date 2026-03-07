import type { OpenCrowConfig } from "../config/schema";
import type { AgentOptions, ProgressEvent } from "../agent/types";
import type { ToolDefinition, ToolCategory } from "../tools/types";
import type { ToolRegistry } from "../tools/registry";
import type { ResolvedAgent } from "../agents/types";
import type { MemoryManager } from "../memory/types";
import type { CronToolConfig } from "../tools/cron";
import type { CronStore } from "../cron/store";
import type { CronScheduler } from "../cron/scheduler";
import { initDb } from "../store/db";
import { createToolRegistry } from "../tools/registry";
import { createToolRouter } from "../tools/router";
import { createAgentRegistry, type AgentRegistry } from "../agents/registry";
import { loadConfigWithOverrides } from "../config/loader";
import { createSubAgentTracker } from "../agents/tracker";
import { createListAgentsTool } from "../tools/list-agents";
import { createSpawnAgentTool } from "../tools/spawn-agent";
import { createCronTool } from "../tools/cron";
import {
  createLogger,
  setLogLevel,
  setProcessName,
  startLogPersistence,
} from "../logger";
import { createMemoryTools, createSearchMemoryTool } from "../tools/memory";
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
import { buildMainAgentPrompt, buildSubAgentPrompt } from "../prompts/loader";
import { buildSdkHooks } from "../agent/hooks";
import { createMemoryManager } from "../memory/manager";
import { createEmbeddingProvider } from "../memory/embeddings";
import { createQdrantClient } from "../memory/qdrant";
import { createMarketTools } from "../sources/markets/tools";
import { buildMarketContext } from "../sources/markets/context";
import { initQuestDBReadOnly } from "../sources/markets/questdb";
import { createNewsTools } from "../tools/news";
import { createDexScreenerTools } from "../tools/dexscreener";
import { createPHTools } from "../tools/ph";
import { createHNTools } from "../tools/hn";
import { createHFTools } from "../tools/huggingface";
import { createRedditTools } from "../tools/reddit";
import { createAgentCapacityTool } from "../tools/agent-capacity";
import { createFailurePatternsTool } from "../tools/failure-patterns";
import { createGithubTools } from "../tools/github";
import { createArxivTools } from "../tools/arxiv";
import { createScholarTools } from "../tools/scholar";
import { createXTimelineTools } from "../tools/x-timeline";
import { createAppStoreTools } from "../tools/appstore";
import { createPlayStoreTools } from "../tools/playstore";
import { createCrossSourceSearchTool } from "../tools/cross-search";
import { createDefiLlamaTools } from "../tools/defillama";
import { createGoogleTrendsTools } from "../tools/google-trends";
import { createGetScraperStatusTool } from "../tools/scraper-status";
import { createGetSubagentRunsTool } from "../tools/subagent-runs";
import { createGetObservationsTool } from "../tools/memory";
import { createAnalyticsTools } from "../tools/analytics";
import { createRoutingDashboardTools } from "../tools/routing-dashboard";
import { createIdeaTools } from "../tools/ideas";
import { createSignalTools } from "../tools/signals";
import { createValidationTools } from "../tools/validation";
import { createProjectContextTool } from "../tools/project-context";
import { createValidateCodeTool } from "../tools/validate-code";
import { createRunTestsTool } from "../tools/run-tests";
import { createDeployTool } from "../tools/deploy";
import { createProcessMonitorTools } from "../tools/process-monitor";
import { createLogCheckerTools } from "../tools/log-checker";
import { createMemoryStatsTools } from "../tools/memory-stats";
import { createEconomicCalendarTool } from "../tools/economic-calendar";
import { createMcpWrapperTools } from "../tools/mcp-wrappers";
import { createDbTools } from "../tools/db-query";

const log = createLogger("bootstrap");

export interface BootstrapContext {
  readonly config: OpenCrowConfig;
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry | null;
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

  // Merge file config with DB overrides
  const mergedConfig = await loadConfigWithOverrides();

  const agentRegistry = createAgentRegistry(mergedConfig.agents, mergedConfig.agent);

  const subAgentTracker = createSubAgentTracker();

  let baseToolRegistry: ToolRegistry | null = null;
  let toolRouter: ReturnType<typeof createToolRouter> | null = null;
  if (config.tools.enabled) {
    const registry = createToolRegistry(config.tools).withTools([
      createListSkillsTool(),
      createUseSkillTool(),
      createAgentCapacityTool(),
      createFailurePatternsTool(),
    ]);
    // Create router for smart tool selection
    toolRouter = createToolRouter(registry.definitions);
    baseToolRegistry = registry.withRouter(toolRouter);
    log.info("Tool registry initialized", {
      toolCount: baseToolRegistry.definitions.length,
      allowedDirs: config.tools.allowedDirectories,
      smartRouting: true,
    });
  }

  let memoryManager: MemoryManager | null = null;
  if (!opts.skipMemory && config.memorySearch.enabled) {
    const embeddingKey =
      process.env.OPENROUTER_API_KEY ?? process.env.VOYAGE_API_KEY;
    const embeddingProvider = embeddingKey
      ? createEmbeddingProvider(embeddingKey)
      : null;

    if (!embeddingKey) {
      log.warn(
        "OPENROUTER_API_KEY not set — memory search disabled (requires Qdrant + embeddings)",
      );
    }

    const qdrantUrl = process.env.QDRANT_URL ?? config.memorySearch.qdrant.url;
    const qdrantCollection = config.memorySearch.qdrant.collection;
    const qdrantClient = await createQdrantClient({
      url: qdrantUrl,
      apiKey: config.memorySearch.qdrant.apiKey,
    });

    if (qdrantClient.available) {
      await qdrantClient.ensureCollection(qdrantCollection, 512);
    }

    memoryManager = createMemoryManager({
      embeddingProvider,
      qdrantClient,
      qdrantCollection,
      shared: config.memorySearch.shared,
      defaultLimit: config.memorySearch.defaultLimit,
      minScore: config.memorySearch.minScore,
      vectorWeight: config.memorySearch.vectorWeight,
      textWeight: config.memorySearch.textWeight,
      mmrLambda: config.memorySearch.mmrLambda,
    });
    log.info("Memory search initialized", {
      vectorEnabled: Boolean(embeddingKey),
      qdrantAvailable: qdrantClient.available,
      autoIndex: config.memorySearch.autoIndex,
    });
  }

  let observationHook: ObservationHook | null = null;
  if (!opts.skipObservations) {
    const obsConfig = config.observations ?? { enabled: true };
    if (obsConfig.enabled !== false) {
      observationHook = createObservationHook({
        memoryManager,
        minMessages: obsConfig.minMessages ?? 4,
        maxPerConversation: obsConfig.maxPerConversation ?? 3,
        debounceSec: obsConfig.debounceSec ?? 300,
      });
      log.info("Observation hook initialized");
    }
  }

  // Initialize QuestDB read-only client for market query tools
  if (config.market.enabled) {
    await initQuestDBReadOnly();
  }

  // Mutable ref for cronToolConfig — set by caller after cron is initialized
  let cronToolConfig: CronToolConfig | null = null;

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

    if (agent.id === "crypto-analyst" && config.market.enabled) {
      try {
        const marketContext = await buildMarketContext({
          symbols: config.market.symbols,
          marketTypes: config.market.marketTypes,
          timeframes: ["5m", "15m", "1h", "4h", "1d"],
          includeFunding: true,
        });
        prompt = `${prompt}\n\n${marketContext}`;
      } catch (err) {
        log.warn("Failed to inject market context", { error: err });
      }
    }

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

    let registry = baseToolRegistry.withFilter(agent.toolFilter);

    const allowsTool = (name: string): boolean => {
      if (agent.toolFilter.mode === "all") return true;
      if (agent.toolFilter.mode === "allowlist")
        return agent.toolFilter.tools.includes(name);
      return !agent.toolFilter.tools.includes(name);
    };

    if (agent.subagents.allowAgents.length > 0) {
      const listAgents = createListAgentsTool(agentRegistry, agent.id);
      const spawnAgent = createSpawnAgentTool({
        agentRegistry,
        baseToolRegistry: baseToolRegistry!,
        tracker: subAgentTracker,
        currentAgentId: agent.id,
        sessionId: crypto.randomUUID(),
        maxIterations: config.tools.maxIterations,
        buildRegistryForAgent: (a) => buildRegistryForAgent(a, onProgress),
        buildSystemPrompt: enrichSystemPrompt,
        onProgress,
      });
      const subagentTools = [listAgents, spawnAgent].filter((t) =>
        allowsTool(t.name),
      );
      if (subagentTools.length > 0)
        registry = registry.withTools(subagentTools);
    }

    if (cronToolConfig && allowsTool("cron")) {
      const cronTool = createCronTool({
        ...cronToolConfig,
        currentAgentId: agent.id,
      });
      registry = registry.withTools([cronTool]);
    }

    {
      const memoryTools = createMemoryTools(agent.id).filter((t) =>
        allowsTool(t.name),
      );
      if (memoryTools.length > 0) registry = registry.withTools(memoryTools);

      const extraTools: ToolDefinition[] = [];
      if (memoryManager && allowsTool("search_memory"))
        extraTools.push(createSearchMemoryTool(agent.id, memoryManager));
      if (extraTools.length > 0) registry = registry.withTools(extraTools);
    }

    {
      const marketTools = createMarketTools(
        config.market.symbols,
        config.market.marketTypes,
      ).filter((t) => allowsTool(t.name));
      if (marketTools.length > 0) registry = registry.withTools(marketTools);
    }

    {
      const newsTools = createNewsTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (newsTools.length > 0) registry = registry.withTools(newsTools);
    }

    {
      const dexScreenerTools = createDexScreenerTools().filter((t) =>
        allowsTool(t.name),
      );
      if (dexScreenerTools.length > 0) registry = registry.withTools(dexScreenerTools);
    }

    {
      const phTools = createPHTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (phTools.length > 0) registry = registry.withTools(phTools);
    }

    {
      const hnTools = createHNTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (hnTools.length > 0) registry = registry.withTools(hnTools);
    }

    {
      const hfTools = createHFTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (hfTools.length > 0) registry = registry.withTools(hfTools);
    }

    {
      const redditTools = createRedditTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (redditTools.length > 0) registry = registry.withTools(redditTools);
    }

    {
      const githubTools = createGithubTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (githubTools.length > 0) registry = registry.withTools(githubTools);
    }

    {
      const arxivTools = createArxivTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (arxivTools.length > 0) registry = registry.withTools(arxivTools);
    }

    {
      const scholarTools = createScholarTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (scholarTools.length > 0) registry = registry.withTools(scholarTools);
    }

    {
      const xTimelineTools = createXTimelineTools(memoryManager).filter((t) =>
        allowsTool(t.name),
      );
      if (xTimelineTools.length > 0)
        registry = registry.withTools(xTimelineTools);
    }

    {
      const appStoreTools = createAppStoreTools(memoryManager).filter((t) => allowsTool(t.name));
      if (appStoreTools.length > 0) registry = registry.withTools(appStoreTools);
    }

    {
      const playStoreTools = createPlayStoreTools(memoryManager).filter((t) => allowsTool(t.name));
      if (playStoreTools.length > 0) registry = registry.withTools(playStoreTools);
    }

    {
      const defiTools = createDefiLlamaTools(memoryManager).filter((t) => allowsTool(t.name));
      if (defiTools.length > 0) registry = registry.withTools(defiTools);
    }

    {
      const trendsTools = createGoogleTrendsTools(memoryManager).filter((t) => allowsTool(t.name));
      if (trendsTools.length > 0) registry = registry.withTools(trendsTools);
    }

    if (memoryManager && allowsTool("cross_source_search")) {
      registry = registry.withTools([
        createCrossSourceSearchTool(memoryManager),
      ]);
    }

    {
      const ideaTools = [...createIdeaTools(agent.id, memoryManager)].filter((t) =>
        allowsTool(t.name),
      );
      if (ideaTools.length > 0) registry = registry.withTools(ideaTools);
    }

    {
      const signalTools = [...createSignalTools(agent.id)].filter((t) =>
        allowsTool(t.name),
      );
      if (signalTools.length > 0) registry = registry.withTools(signalTools);
    }

    {
      const validationTools = [...createValidationTools()].filter((t) =>
        allowsTool(t.name),
      );
      if (validationTools.length > 0) registry = registry.withTools(validationTools);
    }

    if (allowsTool("get_scraper_status")) {
      registry = registry.withTools([createGetScraperStatusTool()]);
    }

    if (allowsTool("get_observations")) {
      registry = registry.withTools([createGetObservationsTool(agent.id)]);
    }

    if (allowsTool("get_subagent_runs")) {
      registry = registry.withTools([createGetSubagentRunsTool()]);
    }

    // Analytics and intelligence tools
    {
      const analyticsTools = createAnalyticsTools(agent.id).filter((t) =>
        allowsTool(t.name),
      );
      if (analyticsTools.length > 0) registry = registry.withTools(analyticsTools);
    }

    // Routing dashboard tools
    {
      const routingTools = createRoutingDashboardTools().filter((t) =>
        allowsTool(t.name),
      );
      if (routingTools.length > 0) registry = registry.withTools(routingTools);
    }

    // Database query tools
    {
      const dbTools = createDbTools().filter((t) => allowsTool(t.name));
      if (dbTools.length > 0) registry = registry.withTools(dbTools);
    }

    // Process monitoring tools
    {
      const processTools = createProcessMonitorTools().filter((t) =>
        allowsTool(t.name),
      );
      if (processTools.length > 0) registry = registry.withTools(processTools);
    }

    // Log checker tools
    {
      const logTools = createLogCheckerTools().filter((t) =>
        allowsTool(t.name),
      );
      if (logTools.length > 0) registry = registry.withTools(logTools);
    }

    // Memory stats tools
    {
      const memoryStatsTools = createMemoryStatsTools().filter((t) =>
        allowsTool(t.name),
      );
      if (memoryStatsTools.length > 0) registry = registry.withTools(memoryStatsTools);
    }

    // Economic calendar tool
    {
      const calendarTools = createEconomicCalendarTool().filter((t) =>
        allowsTool(t.name),
      );
      if (calendarTools.length > 0) registry = registry.withTools(calendarTools);
    }

    // MCP wrapper tools
    {
      const mcpTools = createMcpWrapperTools().filter((t) =>
        allowsTool(t.name),
      );
      if (mcpTools.length > 0) registry = registry.withTools(mcpTools);
    }

    // Development tools
    if (allowsTool("project_context")) {
      registry = registry.withTools([createProjectContextTool(config.tools)]);
    }
    if (allowsTool("validate_code")) {
      registry = registry.withTools([createValidateCodeTool(config.tools)]);
    }
    if (allowsTool("run_tests")) {
      registry = registry.withTools([createRunTestsTool(config.tools)]);
    }
    if (allowsTool("deploy")) {
      registry = registry.withTools([createDeployTool()]);
    }

    return registry;
  }

  async function buildOptionsForAgent(
    agent: ResolvedAgent,
    onProgress?: (event: ProgressEvent) => void,
    cwd?: string,
  ): Promise<AgentOptions> {
    let agentPrompt: string;
    if (agent.default) {
      agentPrompt = await buildMainAgentPrompt();
    } else {
      const loaded = await buildSubAgentPrompt(agent.id);
      agentPrompt = loaded ?? agent.systemPrompt;
    }

    const memories = await getAgentMemories(agent.id);
    const memoryBlock = formatMemoryBlock(memories);

    const maxInPrompt = config.observations?.maxRecentInPrompt ?? 10;
    let observationBlock = "";
    if (maxInPrompt > 0) {
      try {
        const observations = await getRecentObservations(agent.id, maxInPrompt);
        observationBlock = formatObservationBlock(observations);
      } catch {
        // Non-fatal
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
    memoryManager,
    observationHook,
    subAgentTracker,
    buildRegistryForAgent,
    buildOptionsForAgent,
    enrichSystemPrompt,
    get cronToolConfig() {
      return cronToolConfig;
    },
    set cronToolConfig(value: CronToolConfig | null) {
      cronToolConfig = value;
    },
  };
}
