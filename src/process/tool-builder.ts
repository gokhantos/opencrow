import type { ProgressEvent } from "../agent/types";
import type { ToolDefinition } from "../tools/types";
import type { ToolRegistry } from "../tools/registry";
import type { ResolvedAgent } from "../agents/types";
import type { AgentRegistry } from "../agents/registry";
import type { MemoryManager } from "../memory/types";
import type { OpenCrowConfig } from "../config/schema";
import { createLogger } from "../logger";
import { createSubAgentTracker } from "../agents/tracker";
import { createListAgentsTool } from "../tools/list-agents";
import { createSpawnAgentTool } from "../tools/spawn-agent";
import { createCronTool } from "../tools/cron";
import type { CronToolConfig } from "../tools/cron";
import { createMemoryTools, createSearchMemoryTool } from "../tools/memory";
import { createMarketTools } from "../sources/markets/tools";
import { createNewsTools } from "../tools/news";
import { createPHTools } from "../tools/ph";
import { createHNTools } from "../tools/hn";
import { createRedditTools } from "../tools/reddit";
import { createGithubTools } from "../tools/github";
import { createXTimelineTools } from "../tools/x-timeline";
import { createAppStoreTools } from "../tools/appstore";
import { createPlayStoreTools } from "../tools/playstore";
import { createGetScraperStatusTool } from "../tools/scraper-status";
import { createGetSubagentRunsTool } from "../tools/subagent-runs";
import { createProjectContextTool } from "../tools/project-context";
import { createValidateCodeTool } from "../tools/validate-code";
import { createRunTestsTool } from "../tools/run-tests";
import { createProcessMonitorTools } from "../tools/process-monitor";
import { createEconomicCalendarTool } from "../tools/economic-calendar";
import { createDbTools } from "../tools/db-query";

const log = createLogger("tool-builder");

