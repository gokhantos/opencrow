import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import { getPosts, type RedditPostRow } from "../sources/reddit/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";
import { getString } from "./input-helpers";

function formatPost(p: RedditPostRow, i: number): string {
  const flairLabel = p.flair ? ` [${p.flair}]` : "";
  const selftext = p.selftext ? `\n  ${p.selftext.slice(0, 200)}...` : "";
  const firstComment = (() => {
    if (!p.top_comments_json) return "";
    try {
      const comments = JSON.parse(p.top_comments_json) as string[];
      const first = comments[0];
      return first ? `\n  Top comment: ${first.slice(0, 200)}` : "";
    } catch {
      return "";
    }
  })();
  return [
    `${i + 1}. r/${p.subreddit}${flairLabel}: ${p.title}`,
    `  ${p.score} pts | ${p.num_comments} comments | by u/${p.author} | ${p.domain}`,
    `  URL: ${p.url}`,
    `  Reddit: ${p.permalink}`,
    selftext,
    firstComment,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createRedditTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<RedditPostRow>({
      name: "get_reddit_digest",
      description:
        "Get recent Reddit posts with full details (score, comments, subreddit). Use for browsing what's trending on Reddit, community discussions, crypto sentiment, or tech topics. Optionally filter by subreddit.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: {
            type: "string",
            description:
              "Optional subreddit name to filter (e.g. 'programming', 'cryptocurrency').",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (default 30, max 50).",
          },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const subreddit = getString(input, "subreddit");
        return getPosts(subreddit, limit);
      },
      formatFn: formatPost,
      headerFn: (results, input) => {
        const subreddit = getString(input, "subreddit");
        const sub = subreddit ? `r/${subreddit}` : "All Subreddits";
        return `Reddit - ${sub} (${results.length} posts):\n`;
      },
      emptyMessage: "No Reddit posts found in the database.",
      errorPrefix: "Error retrieving Reddit posts",
    }),
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_reddit",
        description:
          "Semantic search over Reddit posts. Use for finding discussions, trending topics, crypto sentiment, or developer community opinions. Query with concepts like 'Solana DeFi protocols' or 'React server components debate'.",
        agentId: "reddit",
        kinds: ["reddit_post"],
        memoryManager,
        emptyMessage: "No matching Reddit posts found.",
        errorPrefix: "Error searching Reddit",
      }),
    );
  }

  return tools;
}
