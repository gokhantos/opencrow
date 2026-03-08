/**
 * Dynamic tool catalog — builds the full list of available tools
 * by calling every tool creator and extracting metadata.
 * Used by the web UI for the agent config tool picker and tools page.
 */

import type { ToolDefinition } from "./types";
import { createToolRegistry } from "./registry";
import { createMemoryTools, createGetObservationsTool } from "./memory";
import { createMarketTools } from "../sources/markets/tools";
import { createNewsTools } from "./news";
import { createPHTools } from "./ph";
import { createHNTools } from "./hn";
import { createRedditTools } from "./reddit";
import { createGithubTools } from "./github";
import { createXTimelineTools } from "./x-timeline";
import { createAppStoreTools } from "./appstore";
import { createPlayStoreTools } from "./playstore";
import { createCrossSourceSearchTool } from "./cross-search";
import { createIdeaTools } from "./ideas";
import { createSignalTools } from "./signals";
import { createGetScraperStatusTool } from "./scraper-status";
import { createGetSubagentRunsTool } from "./subagent-runs";
import { createAnalyticsTools } from "./analytics";
import { createRoutingDashboardTools } from "./routing-dashboard";
import { createDbTools } from "./db-query";
import { createProcessMonitorTools } from "./process-monitor";
import { createLogCheckerTools } from "./log-checker";
import { createMemoryStatsTools } from "./memory-stats";
import { createEconomicCalendarTool } from "./economic-calendar";

import { createProjectContextTool } from "./project-context";
import { createValidateCodeTool } from "./validate-code";
import { createRunTestsTool } from "./run-tests";

import { createListSkillsTool } from "./list-skills";
import { createUseSkillTool } from "./use-skill";

export interface ToolCatalogEntry {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly params: readonly string[];
}

/** Category derived from ToolDefinition.categories or overridden per-tool */
const CATEGORY_MAP: Record<string, string> = {
  research: "research",
  code: "development",
  analytics: "analytics",
  fileops: "core",
  system: "system",
  memory: "memory",
  ideas: "ideas",
  social: "social",
};

