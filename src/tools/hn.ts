import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import { getStories, type HNStoryRow } from "../sources/hackernews/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";

function formatStory(s: HNStoryRow, i: number): string {
  const site = s.site_label ? ` (${s.site_label})` : "";
  const descLine = s.description ? `\n  ${s.description}` : "";
  const velocity =
    s.points_velocity != null && Math.abs(s.points_velocity) > 0.1
      ? ` ⚡ ${s.points_velocity > 0 ? "+" : ""}${s.points_velocity.toFixed(1)} pts/hr`
      : "";
  return [
    `${i + 1}. #${s.rank} ${s.title}${site}`,
    `  ${s.points} pts${velocity} | ${s.comment_count} comments | by ${s.author} | ${s.age}`,
    `  URL: ${s.url}`,
    `  HN: ${s.hn_url}${descLine}`,
  ].join("\n");
}

export function createHNTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<HNStoryRow>({
      name: "get_hn_digest",
      description:
        "Get recent Hacker News front page stories with full details (points, comments, rank). Use for browsing what's trending in tech, finding discussion topics, or staying current with developer news.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of stories to return (default 30, max 50).",
          },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getStories(undefined, limit),
      formatFn: formatStory,
      headerFn: (results) => `Hacker News Front Page (${results.length} stories):\n`,
      emptyMessage: "No HN stories found in the database.",
      errorPrefix: "Error retrieving HN stories",
    }),
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_hn",
        description:
          "Semantic search over Hacker News stories. Use for finding tech discussions, trending topics, developer sentiment, or specific project mentions. Query with concepts like 'Rust vs Go performance' or 'LLM fine-tuning techniques'.",
        agentId: "hn",
        kinds: ["story"],
        memoryManager,
        emptyMessage: "No matching HN stories found.",
        errorPrefix: "Error searching HN",
      }),
    );
  }

  return tools;
}
