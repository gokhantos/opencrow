import { Hono } from "hono";
import { getDb } from "../../store/db";
import type { MemoryManager } from "../../memory/types";

interface ChunkRow {
  readonly id: string;
  readonly source_id: string;
  readonly content: string;
  readonly chunk_index: number;
  readonly token_count: number;
  readonly created_at: number;
}

interface SourceRow {
  readonly id: string;
  readonly kind: string;
  readonly agent_id: string;
  readonly channel: string | null;
  readonly metadata_json: string;
  readonly created_at: number;
}

interface AgentMemoryRow {
  readonly agent_id: string;
  readonly key: string;
  readonly value: string;
  readonly updated_at: number;
}

interface KindCountRow {
  readonly kind: string;
  readonly count: number;
}

interface AgentCountRow {
  readonly agent_id: string;
  readonly chunk_count: number;
  readonly source_count: number;
  readonly total_tokens: number;
}

/**
 * Debug routes that only need PostgreSQL — always mounted regardless of memoryManager.
 */
export function createMemoryDebugRoutes(): Hono {
  const app = new Hono();

  app.get("/memory/debug/stats", async (c) => {
    const db = getDb();

    const [overallRows, kindRows, agentRows, agentMemoryCountRows] =
      await Promise.all([
        db`
        SELECT
          COUNT(DISTINCT ms.id) as source_count,
          COUNT(mc.id) as chunk_count,
          COALESCE(SUM(mc.token_count), 0) as total_tokens
        FROM memory_sources ms
        LEFT JOIN memory_chunks mc ON mc.source_id = ms.id
      `,
        db`
        SELECT ms.kind, COUNT(mc.id) as count
        FROM memory_sources ms
        LEFT JOIN memory_chunks mc ON mc.source_id = ms.id
        GROUP BY ms.kind
        ORDER BY count DESC
      `,
        db`
        SELECT
          ms.agent_id,
          COUNT(mc.id) as chunk_count,
          COUNT(DISTINCT ms.id) as source_count,
          COALESCE(SUM(mc.token_count), 0) as total_tokens
        FROM memory_sources ms
        LEFT JOIN memory_chunks mc ON mc.source_id = ms.id
        GROUP BY ms.agent_id
        ORDER BY chunk_count DESC
      `,
        db`SELECT COUNT(DISTINCT agent_id) as count FROM agent_memory`,
      ]);

    const overall = overallRows[0] as {
      source_count: number;
      chunk_count: number;
      total_tokens: number;
    } | undefined;

    return c.json({
      success: true,
      data: {
        totalSources: Number(overall?.source_count ?? 0),
        totalChunks: Number(overall?.chunk_count ?? 0),
        totalTokens: Number(overall?.total_tokens ?? 0),
        agentsWithMemory: Number(
          (agentMemoryCountRows[0] as { count: number } | undefined)?.count ?? 0,
        ),
        byKind: (kindRows as KindCountRow[]).map((r) => ({
          kind: r.kind,
          count: Number(r.count),
        })),
        byAgent: (agentRows as AgentCountRow[]).map((r) => ({
          agentId: r.agent_id,
          chunkCount: Number(r.chunk_count),
          sourceCount: Number(r.source_count),
          totalTokens: Number(r.total_tokens),
        })),
      },
    });
  });

  app.get("/memory/debug/chunks", async (c) => {
    const db = getDb();
    const agentId = c.req.query("agentId");
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);

    let rows;
    if (agentId) {
      rows = await db`
        SELECT mc.id, mc.source_id, mc.content, mc.chunk_index, mc.token_count, mc.created_at,
               ms.kind, ms.agent_id, ms.channel, ms.metadata_json
        FROM memory_chunks mc
        JOIN memory_sources ms ON ms.id = mc.source_id
        WHERE ms.agent_id = ${agentId}
        ORDER BY mc.created_at DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await db`
        SELECT mc.id, mc.source_id, mc.content, mc.chunk_index, mc.token_count, mc.created_at,
               ms.kind, ms.agent_id, ms.channel, ms.metadata_json
        FROM memory_chunks mc
        JOIN memory_sources ms ON ms.id = mc.source_id
        ORDER BY mc.created_at DESC
        LIMIT ${limit}
      `;
    }

    const data = (
      rows as (ChunkRow & SourceRow)[]
    ).map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      content: r.content,
      chunkIndex: r.chunk_index,
      tokenCount: r.token_count,
      createdAt: r.created_at,
      kind: r.kind,
      agentId: r.agent_id,
      channel: r.channel,
    }));

    return c.json({ success: true, data });
  });

  app.get("/memory/debug/agent-memory", async (c) => {
    const db = getDb();
    const agentId = c.req.query("agentId");

    let rows;
    if (agentId) {
      rows = await db`
        SELECT agent_id, key, value, updated_at FROM agent_memory
        WHERE agent_id = ${agentId}
        ORDER BY updated_at DESC
      `;
    } else {
      rows = await db`
        SELECT agent_id, key, value, updated_at FROM agent_memory
        ORDER BY agent_id, updated_at DESC
      `;
    }

    return c.json({
      success: true,
      data: (rows as AgentMemoryRow[]).map((r) => ({
        agentId: r.agent_id,
        key: r.key,
        value: r.value,
        updatedAt: r.updated_at,
      })),
    });
  });

  app.delete("/memory/debug/chunks/:id", async (c) => {
    const db = getDb();
    const chunkId = c.req.param("id");

    const [chunk] = await db`
      SELECT source_id FROM memory_chunks WHERE id = ${chunkId}
    `;
    if (!chunk) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    const sourceId = (chunk as { source_id: string }).source_id;
    await db`DELETE FROM memory_sources WHERE id = ${sourceId}`;
    return c.json({ success: true, deletedSourceId: sourceId });
  });

  return app;
}

/**
 * Routes that require the full memory manager (search, stats-by-agent, deletion).
 */
export function createMemoryRoutes(memoryManager: MemoryManager): Hono {
  const app = new Hono();

  app.get("/memory/stats", async (c) => {
    const stats = await memoryManager.getStats();
    return c.json({ success: true, data: stats });
  });

  app.get("/memory/stats/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const stats = await memoryManager.getStats(agentId);
    return c.json({ success: true, data: stats });
  });

  app.get("/memory/debug/search", async (c) => {
    const query = c.req.query("query");
    const agentId = c.req.query("agentId") ?? "default";
    const limit = Math.min(Number(c.req.query("limit") ?? "10"), 50);

    if (!query || typeof query !== "string") {
      return c.json({ success: false, error: "query parameter is required" }, 400);
    }

    const results = await memoryManager.search(agentId, query, { limit });

    return c.json({
      success: true,
      data: results.map((r) => ({
        score: Math.round(r.score * 10000) / 10000,
        content: r.chunk.content,
        chunkId: r.chunk.id,
        chunkIndex: r.chunk.chunkIndex,
        tokenCount: r.chunk.tokenCount,
        createdAt: r.chunk.createdAt,
        source: {
          id: r.source.id,
          kind: r.source.kind,
          agentId: r.source.agentId,
          channel: r.source.channel,
          createdAt: r.source.createdAt,
        },
      })),
    });
  });

  app.post("/memory/search", async (c) => {
    const body = await c.req.json<{
      query?: string;
      agentId?: string;
      limit?: number;
    }>();

    if (!body.query || typeof body.query !== "string") {
      return c.json({ success: false, error: "query is required" }, 400);
    }

    const agentId = body.agentId ?? "default";
    const results = await memoryManager.search(agentId, body.query, {
      limit: body.limit,
    });

    return c.json({
      success: true,
      data: results.map((r) => ({
        score: r.score,
        content: r.chunk.content,
        chunkIndex: r.chunk.chunkIndex,
        source: {
          id: r.source.id,
          kind: r.source.kind,
          agentId: r.source.agentId,
          channel: r.source.channel,
          chatId: r.source.chatId,
          createdAt: r.source.createdAt,
        },
      })),
    });
  });

  app.delete("/memory/sources/:id", async (c) => {
    const db = getDb();
    const sourceId = c.req.param("id");

    const [existing] =
      await db`SELECT id FROM memory_sources WHERE id = ${sourceId}`;

    if (!existing) {
      return c.json({ success: false, error: "Source not found" }, 404);
    }

    await db`DELETE FROM memory_sources WHERE id = ${sourceId}`;
    return c.json({ success: true });
  });

  return app;
}