/** Override categories for specific tools that need more granular grouping */
const TOOL_CATEGORY_OVERRIDES: Record<string, string> = {
  // Core
  bash: "core",
  read_file: "core",
  write_file: "core",
  edit_file: "core",
  list_files: "core",
  grep: "core",
  glob: "core",

  // Skills
  list_skills: "skills",
  use_skill: "skills",

  // Agents
  list_agents: "agents",
  spawn_agent: "agents",

  // Scheduling
  cron: "scheduling",
  trigger_cron: "scheduling",

  // Memory
  remember: "memory",
  recall: "memory",
  search_memory: "memory",
  get_observations: "memory",
  search_agent_observations: "memory",
  get_memory_stats: "memory",
  search_memory_sources: "memory",

  // News
  search_news: "news",
  get_news_digest: "news",
  get_calendar: "news",

  // Product Hunt
  search_products: "product_hunt",
  get_product_digest: "product_hunt",

  // Hacker News
  search_hn: "hacker_news",
  get_hn_digest: "hacker_news",

  // Reddit
  search_reddit: "reddit",
  get_reddit_digest: "reddit",

  // GitHub
  get_github_repos: "github",
  search_github_repos: "github",

  // arXiv
  get_arxiv_papers: "arxiv",
  search_arxiv_papers: "arxiv",

  // X / Twitter
  search_x_timeline: "x_timeline",
  get_timeline_digest: "x_timeline",
  get_liked_tweets: "x_timeline",
  get_x_analytics: "x_timeline",

  // App Store
  get_appstore_rankings: "appstore",
  get_appstore_complaints: "appstore",
  search_appstore_reviews: "appstore",

  // Play Store
  get_playstore_rankings: "playstore",
  get_playstore_complaints: "playstore",
  search_playstore_reviews: "playstore",

  // Cross-source
  cross_source_search: "search",

  // Market
  get_price: "market",
  market_summary: "market",
  get_candles: "market",
  technical_analysis: "market",
  market_snapshot: "market",
  futures_overview: "market",
  funding_rate: "market",
  funding_summary: "market",
  liquidations: "market",

  // Ideas
  save_idea: "ideas",
  get_previous_ideas: "ideas",
  get_idea_stats: "ideas",
  update_idea_stage: "ideas",
  query_ideas: "ideas",
  search_similar_ideas: "ideas",
  get_ideas_by_rating: "ideas",
  get_ideas_trends: "ideas",
  get_rating_insights: "ideas",

  // Signals
  save_signal: "signals",
  get_signals: "signals",
  consume_signals: "signals",
  get_signal_themes: "signals",
  get_cross_domain_signals: "signals",

  // Observability
  get_scraper_status: "observability",
  get_subagent_runs: "observability",
  get_scraper_runs: "observability",

  // Analytics
  search_observations: "analytics",
  get_conversation_summaries: "analytics",
  get_tool_usage: "analytics",
  get_agent_performance: "analytics",
  get_session_stats: "analytics",
  get_cost_summary: "analytics",
  get_error_summary: "analytics",
  get_activity_timeline: "analytics",
  get_user_activity: "analytics",
  get_subagent_activity: "analytics",
  get_session_analysis: "analytics",
  get_health_dashboard: "analytics",
  // Routing
  get_routing_dashboard: "routing",
  get_routing_stats: "routing",
  get_mcp_health: "routing",
  get_tool_performance: "routing",
  get_cost_breakdown: "routing",
  get_prewarm_stats: "routing",

  // Database
  db_query: "database",
  db_list_tables: "database",
  db_table_info: "database",
  db_row_counts: "database",

  // Process monitoring
  get_process_logs: "process",
  get_process_health: "process",
  process_manage: "system",

  // Log checker
  search_logs: "logs",
  aggregate_logs: "logs",
  error_analysis: "logs",
  log_timeline: "logs",
  compare_periods: "logs",

  // MCP wrappers
  list_mcp_capabilities: "mcp",
  websearch: "mcp",
  webscrape: "mcp",
  lookupdocs: "mcp",

  // Development
  project_context: "development",
  validate_code: "development",
  run_tests: "development",
  deploy: "development",
  git_operations: "development",

  // Communication
  web_fetch: "system",
  agent_templates: "system",
  manage_agent: "system",
  self_restart: "system",
};

/** Human-readable category labels */
export const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  skills: "Skills",
  agents: "Agents",
  scheduling: "Scheduling",
  memory: "Memory",
  news: "News & Content",
  product_hunt: "Product Hunt",
  hacker_news: "Hacker News",
  reddit: "Reddit",
  github: "GitHub",
  arxiv: "arXiv",
  x_timeline: "X / Twitter",
  appstore: "App Store",
  playstore: "Play Store",
  search: "Cross-Source",
  market: "Markets & Trading",
  ideas: "Ideas",
  signals: "Signals",
  observability: "Observability",
  analytics: "Analytics",
  routing: "Routing",
  database: "Database",
  process: "Process Monitor",
  logs: "Log Analysis",
  mcp: "MCP Integrations",
  development: "Development",
  system: "System",
  social: "Social",
  research: "Research",
};

function resolveCategory(tool: ToolDefinition): string {
  const override = TOOL_CATEGORY_OVERRIDES[tool.name];
  if (override) return override;

  if (tool.categories.length > 0) {
    const cat = tool.categories[0] as string;
    const mapped = CATEGORY_MAP[cat];
    if (mapped) return mapped;
    return cat;
  }

  return "other";
}

function extractParams(tool: ToolDefinition): readonly string[] {
  const props = (tool.inputSchema as Record<string, unknown>)?.properties;
  if (props && typeof props === "object") {
    return Object.keys(props as Record<string, unknown>);
  }
  return [];
}

