/**
 * Default agent definitions seeded into the DB on first startup.
 *
 * Rules:
 * - No systemPrompt (loaded from prompts/agents/{id}.md at runtime)
 * - No telegramBotToken or other secrets
 * - DB is source of truth once a record exists — seeder never overwrites
 */
import type { AgentDefinition } from "../agents/types";

// ---------------------------------------------------------------------------
// Shared tool lists (reused across multiple agents)
// ---------------------------------------------------------------------------

const MEMORY_TOOLS = [
  "remember",
  "recall",
  "search_memory",
] as const;

const IDEA_TOOLS = [
  "save_idea",
  "get_previous_ideas",
  "get_idea_stats",
  "query_ideas",
  "update_idea_stage",
  "search_similar_ideas",
  "get_ideas_by_rating",
  "get_ideas_trends",
  "get_rating_insights",
] as const;

const SIGNAL_TOOLS = [
  "save_signal",
  "get_signals",
  "consume_signals",
  "get_signal_themes",
  "get_cross_domain_signals",
] as const;

const NEWS_TOOLS = [
  "search_news",
  "get_news_digest",
] as const;

const SOCIAL_TOOLS = [
  "search_x_timeline",
  "get_timeline_digest",
  "search_reddit",
  "get_reddit_digest",
] as const;

const HN_TOOLS = [
  "search_hn",
  "get_hn_digest",
] as const;

const PRODUCT_TOOLS = [
  "search_products",
  "get_product_digest",
] as const;

const CROSS_SOURCE_TOOLS = [
  "cross_source_search",
  "web_fetch",
] as const;

const GITHUB_TOOLS = [
  "get_github_repos",
  "search_github_repos",
] as const;

const HF_TOOLS = [
  "get_hf_models",
  "search_hf_models",
] as const;

const ARXIV_TOOLS = [
  "get_arxiv_papers",
  "search_arxiv_papers",
] as const;

const OBSERVABILITY_TOOLS = [
  "get_scraper_status",
  "get_subagent_runs",
  "get_observations",
  "search_observations",
] as const;

const DEFI_TOOLS = [
  "get_defi_protocols",
  "get_defi_movers",
  "get_chain_tvls",
  "get_chain_metrics",
  "get_chain_tvl_history",
  "search_defi",
  "get_yield_pools",
  "get_bridges",
  "get_defi_hacks",
  "get_emissions",
  "get_defi_categories",
  "get_stablecoins",
  "get_treasury",
  "get_protocol_detail",
  "get_global_defi_metrics",
] as const;

const DEX_TOOLS = [
  "get_dex_pairs",
  "get_dex_new_pairs",
  "get_dex_movers",
  "get_dex_boosted",
  "search_dex",
  "get_trending_tokens",
  "get_new_tokens",
  "search_tokens",
  "token_stats",
] as const;

const MARKET_TOOLS = [
  "get_price",
  "market_summary",
  "get_candles",
  "technical_analysis",
  "market_snapshot",
  "futures_overview",
  "funding_rate",
  "funding_summary",
  "liquidations",
] as const;

const APP_STORE_TOOLS = [
  "get_appstore_rankings",
  "get_appstore_complaints",
  "search_appstore_reviews",
  "get_playstore_rankings",
  "get_playstore_complaints",
  "search_playstore_reviews",
] as const;

// ---------------------------------------------------------------------------
// Default modelParams values matching schema defaults
// ---------------------------------------------------------------------------

/** Agents that use adaptive thinking at "high" effort without a fixed budget */
const HIGH_ADAPTIVE_PARAMS = {
  effort: "high" as const,
  thinkingMode: "adaptive" as const,
  thinkingBudget: 128_000,
  extendedContext: false,
};

/** Agents that use adaptive thinking at "medium" effort */
const MEDIUM_ADAPTIVE_PARAMS = {
  effort: "medium" as const,
  thinkingMode: "adaptive" as const,
  thinkingBudget: 128_000,
  extendedContext: false,
};

/** Digest agent: thinking disabled, medium effort */
const MEDIUM_NO_THINKING_PARAMS = {
  effort: "medium" as const,
  thinkingMode: "disabled" as const,
  thinkingBudget: 128_000,
  extendedContext: false,
};

// ---------------------------------------------------------------------------
// Agent seed definitions
// ---------------------------------------------------------------------------

