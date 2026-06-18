/**
 * Tool privilege classification — fail-closed least-privilege policy.
 *
 * OpenCrow agents ingest untrusted scraped/channel content, so a prompt-injection
 * that reaches the model must NOT be able to reach high-impact primitives (shell,
 * file writes, process control, agent CRUD, db writes/reads, git). This module is
 * the single source of truth for which tools are dangerous and which an agent gets
 * by default.
 *
 * Rules enforced here (see `isToolGranted` / `buildAgentDisallowedNativeTools`):
 *  - HIGH-IMPACT tools are NEVER granted implicitly. Even an agent with
 *    toolFilter.mode === "all" does NOT get them unless they are explicitly
 *    listed in toolFilter.tools.
 *  - ADMIN tools (a subset of high-impact: agent CRUD, sub-agent spawn, process
 *    control) are likewise excluded from any implicit grant.
 *  - The default tool filter is a conservative allowlist of read / research /
 *    memory / read-only scraper-and-search tools.
 */

/**
 * High-impact tools that enable escalation, exfiltration, or persistence.
 * Never granted by default; only via an explicit per-agent allowlist entry.
 *
 * Note on name variants: the cron-trigger tool is registered as `trigger_cron`
 * and the process-control tool as `process_manage`; we keep the alias spellings
 * (`cron_trigger`, `self_restart`) so the policy is robust to either naming.
 */
export const HIGH_IMPACT_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "write_file",
  "edit_file",
  "process_manage",
  "self_restart",
  "cron",
  "trigger_cron",
  "cron_trigger",
  "spawn_agent",
  "db_query",
  "manage_agent",
  "git_operations",
]);

/**
 * Admin tools — a strict subset of HIGH_IMPACT that mutate the platform's own
 * control surface (agents, sub-agents, processes). These are excluded from any
 * implicit grant and are the primary monotonicity targets for manage_agent.
 */
export const ADMIN_TOOLS: ReadonlySet<string> = new Set([
  "manage_agent",
  "spawn_agent",
  "process_manage",
  "self_restart",
]);

/**
 * High-impact tools that the Agent SDK provides natively (not through the
 * OpenCrow MCP bridge). These cannot be removed by filtering the OpenCrow tool
 * registry — they must be added to the SDK's `disallowedTools` instead.
 */
export const SDK_NATIVE_HIGH_IMPACT_TOOLS: readonly string[] = [
  "bash",
  "write_file",
  "edit_file",
];

/**
 * Conservative fail-closed default allowlist for any agent without an explicit
 * toolFilter. Read / research / memory / read-only scraper + search tools only.
 * Deliberately contains NO high-impact tool.
 */
export const DEFAULT_AGENT_TOOL_ALLOWLIST: readonly string[] = [
  // Read-only file / code navigation
  "read_file",
  "list_files",
  "grep",
  "glob",
  // Skills
  "list_skills",
  "use_skill",
  // Memory (read + write own memory — not platform state)
  "remember",
  "search_memory",
  // News & content (read-only)
  "search_news",
  "get_news_digest",
  "get_calendar",
  // Product Hunt
  "search_products",
  "get_product_digest",
  // Hacker News
  "search_hn",
  "get_hn_digest",
  // Reddit
  "search_reddit",
  "get_reddit_digest",
  // GitHub (read-only listings)
  "get_github_repos",
  "search_github_repos",
  // X / Twitter (read-only)
  "search_x_timeline",
  "get_timeline_digest",
  "get_liked_tweets",
  "get_x_analytics",
  // App Store
  "get_appstore_rankings",
  "get_appstore_complaints",
  "search_appstore_reviews",
  "search_appstore_apps",
  // Play Store
  "get_playstore_rankings",
  "get_playstore_complaints",
  "search_playstore_reviews",
  "search_playstore_apps",
  // Observability (read-only)
  "get_scraper_status",
  "get_subagent_runs",
  "get_process_logs",
  "get_process_health",
  // Development (read-only / analysis)
  "project_context",
  "validate_code",
  "run_tests",
  // Sub-agent discovery (spawn_agent stays high-impact and is NOT here)
  "list_agents",
  // SIGE (read-only strategic queries)
  "sige_get_report",
  "sige_get_session",
  "sige_list_sessions",
  "sige_query_game_history",
  "sige_search_strategic_ideas",
  "sige_get_population_dynamics",
];

import type { ToolFilter } from "../agents/types";

/**
 * The fail-closed default tool filter: an explicit allowlist, never `mode:"all"`.
 */
export const FAIL_CLOSED_DEFAULT_TOOL_FILTER: ToolFilter = {
  mode: "allowlist",
  tools: DEFAULT_AGENT_TOOL_ALLOWLIST,
};

/** True if `name` names a high-impact tool. */
export function isHighImpactTool(name: string): boolean {
  return HIGH_IMPACT_TOOLS.has(name);
}

/** True if `name` names an admin (platform-control) tool. */
export function isAdminTool(name: string): boolean {
  return ADMIN_TOOLS.has(name);
}

/**
 * Authoritative grant check applied on top of the agent's tool filter.
 *
 * A high-impact tool is granted ONLY when it is explicitly listed in an
 * allowlist filter's `tools`. This means:
 *  - mode "all"       → grants everything EXCEPT high-impact tools.
 *  - mode "allowlist" → grants exactly the listed tools (high-impact ones only
 *                       if explicitly listed).
 *  - mode "blocklist" → grants everything not blocked EXCEPT high-impact tools
 *                       (blocklist can never re-grant a high-impact tool).
 *
 * Non-high-impact tools follow the filter's normal semantics.
 */
export function isToolGranted(filter: ToolFilter, name: string): boolean {
  if (HIGH_IMPACT_TOOLS.has(name)) {
    // High-impact: only via explicit allowlist membership.
    return filter.mode === "allowlist" && filter.tools.includes(name);
  }

  switch (filter.mode) {
    case "all":
      return true;
    case "allowlist":
      return filter.tools.includes(name);
    case "blocklist":
      return !filter.tools.includes(name);
  }
}

/**
 * The set of high-impact tools an agent is explicitly granted (allowlist only).
 * Used for privilege-monotonicity checks in manage_agent.
 */
export function grantedHighImpactTools(filter: ToolFilter): ReadonlySet<string> {
  if (filter.mode !== "allowlist") return new Set();
  return new Set(filter.tools.filter((t) => HIGH_IMPACT_TOOLS.has(t)));
}

/**
 * SDK-native high-impact tools to add to the SDK `disallowedTools` list for a
 * given agent: any native high-impact tool the agent is NOT explicitly granted.
 */
export function buildAgentDisallowedNativeTools(filter: ToolFilter): string[] {
  return SDK_NATIVE_HIGH_IMPACT_TOOLS.filter((t) => !isToolGranted(filter, t));
}