function toEntry(tool: ToolDefinition): ToolCatalogEntry {
  return {
    name: tool.name,
    category: resolveCategory(tool),
    description: tool.description,
    params: extractParams(tool),
  };
}

let cachedCatalog: readonly ToolCatalogEntry[] | null = null;

/**
 * Build the complete tool catalog by instantiating all tool creators.
 * Results are cached after first call since the tool set doesn't change at runtime.
 */
export function buildToolCatalog(): readonly ToolCatalogEntry[] {
  if (cachedCatalog) return cachedCatalog;

  const tools: ToolDefinition[] = [];

  // Base registry tools (bash, read_file, write_file, etc.)
  const defaultConfig = {
    enabled: true,
    allowedDirectories: [process.cwd()],
    blockedCommands: [] as string[],
    maxBashTimeout: 600_000,
    maxFileSize: 10_485_760,
    maxIterations: 50,
  };
  const baseRegistry = createToolRegistry(defaultConfig);
  tools.push(...baseRegistry.definitions);

  // Skills
  tools.push(createListSkillsTool());
  tools.push(createUseSkillTool());

  // Memory tools (use placeholder agentId)
  tools.push(...createMemoryTools("_catalog"));
  tools.push(createGetObservationsTool("_catalog"));

  // Stub memoryManager — tools only need it at execution time, not for metadata
  const mm = {
    search: () => Promise.resolve([]),
  } as never;
  tools.push(...createNewsTools(mm));
  tools.push(...createPHTools(mm));
  tools.push(...createHNTools(mm));
  tools.push(...createRedditTools(mm));
  tools.push(...createGithubTools(mm));
  tools.push(...createXTimelineTools(mm));
  tools.push(...createAppStoreTools(mm));
  tools.push(...createPlayStoreTools(mm));
  tools.push(createCrossSourceSearchTool(mm));

  // Market tools
  tools.push(...createMarketTools(["BTCUSDT"], ["spot"]));

  // Ideas, signals, validation
  tools.push(...createIdeaTools("_catalog", mm));
  tools.push(...createSignalTools("_catalog"));
  // Observability
  tools.push(createGetScraperStatusTool());
  tools.push(createGetSubagentRunsTool());

  // Analytics
  tools.push(...createAnalyticsTools("_catalog"));

  // Routing
  tools.push(...createRoutingDashboardTools());

  // Database
  tools.push(...createDbTools());

  // Process monitoring
  tools.push(...createProcessMonitorTools());

  // Log checker
  tools.push(...createLogCheckerTools());

  // Memory stats
  tools.push(...createMemoryStatsTools());

  // Economic calendar
  tools.push(...createEconomicCalendarTool());

  // Development
  tools.push(createProjectContextTool(defaultConfig));
  tools.push(createValidateCodeTool(defaultConfig));
  tools.push(createRunTestsTool(defaultConfig));
  // Deduplicate by name (last wins)
  const seen = new Map<string, ToolCatalogEntry>();
  for (const tool of tools) {
    seen.set(tool.name, toEntry(tool));
  }

  // Sort by category then name
  const catalog = [...seen.values()].sort((a, b) => {
    const aIdx = CATEGORY_ORDER.indexOf(a.category);
    const bIdx = CATEGORY_ORDER.indexOf(b.category);
    const catOrder = (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    if (catOrder !== 0) return catOrder;
    return a.name.localeCompare(b.name);
  });

  cachedCatalog = catalog;
  return catalog;
}

/** Preferred category display order */
const CATEGORY_ORDER = [
  "core",
  "skills",
  "agents",
  "scheduling",
  "memory",
  "news",
  "product_hunt",
  "hacker_news",
  "reddit",
  "github",
  "arxiv",
  "x_timeline",
  "appstore",
  "playstore",
  "search",
  "market",
  "ideas",
  "signals",
  "observability",
  "analytics",
  "routing",
  "database",
  "process",
  "logs",
  "mcp",
  "development",
  "system",
];