export const AGENT_SEEDS: readonly AgentDefinition[] = [
  // -------------------------------------------------------------------------
  // AI Idea Generator
  // -------------------------------------------------------------------------
  {
    id: "ai-idea-gen",
    name: "AI Idea Generator",
    description:
      "Deep-research agent that discovers trending AI models, papers, and cross-references with HN, Product Hunt, Reddit, and news to generate AI-powered app ideas.",
    model: "claude-sonnet-4-6",
    maxIterations: 40,
    stateless: true,
    reasoning: true,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        ...IDEA_TOOLS,
        ...SIGNAL_TOOLS,
        ...NEWS_TOOLS,
        ...SOCIAL_TOOLS,
        ...HN_TOOLS,
        ...PRODUCT_TOOLS,
        ...CROSS_SOURCE_TOOLS,
        ...HF_TOOLS,
        ...ARXIV_TOOLS,
        ...GITHUB_TOOLS,
        ...OBSERVABILITY_TOOLS,
      ],
    },
    modelParams: HIGH_ADAPTIVE_PARAMS,
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: {},
    hooks: { auditLog: true, notifications: true },
    skills: [],
  },

  // -------------------------------------------------------------------------
  // Build Error Resolver
  // -------------------------------------------------------------------------
  {
    id: "build-error-resolver",
    name: "Build Error Resolver",
    description:
      "Fix build and type errors with minimal diffs. No refactoring, no architecture changes.",
    model: "claude-sonnet-4-6",
    maxIterations: 30,
    stateless: true,
    reasoning: true,
    toolFilter: { mode: "all", tools: [] },
    modelParams: { effort: "high", thinkingMode: "adaptive", thinkingBudget: 32000, extendedContext: false },
    subagents: { allowAgents: [], maxChildren: 1 },
  },

  // -------------------------------------------------------------------------
  // Crypto Analyst
  // -------------------------------------------------------------------------
  {
    id: "crypto-analyst",
    name: "Crypto Analyst",
    description:
      "Crypto market analyst with full access to DeFi, DEX, futures, and market data. Analyzes trends, finds opportunities, and tracks portfolio signals.",
    model: "claude-sonnet-4-6",
    maxIterations: 50,
    stateless: true,
    reasoning: true,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        ...DEFI_TOOLS,
        ...DEX_TOOLS,
        ...MARKET_TOOLS,
        ...SIGNAL_TOOLS,
        ...IDEA_TOOLS,
        ...NEWS_TOOLS,
        ...SOCIAL_TOOLS,
        ...CROSS_SOURCE_TOOLS,
        "send_message",
        ...OBSERVABILITY_TOOLS,
      ],
    },
    modelParams: { effort: "high", thinkingMode: "adaptive", thinkingBudget: 50000, extendedContext: false },
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: {},
  },

  // -------------------------------------------------------------------------
  // Crypto Idea Generator
  // -------------------------------------------------------------------------
  {
    id: "crypto-idea-gen",
    name: "Crypto Idea Generator",
    description:
      "Generates crypto/DeFi project ideas by cross-referencing on-chain data, market trends, news, and community signals.",
    model: "claude-sonnet-4-6",
    maxIterations: 40,
    stateless: true,
    reasoning: true,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        ...IDEA_TOOLS,
        ...SIGNAL_TOOLS,
        ...NEWS_TOOLS,
        ...SOCIAL_TOOLS,
        ...HN_TOOLS,
        ...PRODUCT_TOOLS,
        ...CROSS_SOURCE_TOOLS,
        ...DEFI_TOOLS,
        ...DEX_TOOLS,
        ...MARKET_TOOLS,
        ...OBSERVABILITY_TOOLS,
      ],
    },
    modelParams: HIGH_ADAPTIVE_PARAMS,
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: {},
    hooks: { auditLog: true, notifications: true },
    skills: [],
  },

  // -------------------------------------------------------------------------
  // Debugger
  // -------------------------------------------------------------------------
  {
    id: "debugger",
    name: "Debugger",
    description:
      "Root cause analysis, error tracing, log reading, hypothesis-driven debugging.",
    model: "claude-sonnet-4-6",
    maxIterations: 50,
    stateless: true,
    reasoning: true,
    toolFilter: { mode: "all", tools: [] },
    modelParams: { effort: "high", thinkingMode: "adaptive", thinkingBudget: 50000, extendedContext: false },
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: { dbhub: true },
  },

  // -------------------------------------------------------------------------
  // Digest
  // -------------------------------------------------------------------------
  {
    id: "digest",
    name: "Digest",
    description: "Compiles research digests from all data sources and delivers summaries.",
    model: "claude-haiku-4-5",
    maxIterations: 20,
    stateless: true,
    reasoning: false,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        "get_hn_digest",
        "get_reddit_digest",
        "get_product_digest",
        "get_arxiv_papers",
        "get_github_repos",
        "get_hf_models",
        "get_news_digest",
        "get_timeline_digest",
        "cross_source_search",
        "send_message",
      ],
    },
    modelParams: MEDIUM_NO_THINKING_PARAMS,
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: {},
  },

  // -------------------------------------------------------------------------
  // Mobile Idea Generator
  // -------------------------------------------------------------------------
  {
    id: "mobile-idea-gen",
    name: "Mobile Idea Generator",
    description:
      "Generates mobile app ideas by analyzing App Store/Play Store rankings, reviews, trends, and cross-referencing with community signals.",
    model: "claude-sonnet-4-6",
    maxIterations: 40,
    stateless: true,
    reasoning: true,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        ...IDEA_TOOLS,
        ...SIGNAL_TOOLS,
        ...NEWS_TOOLS,
        ...SOCIAL_TOOLS,
        ...HN_TOOLS,
        ...PRODUCT_TOOLS,
        ...CROSS_SOURCE_TOOLS,
        ...APP_STORE_TOOLS,
        ...OBSERVABILITY_TOOLS,
      ],
    },
    modelParams: HIGH_ADAPTIVE_PARAMS,
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: {},
    hooks: { auditLog: true, notifications: true },
    skills: [],
  },

  // -------------------------------------------------------------------------
  // OpenCrow (main orchestrator)
  // -------------------------------------------------------------------------
  {
    id: "opencrow",
    name: "OpenCrow",
    description: "",
    default: true,
    model: "claude-sonnet-4-6",
    maxIterations: 150,
    stateless: false,
    reasoning: true,
    toolFilter: { mode: "all", tools: [] },
    modelParams: { effort: "max", thinkingMode: "adaptive", thinkingBudget: 128000, extendedContext: false },
    subagents: { allowAgents: ["*"], maxChildren: 10 },
    mcpServers: {
      git: true,
      dbhub: true,
      github: true,
      qdrant: true,
      serena: true,
      browser: true,
      context7: true,
      firecrawl: true,
      filesystem: true,
      braveSearch: true,
      sequentialThinking: true,
    },
    hooks: { auditLog: true, notifications: true },
    skills: [],
  },

  // -------------------------------------------------------------------------
  // OSS Idea Generator
  // -------------------------------------------------------------------------
  {
    id: "oss-idea-gen",
    name: "OSS Idea Generator",
    description:
      "Generates open-source project ideas by analyzing GitHub trends, HN, Reddit, arXiv papers, and community signals.",
    model: "claude-sonnet-4-6",
    maxIterations: 40,
    stateless: true,
    reasoning: true,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        ...IDEA_TOOLS,
        ...SIGNAL_TOOLS,
        ...NEWS_TOOLS,
        ...SOCIAL_TOOLS,
        ...HN_TOOLS,
        ...PRODUCT_TOOLS,
        ...CROSS_SOURCE_TOOLS,
        ...GITHUB_TOOLS,
        ...HF_TOOLS,
        ...ARXIV_TOOLS,
        ...OBSERVABILITY_TOOLS,
      ],
    },
    modelParams: HIGH_ADAPTIVE_PARAMS,
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: {},
    hooks: { auditLog: true, notifications: true },
    skills: [],
  },

  // -------------------------------------------------------------------------
  // Planner
  // -------------------------------------------------------------------------
  {
    id: "planner",
    name: "Planner",
    description:
      "Expert planning specialist for complex features and refactoring. Creates detailed implementation plans.",
    model: "claude-sonnet-4-6",
    maxIterations: 30,
    stateless: true,
    reasoning: true,
    toolFilter: { mode: "all", tools: [] },
    modelParams: { effort: "high", thinkingMode: "adaptive", thinkingBudget: 50000, extendedContext: false },
    subagents: { allowAgents: [], maxChildren: 1 },
  },

  // -------------------------------------------------------------------------
  // Researcher
  // -------------------------------------------------------------------------
  {
    id: "researcher",
    name: "Researcher",
    description: "Research agent with access to all data sources, web search, and memory.",
    model: "claude-sonnet-4-6",
    maxIterations: 50,
    stateless: true,
    reasoning: true,
    toolFilter: {
      mode: "allowlist",
      tools: [
        ...MEMORY_TOOLS,
        ...NEWS_TOOLS,
        ...SOCIAL_TOOLS,
        ...HN_TOOLS,
        ...PRODUCT_TOOLS,
        ...CROSS_SOURCE_TOOLS,
        ...GITHUB_TOOLS,
        ...HF_TOOLS,
        ...ARXIV_TOOLS,
        "get_calendar",
        "read_file",
        "grep",
        "glob",
        "list_files",
        "send_message",
        ...OBSERVABILITY_TOOLS,
      ],
    },
    modelParams: MEDIUM_ADAPTIVE_PARAMS,
    subagents: { allowAgents: [], maxChildren: 1 },
    mcpServers: { browser: true },
  },
] as const;
