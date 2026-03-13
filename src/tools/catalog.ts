/**
 * Dynamic tool catalog — builds the full list of available tools
 * by calling every tool creator and extracting metadata.
 * Used by the web UI for the agent config tool picker and tools page.
 */

import type { ToolDefinition } from "./types";
import { createToolRegistry } from "./registry";
import { createMemoryTools } from "./memory";
import { createMarketTools } from "../sources/markets/tools";
import { createNewsTools } from "./news";
import { createPHTools } from "./ph";
import { createHNTools } from "./hn";
import { createRedditTools } from "./reddit";
import { createGithubTools } from "./github";
import { createXTimelineTools } from "./x-timeline";
import { createAppStoreTools } from "./appstore";
import { createPlayStoreTools } from "./playstore";
import { createGetScraperStatusTool } from "./scraper-status";
import { createGetSubagentRunsTool } from "./subagent-runs";
import { createDbTools } from "./db-query";
import { createProcessMonitorTools } from "./process-monitor";
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
  readonly inputSchema?: Record<string, unknown>;
  readonly enabled: boolean;
}

/** Maps tool display categories to feature flag identifiers */
export const CATEGORY_TO_FEATURE: Record<string, { type: "scraper"; id: string } | { type: "toggle"; id: "market" | "qdrant" }> = {
  reddit: { type: "scraper", id: "reddit" },
  hacker_news: { type: "scraper", id: "hackernews" },
  product_hunt: { type: "scraper", id: "producthunt" },
  github: { type: "scraper", id: "github" },
  x_timeline: { type: "scraper", id: "x" },
  appstore: { type: "scraper", id: "appstore" },
  playstore: { type: "scraper", id: "playstore" },
  news: { type: "scraper", id: "news" },
  market: { type: "toggle", id: "market" },
};

export interface EnabledFeatures {
  readonly enabledScrapers: readonly string[];
  readonly marketEnabled: boolean;
  readonly qdrantEnabled: boolean;
  readonly disabledTools: readonly string[];
}

function isCategoryEnabled(category: string, features: EnabledFeatures): boolean {
  const mapping = CATEGORY_TO_FEATURE[category];
  if (!mapping) return true;
  if (mapping.type === "scraper") return features.enabledScrapers.includes(mapping.id);
  if (mapping.id === "market") return features.marketEnabled;
  if (mapping.id === "qdrant") return features.qdrantEnabled;
  return true;
}

export function applyFeatureFilter(
  catalog: readonly ToolCatalogEntry[],
  features: EnabledFeatures,
): readonly ToolCatalogEntry[] {
  return catalog.map((entry) => {
    const categoryEnabled = isCategoryEnabled(entry.category, features);
    const manuallyDisabled = features.disabledTools.includes(entry.name);
    return {
      ...entry,
      enabled: categoryEnabled && !manuallyDisabled,
    };
  });
}

/** Category derived from ToolDefinition.categories or overridden per-tool */
const CATEGORY_MAP: Record<string, string> = {
  research: "research",
  code: "development",
  analytics: "analytics",
  fileops: "core",
  system: "system",
  memory: "memory",
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
  search_memory: "memory",

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

  // Observability
  get_scraper_status: "observability",
  get_subagent_runs: "observability",
  get_scraper_runs: "observability",

  // Database
  db_query: "database",

  // Process monitoring
  get_process_logs: "process",
  get_process_health: "process",
  process_manage: "system",

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
  x_timeline: "X / Twitter",
  appstore: "App Store",
  playstore: "Play Store",
  market: "Markets & Trading",
  observability: "Observability",
  database: "Database",
  process: "Process Monitor",
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
    inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    enabled: true,
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
  // Market tools
  tools.push(...createMarketTools(["BTCUSDT"], ["spot"]));

  // Observability
  tools.push(createGetScraperStatusTool());
  tools.push(createGetSubagentRunsTool());

  // Database
  tools.push(...createDbTools());

  // Process monitoring
  tools.push(...createProcessMonitorTools());

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
  "x_timeline",
  "appstore",
  "playstore",
  "market",
  "observability",
  "database",
  "process",
  "mcp",
  "development",
  "system",
];
