import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { MemoryManager } from "../memory/types";
import { getTimelineTweets } from "../sources/x/timeline/store";
import { getDb } from "../store/db";
import { createSemanticSearchTool } from "./search-factory";
import { getNumber, getEnum, getString } from "./input-helpers";

function formatTweet(
  t: {
    author_username: string;
    text: string;
    likes: number;
    retweets: number;
    replies: number;
    views: number;
    source: string;
    tweet_created_at: number | null;
    scraped_at: number;
    likes_velocity?: number | null;
    views_velocity?: number | null;
  },
  i: number,
): string {
  const date = t.tweet_created_at
    ? new Date(t.tweet_created_at * 1000).toISOString()
    : new Date(t.scraped_at * 1000).toISOString();
  const likesVelocity =
    t.likes_velocity != null && Math.abs(t.likes_velocity) > 0.1
      ? ` ⚡ ${t.likes_velocity > 0 ? "+" : ""}${t.likes_velocity.toFixed(1)} likes/hr`
      : "";
  return [
    `${i + 1}. @${t.author_username} [${t.source}]`,
    `  ${t.text.slice(0, 300)}`,
    `  ${t.likes} likes${likesVelocity} | ${t.retweets} RTs | ${t.replies} replies | ${t.views} views`,
    `  Date: ${date}`,
  ].join("\n");
}

