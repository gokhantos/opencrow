import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import { getRepos, type GithubRepoRow } from "../sources/github/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";
import { getString, getEnum } from "./input-helpers";

function formatRepo(r: GithubRepoRow, i: number): string {
  const lang = r.language ? ` (${r.language})` : "";
  const desc = r.description ? `\n  ${r.description.slice(0, 200)}` : "";
  const velocity =
    r.stars_velocity != null && Math.abs(r.stars_velocity) > 0.1
      ? ` ⚡ ${r.stars_velocity > 0 ? "+" : ""}${r.stars_velocity.toFixed(1)} stars/hr`
      : "";
  return [
    `${i + 1}. ${r.full_name}${lang}`,
    `  Stars: ${r.stars.toLocaleString()}${velocity} | Forks: ${r.forks.toLocaleString()} | +${r.stars_today} stars ${r.period === "weekly" ? "this week" : "today"}`,
    `  ${desc}`,
    `  URL: ${r.url}`,
  ].join("\n");
}

export function createGithubTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<GithubRepoRow>({
      name: "get_github_repos",
      description:
        "Get trending GitHub repositories with full details (stars, forks, stars gained). Use for discovering popular open-source projects, tracking what's trending in tech, or finding repos by language.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of repos to return (default 30, max 50).",
          },
          language: {
            type: "string",
            description:
              "Filter by programming language (e.g. 'Python', 'TypeScript', 'Rust').",
          },
          period: {
            type: "string",
            enum: ["daily", "weekly"],
            description:
              "Filter by trending period: 'daily' (today) or 'weekly' (this week).",
          },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const language = getString(input, "language");
        const period = getEnum(input, "period", ["daily", "weekly"] as const);
        return getRepos(language, period, limit);
      },
      formatFn: formatRepo,
      headerFn: (results) => `GitHub Trending Repos (${results.length} results):\n`,
      emptyMessage: "No GitHub trending repos found in the database.",
      errorPrefix: "Error retrieving GitHub repos",
    }),
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_github_repos",
        description:
          "Semantic search over GitHub trending repositories. Use for finding popular open-source projects by topic, technology, or use case. Query with concepts like 'machine learning framework' or 'web framework' or 'CLI tool'.",
        agentId: "github",
        kinds: ["github_repo"],
        memoryManager,
        emptyMessage: "No matching GitHub repositories found.",
        errorPrefix: "Error searching GitHub repos",
      }),
    );
  }

  return tools;
}
