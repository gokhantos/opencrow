import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";
import { getNumber, getString, getEnum, isToolError, requireString } from "./input-helpers";

// ============================================================================
// Memory/Context Tools
// ============================================================================

interface MemorySourceRow {
  id: string;
  kind: string;
  agent_id: string;
  channel: string | null;
  chat_id: string | null;
  metadata_json: string;
  created_at: number;
}

interface MemoryChunkRow {
  id: string;
  source_id: string;
  content: string;
  chunk_index: number;
  token_count: number;
  created_at: number;
}

const MEMORY_KINDS = [
  "conversation",
  "note",
  "document",
  "tweet",
  "article",
  "product",
  "story",
  "reddit_post",
  "hf_model",
  "github_repo",
  "arxiv_paper",
  "observation",
  "idea",
] as const;

export function createMemoryStatsTools(): ToolDefinition[] {
  return [
    createGetMemoryStatsTool(),
    createSearchMemorySourcesTool(),
  ];
}

function createGetMemoryStatsTool(): ToolDefinition {
  return {
    name: "get_memory_stats",
    description:
      "Get storage usage statistics for memory/chunks. Shows counts by kind, source breakdown, and estimated storage. Useful for understanding memory usage patterns.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    categories: ["analytics", "memory"] as readonly ToolCategory[],
    async execute(): Promise<{ output: string; isError: boolean }> {
      try {
        const db = getDb();

        // Get source counts by kind
        const sourceCounts = await db`
          SELECT kind, COUNT(*) as count
          FROM memory_sources
          GROUP BY kind
          ORDER BY count DESC
        `;

        // Get total chunk count
        const chunkCountResult = await db`
          SELECT COUNT(*) as total, SUM(token_count) as tokens
          FROM memory_chunks
        `;

        // Get source count
        const sourceCountResult = await db`
          SELECT COUNT(*) as total
          FROM memory_sources
        `;

        // Get recent sources (last 7 days)
        const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
        const recentSources = await db`
          SELECT COUNT(*) as count
          FROM memory_sources
          WHERE created_at >= ${weekAgo}
        `;

        const totalChunks = Number(chunkCountResult[0]?.total || 0);
        const totalTokens = Number(chunkCountResult[0]?.tokens || 0);
        const totalSources = Number(sourceCountResult[0]?.total || 0);
        const recentCount = Number(recentSources[0]?.count || 0);

        // Estimate storage (rough: ~4 chars per token)
        const estimatedMB = (totalTokens * 4) / (1024 * 1024);

        const lines: string[] = [];
        lines.push(`Total sources: ${totalSources}`);
        lines.push(`Total chunks: ${totalChunks}`);
        lines.push(`Total tokens: ${totalTokens.toLocaleString()}`);
        lines.push(`Estimated storage: ~${estimatedMB.toFixed(1)} MB`);
        lines.push(`Sources (last 7 days): ${recentCount}`);
        lines.push("");

        if (sourceCounts.length > 0) {
          lines.push("By kind:");
          for (const s of sourceCounts) {
            lines.push(`  ${s.kind}: ${s.count}`);
          }
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching memory stats: ${msg}`, isError: true };
      }
    },
  };
}

function createSearchMemorySourcesTool(): ToolDefinition {
  return {
    name: "search_memory_sources",
    description:
      "Find and list memory sources by kind, agent, or channel. Useful for understanding what data sources exist and their characteristics.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...MEMORY_KINDS],
          description: "Filter by source kind.",
        },
        agent_id: {
          type: "string",
          description: "Filter by agent ID.",
        },
        channel: {
          type: "string",
          description: "Filter by channel (e.g., 'telegram', 'whatsapp').",
        },
        limit: {
          type: "number",
          description: "Max sources to return (default 20, max 100).",
        },
      },
      required: [],
    },
    categories: ["analytics", "memory"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const kind = getEnum(input, "kind", MEMORY_KINDS);
      const agentId = getString(input, "agent_id", { allowEmpty: true });
      const channel = getString(input, "channel", { allowEmpty: true });
      const limit = getNumber(input, "limit", { defaultVal: 20, min: 1, max: 100 });

      try {
        const db = getDb();

        let rows: readonly MemorySourceRow[];

        if (kind && agentId) {
          rows = await db`
            SELECT * FROM memory_sources
            WHERE kind = ${kind} AND agent_id = ${agentId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else if (kind) {
          rows = await db`
            SELECT * FROM memory_sources
            WHERE kind = ${kind}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else if (agentId) {
          rows = await db`
            SELECT * FROM memory_sources
            WHERE agent_id = ${agentId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else if (channel) {
          rows = await db`
            SELECT * FROM memory_sources
            WHERE channel = ${channel}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else {
          rows = await db`
            SELECT * FROM memory_sources
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }

        if (rows.length === 0) {
          return { output: "No memory sources found for the specified filters.", isError: false };
        }

        const lines = rows.map((r) => {
          const ts = new Date(r.created_at * 1000).toLocaleDateString();
          let meta: Record<string, unknown> = {};
          try { meta = JSON.parse(r.metadata_json); } catch { /* ignore invalid JSON */ }
          const title = (meta.title as string) || (meta.name as string) || r.id.slice(0, 8);
          return `${r.kind}: ${title} [${r.agent_id}] ${ts}`;
        });

        return {
          output: `Found ${rows.length} memory source(s):\n\n${lines.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error searching memory sources: ${msg}`, isError: true };
      }
    },
  };
}