import { Hono } from "hono";

export interface ToolMeta {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly params: readonly string[];
}

/** Canonical list of all tools with metadata for the UI. */
const ALL_TOOLS: readonly ToolMeta[] = [
  // Core file/shell
  { name: "bash", category: "core", description: "Execute a shell command and return its output", params: ["command", "workingDirectory"] },
  { name: "read_file", category: "core", description: "Read file contents with optional line range", params: ["path", "offset", "limit"] },
  { name: "write_file", category: "core", description: "Write content to a file, creating it if needed", params: ["path", "content"] },
  { name: "edit_file", category: "core", description: "Apply a search-and-replace edit to a file", params: ["path", "old_string", "new_string"] },
  { name: "list_files", category: "core", description: "List files and directories at a given path", params: ["path", "recursive"] },
  { name: "grep", category: "core", description: "Search file contents using regex patterns", params: ["pattern", "path", "include"] },
  { name: "glob", category: "core", description: "Find files matching a glob pattern", params: ["pattern", "cwd"] },

  // Skills
  { name: "list_skills", category: "skills", description: "List available skills by domain", params: ["filter"] },
  { name: "use_skill", category: "skills", description: "Load a skill's patterns and examples into context", params: ["skill_id"] },

  // Sub-agents
  { name: "list_agents", category: "agents", description: "List available sub-agents and their specializations", params: [] },
  { name: "spawn_agent", category: "agents", description: "Spawn a sub-agent to handle a specific task", params: ["task", "agent_id", "timeout_seconds"] },

  // Scheduling
  { name: "cron", category: "scheduling", description: "Create, list, update, or delete scheduled cron jobs", params: ["action", "id", "cron", "prompt", "agent_id"] },

  // Memory
  { name: "remember", category: "memory", description: "Store a key-value memory for cross-session persistence", params: ["key", "value"] },
  { name: "recall", category: "memory", description: "Retrieve a stored memory by key", params: ["key"] },
  { name: "search_memory", category: "memory", description: "Semantic search across all stored memories", params: ["query", "limit"] },

  // News & content
  { name: "search_news", category: "news", description: "Semantic search over indexed news articles", params: ["query", "limit", "hours", "source"] },
  { name: "get_calendar", category: "news", description: "Retrieve economic calendar events (GDP, CPI, rates)", params: ["currency", "importance", "limit"] },
  { name: "get_news_digest", category: "news", description: "Get a digest of recent news grouped by source", params: ["hours", "source"] },

  // Product Hunt
  { name: "search_products", category: "product_hunt", description: "Semantic search over Product Hunt products", params: ["query", "limit"] },
  { name: "get_product_digest", category: "product_hunt", description: "Get recent Product Hunt products with details", params: ["limit"] },

  // Hacker News
  { name: "search_hn", category: "hacker_news", description: "Semantic search over Hacker News stories", params: ["query", "limit"] },
  { name: "get_hn_digest", category: "hacker_news", description: "Get recent HN front page stories with details", params: ["limit"] },

  // Reddit
  { name: "search_reddit", category: "reddit", description: "Semantic search over Reddit posts", params: ["query", "limit"] },
  { name: "get_reddit_digest", category: "reddit", description: "Get recent Reddit posts with details", params: ["limit", "subreddit"] },

  // X / Timeline
  { name: "search_x_timeline", category: "x_timeline", description: "Semantic search over scraped X/Twitter tweets", params: ["query", "limit"] },
  { name: "get_timeline_digest", category: "x_timeline", description: "Get recent tweets from the X/Twitter timeline", params: ["limit", "source"] },

  // Cross-source search
  { name: "cross_source_search", category: "search", description: "Search across ALL indexed sources in one call", params: ["query", "limit", "sources"] },

  // Ideas
  { name: "save_idea", category: "ideas", description: "Save a generated idea to the database", params: ["title", "summary", "reasoning", "category", "sources_used", "quality_score"] },
  { name: "get_previous_ideas", category: "ideas", description: "Get list of previously generated idea titles", params: ["limit"] },
  { name: "get_idea_stats", category: "ideas", description: "Get aggregate statistics about generated ideas", params: [] },
  { name: "update_idea_stage", category: "ideas", description: "Move an idea through the pipeline stages", params: ["id", "stage"] },
  { name: "query_ideas", category: "ideas", description: "Query ideas with filters by stage or category", params: ["stage", "category", "limit"] },
  { name: "search_similar_ideas", category: "ideas", description: "Semantic search over previously generated ideas", params: ["query", "limit"] },

  // Observability
  { name: "get_scraper_status", category: "observability", description: "Check health and freshness of news scrapers", params: ["source"] },
  { name: "get_observations", category: "observability", description: "Retrieve past observations and learnings", params: ["limit"] },
  { name: "get_subagent_runs", category: "observability", description: "View recent sub-agent execution history", params: ["agent_id", "status", "limit"] },

  // Conversation Intelligence
  { name: "search_observations", category: "analytics", description: "Search observations by keyword or phrase", params: ["query", "type", "limit"] },
  { name: "get_conversation_summaries", category: "analytics", description: "Retrieve condensed summaries of past conversations", params: ["channel", "limit"] },

  // Self-Improvement
  { name: "get_tool_usage", category: "analytics", description: "Analyze tool usage patterns and error rates", params: ["agent_id", "hours", "group_by"] },
  { name: "get_agent_performance", category: "analytics", description: "Analyze subagent performance metrics", params: ["agent_id", "hours"] },
  { name: "get_session_stats", category: "analytics", description: "Get aggregate statistics about recent sessions", params: ["hours"] },

  // Market
  { name: "get_market_data", category: "market", description: "Get comprehensive market snapshot for a symbol", params: ["symbol"] },
  { name: "get_market_summary", category: "market", description: "Get 24h market summary for all tracked symbols", params: ["market_type"] },

  // Development
  { name: "project_context", category: "development", description: "Auto-detect project's technology stack and conventions", params: ["path"] },
  { name: "validate_code", category: "development", description: "Run type checking, linting, and tests in one call", params: ["path", "steps", "fix", "timeout"] },
  { name: "run_tests", category: "development", description: "Run the project's test suite with structured results", params: ["path", "filter", "timeout"] },
  { name: "deploy", category: "development", description: "Worktree-aware deploy: merge, detect impacts, restart", params: ["dry_run"] },

  // Process management
  { name: "process_manage", category: "system", description: "Manage OpenCrow processes via the core orchestrator", params: ["action", "target", "reason"] },
];

/** Human-readable category labels */
const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  skills: "Skills",
  agents: "Agents",
  scheduling: "Scheduling",
  memory: "Memory",
  news: "News & Content",
  product_hunt: "Product Hunt",
  hacker_news: "Hacker News",
  reddit: "Reddit",
  x_timeline: "X / Twitter",
  search: "Cross-Source",
  ideas: "Ideas",
  observability: "Observability",
  analytics: "Analytics",
  market: "Market",
  development: "Development",
  system: "System",
};

export function createToolsRoutes(): Hono {
  const app = new Hono();

  app.get("/tools", (c) => {
    return c.json({
      success: true,
      data: ALL_TOOLS,
      categories: CATEGORY_LABELS,
    });
  });

  return app;
}