function createGetTimelineDigestTool(): ToolDefinition {
  return {
    name: "get_timeline_digest",
    description:
      "Get recent tweets from the scraped X/Twitter timeline (home feed and top posts). Returns raw tweet data with engagement metrics. Use for browsing what's trending or getting a feed overview.",
    categories: ["research", "social"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of tweets to return (default 30, max 50).",
        },
        source: {
          type: "string",
          enum: ["home", "top_posts"],
          description: "Filter by timeline source.",
        },
      },
      required: [],
    },
    async execute(input): Promise<ToolResult> {
      const limit = getNumber(input, "limit", { defaultVal: 30, min: 1, max: 50 });
      const source = getEnum(input, "source", ["home", "top_posts"] as const);

      try {
        const db = getDb();
        const accounts = await db`
          SELECT account_id FROM x_timeline_scrape_jobs
          WHERE status = 'running'
          ORDER BY last_run_at DESC NULLS LAST
          LIMIT 1
        `;

        if (accounts.length === 0) {
          return {
            output: "No active timeline scrape accounts found.",
            isError: false,
          };
        }

        const accountId = accounts[0]!.account_id as string;
        const tweets = await getTimelineTweets(accountId, source, limit);

        if (tweets.length === 0) {
          return {
            output: "No timeline tweets found in the database.",
            isError: false,
          };
        }

        const header = `X Timeline (${tweets.length} tweets):\n`;
        const rows = tweets.map(formatTweet);
        return { output: header + rows.join("\n\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          output: `Error retrieving timeline digest: ${msg}`,
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// X/Twitter Intelligence Tools
// ============================================================================

function createGetLikedTweetsTool(): ToolDefinition {
  return {
    name: "get_liked_tweets",
    description:
      "Query tweets that were liked. Useful for understanding what content the account finds interesting.",
    categories: ["research", "social"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max tweets to return (default 20, max 50).",
        },
        account_id: {
          type: "string",
          description: "Filter by account ID.",
        },
      },
      required: [],
    },
    async execute(input): Promise<ToolResult> {
      const limit = getNumber(input, "limit", { defaultVal: 20, min: 1, max: 50 });
      const accountId = getString(input, "account_id", { allowEmpty: true });

      try {
        const db = getDb();

        let rows;
        if (accountId) {
          rows = await db`
            SELECT * FROM x_liked_tweets
            WHERE account_id = ${accountId}
            ORDER BY liked_at DESC
            LIMIT ${limit}
          `;
        } else {
          rows = await db`
            SELECT * FROM x_liked_tweets
            ORDER BY liked_at DESC
            LIMIT ${limit}
          `;
        }

        if (rows.length === 0) {
          return { output: "No liked tweets found.", isError: false };
        }

        const lines = rows.map((t: {
          tweet_id: string;
          author_username: string;
          text: string;
          likes: number;
          retweets: number;
          liked_at: number;
        }, i: number) => {
          const date = new Date(t.liked_at * 1000).toLocaleDateString();
          return `${i + 1}. @${t.author_username} | ${t.likes} likes | ${t.retweets} RTs | ${date}\n  ${t.text.slice(0, 200)}`;
        });

        return {
          output: `Liked tweets (${rows.length}):\n\n${lines.join("\n\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching liked tweets: ${msg}`, isError: true };
      }
    },
  };
}

function createGetXAnalyticsTool(): ToolDefinition {
  return {
    name: "get_x_analytics",
    description:
      "Get engagement analytics from scraped tweets. Shows aggregated likes, retweets, views by account and time period.",
    categories: ["research", "social", "analytics"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        days_back: {
          type: "number",
          description: "How many days to look back (default 7, max 30).",
        },
      },
      required: [],
    },
    async execute(input): Promise<ToolResult> {
      const daysBack = Math.min((input.days_back as number) || 7, 30);

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - daysBack * 86400;

        // Engagement by account
        const byAccount = await db`
          SELECT
            author_username,
            COUNT(*) as tweet_count,
            SUM(likes) as total_likes,
            SUM(retweets) as total_retweets,
            SUM(replies) as total_replies,
            SUM(views) as total_views
          FROM x_scraped_tweets
          WHERE scraped_at >= ${since}
          GROUP BY author_username
          ORDER BY total_likes DESC
          LIMIT 15
        `;

        // Engagement by day
        const byDay = await db`
          SELECT
            DATE(TO_TIMESTAMP(scraped_at)) as day,
            COUNT(*) as tweets,
            SUM(likes) as likes,
            SUM(retweets) as retweets
          FROM x_scraped_tweets
          WHERE scraped_at >= ${since}
          GROUP BY day
          ORDER BY day DESC
          LIMIT ${daysBack}
        `;

        const lines: string[] = [];

        // Total engagement
        const totalLikes = byAccount.reduce((sum: number, r: any) => sum + Number(r.total_likes), 0);
        const totalRTs = byAccount.reduce((sum: number, r: any) => sum + Number(r.total_retweets), 0);
        const totalViews = byAccount.reduce((sum: number, r: any) => sum + Number(r.total_views), 0);
        const totalTweets = byAccount.reduce((sum: number, r: any) => sum + Number(r.tweet_count), 0);

        lines.push(`Total (last ${daysBack} days): ${totalTweets} tweets, ${totalLikes} likes, ${totalRTs} RTs, ${totalViews} views`);

        if (byAccount.length > 0) {
          lines.push("\nTop accounts by likes:");
          for (const r of byAccount.slice(0, 10)) {
            lines.push(`  @${r.author_username}: ${r.tweet_count} tweets, ${r.total_likes} likes, ${r.total_retweets} RTs`);
          }
        }

        if (byDay.length > 0) {
          lines.push(`\nBy day:`);
          for (const r of byDay.slice(0, 7)) {
            const day = new Date(r.day).toLocaleDateString();
            lines.push(`  ${day}: ${r.tweets} tweets, ${r.likes} likes, ${r.retweets} RTs`);
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching X analytics: ${msg}`, isError: true };
      }
    },
  };
}

export function createXTimelineTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createGetTimelineDigestTool(),
    createGetLikedTweetsTool(),
    createGetXAnalyticsTool(),
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_x_timeline",
        description:
          "Semantic search over scraped X/Twitter timeline tweets. Use natural language queries to find tweets by topic, sentiment, or content. Good for discovering what people are talking about on Twitter.",
        agentId: "x-timeline",
        kinds: ["tweet"],
        memoryManager,
        formatResult: (r, i) => {
          const meta = r.source.metadata ?? {};
          const author = meta.authorHandle ?? "unknown";
          return `${i + 1}. @${author} (score: ${r.score.toFixed(2)})\n  ${r.chunk.content.slice(0, 300)}`;
        },
        emptyMessage: "No matching timeline tweets found.",
        errorPrefix: "Error searching timeline",
      }),
    );
  }

  return tools;
}