export function buildWorkflowToolRegistry(
  base: ToolRegistry,
  config: OpenCrowConfig,
  memoryManager: MemoryManager | null,
  disabledTools: Set<string>,
): ToolRegistry {
  const allowsTool = (name: string): boolean => !disabledTools.has(name);

  let registry = base;

  // Workflows get ALL tools unconditionally — no scraper-enabled gating.
  // Scraper toggles control whether background scraping runs, not tool availability.

  if (config.market) {
    const marketTools = createMarketTools(
      config.market.symbols ?? [],
      config.market.marketTypes ?? [],
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
    const xTimelineTools = createXTimelineTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (xTimelineTools.length > 0)
      registry = registry.withTools(xTimelineTools);
  }

  {
    const appStoreTools = createAppStoreTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (appStoreTools.length > 0) registry = registry.withTools(appStoreTools);
  }

  {
    const playStoreTools = createPlayStoreTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (playStoreTools.length > 0)
      registry = registry.withTools(playStoreTools);
  }

  if (allowsTool("get_scraper_status")) {
    registry = registry.withTools([createGetScraperStatusTool()]);
  }

  {
    const dbTools = createDbTools().filter((t) => allowsTool(t.name));
    if (dbTools.length > 0) registry = registry.withTools(dbTools);
  }

  {
    const processTools = createProcessMonitorTools().filter((t) =>
      allowsTool(t.name),
    );
    if (processTools.length > 0) registry = registry.withTools(processTools);
  }

  {
    const calendarTools = createEconomicCalendarTool().filter((t) =>
      allowsTool(t.name),
    );
    if (calendarTools.length > 0) registry = registry.withTools(calendarTools);
  }

  if (config.tools) {
    if (allowsTool("project_context")) {
      registry = registry.withTools([createProjectContextTool(config.tools)]);
    }
    if (allowsTool("validate_code")) {
      registry = registry.withTools([createValidateCodeTool(config.tools)]);
    }
    if (allowsTool("run_tests")) {
      registry = registry.withTools([createRunTestsTool(config.tools)]);
    }
  }

  log.info("Workflow tool registry built", {
    toolCount: registry.definitions.length,
  });

  return registry;
}


export interface ToolBuilderDeps {
  readonly config: OpenCrowConfig;
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry;
  readonly subAgentTracker: ReturnType<typeof createSubAgentTracker>;
  readonly memoryManager: MemoryManager | null;
  readonly disabledTools: Set<string>;
  readonly enrichSystemPrompt: (
    agent: ResolvedAgent,
    basePrompt: string,
  ) => Promise<string>;
  readonly getCronToolConfig: () => CronToolConfig | null;
}

export function buildRegistryForAgent(
  agent: ResolvedAgent,
  deps: ToolBuilderDeps,
  onProgress?: (event: ProgressEvent) => void,
): ToolRegistry | null {
  const {
    config,
    agentRegistry,
    baseToolRegistry,
    subAgentTracker,
    memoryManager,
    disabledTools,
    enrichSystemPrompt,
    getCronToolConfig,
  } = deps;

  let registry = baseToolRegistry.withFilter(agent.toolFilter);

  const allowsTool = (name: string): boolean => {
    if (disabledTools.has(name)) return false;
    if (agent.toolFilter.mode === "all") return true;
    if (agent.toolFilter.mode === "allowlist")
      return agent.toolFilter.tools.includes(name);
    return !agent.toolFilter.tools.includes(name);
  };

  if (agent.subagents.allowAgents.length > 0) {
    const listAgents = createListAgentsTool(agentRegistry, agent.id);
    const spawnAgent = createSpawnAgentTool({
      agentRegistry,
      baseToolRegistry,
      tracker: subAgentTracker,
      currentAgentId: agent.id,
      sessionId: crypto.randomUUID(),
      maxIterations: config.tools.maxIterations,
      buildRegistryForAgent: (a) =>
        buildRegistryForAgent(a, deps, onProgress),
      buildSystemPrompt: enrichSystemPrompt,
      onProgress,
    });
    const subagentTools = [listAgents, spawnAgent].filter((t) =>
      allowsTool(t.name),
    );
    if (subagentTools.length > 0) registry = registry.withTools(subagentTools);
  }

  const cronToolConfig = getCronToolConfig();
  if (cronToolConfig && allowsTool("cron")) {
    const cronTool = createCronTool({
      ...cronToolConfig,
      currentAgentId: agent.id,
    });
    registry = registry.withTools([cronTool]);
  }

  {
    const memoryTools = createMemoryTools(agent.id);
    if (memoryTools.length > 0) registry = registry.withTools(memoryTools);

    const extraTools: ToolDefinition[] = [];
    if (memoryManager)
      extraTools.push(createSearchMemoryTool(agent.id, memoryManager));
    if (extraTools.length > 0) registry = registry.withTools(extraTools);
  }

  const enabledScrapers = new Set(
    config.processes.scraperProcesses.scraperIds ?? [],
  );
  const scraperEnabled = (id: string) => enabledScrapers.has(id);

  if (config.market) {
    const marketTools = createMarketTools(
      config.market.symbols ?? [],
      config.market.marketTypes ?? [],
    ).filter((t) => allowsTool(t.name));
    if (marketTools.length > 0) registry = registry.withTools(marketTools);
  }

  if (scraperEnabled("news")) {
    const newsTools = createNewsTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (newsTools.length > 0) registry = registry.withTools(newsTools);
  }

  if (scraperEnabled("producthunt")) {
    const phTools = createPHTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (phTools.length > 0) registry = registry.withTools(phTools);
  }

  if (scraperEnabled("hackernews")) {
    const hnTools = createHNTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (hnTools.length > 0) registry = registry.withTools(hnTools);
  }

  if (scraperEnabled("reddit")) {
    const redditTools = createRedditTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (redditTools.length > 0) registry = registry.withTools(redditTools);
  }

  if (scraperEnabled("github")) {
    const githubTools = createGithubTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (githubTools.length > 0) registry = registry.withTools(githubTools);
  }

  if (scraperEnabled("x")) {
    const xTimelineTools = createXTimelineTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (xTimelineTools.length > 0)
      registry = registry.withTools(xTimelineTools);
  }

  if (scraperEnabled("appstore")) {
    const appStoreTools = createAppStoreTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (appStoreTools.length > 0) registry = registry.withTools(appStoreTools);
  }

  if (scraperEnabled("playstore")) {
    const playStoreTools = createPlayStoreTools(memoryManager).filter((t) =>
      allowsTool(t.name),
    );
    if (playStoreTools.length > 0)
      registry = registry.withTools(playStoreTools);
  }

  if (allowsTool("get_scraper_status")) {
    registry = registry.withTools([createGetScraperStatusTool()]);
  }

  if (allowsTool("get_subagent_runs")) {
    registry = registry.withTools([createGetSubagentRunsTool()]);
  }

  {
    const dbTools = createDbTools().filter((t) => allowsTool(t.name));
    if (dbTools.length > 0) registry = registry.withTools(dbTools);
  }

  {
    const processTools = createProcessMonitorTools().filter((t) =>
      allowsTool(t.name),
    );
    if (processTools.length > 0) registry = registry.withTools(processTools);
  }

  {
    const calendarTools = createEconomicCalendarTool().filter((t) =>
      allowsTool(t.name),
    );
    if (calendarTools.length > 0) registry = registry.withTools(calendarTools);
  }

  if (allowsTool("project_context")) {
    registry = registry.withTools([createProjectContextTool(config.tools)]);
  }
  if (allowsTool("validate_code")) {
    registry = registry.withTools([createValidateCodeTool(config.tools)]);
  }
  if (allowsTool("run_tests")) {
    registry = registry.withTools([createRunTestsTool(config.tools)]);
  }

  return registry;
}
