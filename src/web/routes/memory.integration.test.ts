/**
 * Integration tests for the memory debug HTTP routes.
 *
 * Tests only `createMemoryDebugRoutes()` — the debug-only half that works without
 * a vector MemoryManager, hitting only PostgreSQL.
 *
 * Key contracts:
 * - GET /memory/debug/stats — returns aggregate counts from memory_sources/chunks
 * - GET /memory/debug/chunks — lists chunks with optional agentId filter
 * - GET /memory/debug/agent-memory — lists agent_memory rows
 * - DELETE /memory/debug/chunks/:id — deletes chunk and its parent source; 404 on unknown
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createMemoryDebugRoutes } from "./memory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  return createMemoryDebugRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

async function del(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "DELETE" })));
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = "route-test-memory-agent";
let insertedSourceId: string | null = null;

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
});

afterEach(async () => {
  const db = getDb();
  // Clean up any test data we inserted
  if (insertedSourceId) {
    await db.unsafe(`DELETE FROM memory_sources WHERE id = '${insertedSourceId}'`);
    insertedSourceId = null;
    // chunk is deleted with source via cascade
  }
  await db.unsafe(`DELETE FROM agent_memory WHERE agent_id = '${TEST_AGENT_ID}'`);
  await closeDb();
});

// Helper: insert a test memory source + chunk directly so the debug routes
// have something to return.
async function seedMemoryData(): Promise<{ sourceId: string; chunkId: string }> {
  const db = getDb();
  const sourceId = `route-test-src-${Date.now()}`;
  const chunkId = `route-test-chunk-${Date.now()}`;

  await db.unsafe(`
    INSERT INTO memory_sources (id, kind, agent_id, channel, metadata_json, created_at)
    VALUES ('${sourceId}', 'conversation', '${TEST_AGENT_ID}', null, '{}',
            extract(epoch from now())::bigint)
    ON CONFLICT DO NOTHING
  `);

  await db.unsafe(`
    INSERT INTO memory_chunks (id, source_id, content, chunk_index, token_count, created_at)
    VALUES ('${chunkId}', '${sourceId}', 'hello world test content', 0, 3,
            extract(epoch from now())::bigint)
    ON CONFLICT DO NOTHING
  `);

  insertedSourceId = sourceId;
  return { sourceId, chunkId };
}

// ---------------------------------------------------------------------------
// GET /memory/debug/stats
// ---------------------------------------------------------------------------

describe("GET /memory/debug/stats", () => {
  it("200 + stats object with correct shape", async () => {
    const app = makeApp();
    const res = await get(app, "/memory/debug/stats");

    expect(res.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: {
        totalSources: number;
        totalChunks: number;
        totalTokens: number;
        agentsWithMemory: number;
        byKind: Array<{ kind: string; count: number }>;
        byAgent: Array<{ agentId: string; chunkCount: number; sourceCount: number }>;
      };
    }>(res);
    expect(body.success).toBe(true);
    expect(typeof body.data.totalSources).toBe("number");
    expect(typeof body.data.totalChunks).toBe("number");
    expect(typeof body.data.totalTokens).toBe("number");
    expect(typeof body.data.agentsWithMemory).toBe("number");
    expect(Array.isArray(body.data.byKind)).toBe(true);
    expect(Array.isArray(body.data.byAgent)).toBe(true);
  });

  it("totalChunks increases after seeding data", async () => {
    const app = makeApp();

    const before = await get(app, "/memory/debug/stats");
    const beforeBody = await json<{ data: { totalChunks: number } }>(before);
    const countBefore = beforeBody.data.totalChunks;

    await seedMemoryData();

    const after = await get(app, "/memory/debug/stats");
    const afterBody = await json<{ data: { totalChunks: number } }>(after);
    expect(afterBody.data.totalChunks).toBeGreaterThan(countBefore);
  });
});

// ---------------------------------------------------------------------------
// GET /memory/debug/chunks
// ---------------------------------------------------------------------------

describe("GET /memory/debug/chunks", () => {
  it("200 + array (may be empty on fresh DB)", async () => {
    const app = makeApp();
    const res = await get(app, "/memory/debug/chunks");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns seeded chunk with correct fields", async () => {
    const { chunkId } = await seedMemoryData();
    const app = makeApp();

    const res = await get(app, `/memory/debug/chunks?agentId=${TEST_AGENT_ID}`);
    expect(res.status).toBe(200);

    const body = await json<{
      data: Array<{
        id: string;
        content: string;
        agentId: string;
        kind: string;
        tokenCount: number;
      }>;
    }>(res);
    const chunk = body.data.find((c) => c.id === chunkId);
    expect(chunk).toBeDefined();
    expect(chunk!.agentId).toBe(TEST_AGENT_ID);
    expect(chunk!.content).toBe("hello world test content");
    expect(chunk!.tokenCount).toBe(3);
    expect(chunk!.kind).toBe("conversation");
  });

  it("filters by agentId — returns only matching chunks", async () => {
    await seedMemoryData();
    const app = makeApp();

    const res = await get(app, "/memory/debug/chunks?agentId=definitely-no-such-agent");
    expect(res.status).toBe(200);

    const body = await json<{ data: Array<{ agentId: string }> }>(res);
    for (const chunk of body.data) {
      expect(chunk.agentId).toBe("definitely-no-such-agent");
    }
  });

  it("respects limit query param", async () => {
    const app = makeApp();
    const res = await get(app, "/memory/debug/chunks?limit=1");

    expect(res.status).toBe(200);
    const body = await json<{ data: unknown[] }>(res);
    expect(body.data.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// GET /memory/debug/agent-memory
// ---------------------------------------------------------------------------

describe("GET /memory/debug/agent-memory", () => {
  it("200 + array", async () => {
    const app = makeApp();
    const res = await get(app, "/memory/debug/agent-memory");

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[] }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("filters by agentId query param", async () => {
    // Seed an agent_memory row
    const db = getDb();
    await db.unsafe(`
      INSERT INTO agent_memory (agent_id, key, value, updated_at)
      VALUES ('${TEST_AGENT_ID}', 'test-key', 'test-value',
              extract(epoch from now())::bigint)
      ON CONFLICT (agent_id, key) DO UPDATE SET value = EXCLUDED.value
    `);

    const app = makeApp();
    const res = await get(app, `/memory/debug/agent-memory?agentId=${TEST_AGENT_ID}`);
    expect(res.status).toBe(200);

    const body = await json<{
      data: Array<{ agentId: string; key: string; value: string }>;
    }>(res);
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row.agentId).toBe(TEST_AGENT_ID);
    }
    const entry = body.data.find((r) => r.key === "test-key");
    expect(entry?.value).toBe("test-value");
  });
});

// ---------------------------------------------------------------------------
// DELETE /memory/debug/chunks/:id
// ---------------------------------------------------------------------------

describe("DELETE /memory/debug/chunks/:id", () => {
  it("200 + deletedSourceId on known chunk", async () => {
    const { chunkId, sourceId } = await seedMemoryData();
    const app = makeApp();

    const res = await del(app, `/memory/debug/chunks/${chunkId}`);
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; deletedSourceId: string }>(res);
    expect(body.success).toBe(true);
    expect(body.deletedSourceId).toBe(sourceId);

    // Mark as cleaned up so afterEach doesn't try to delete again
    insertedSourceId = null;
    // chunk is deleted with source via cascade
  });

  it("404 for unknown chunk id", async () => {
    const app = makeApp();
    const res = await del(app, "/memory/debug/chunks/no-such-chunk-id");

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });
});
