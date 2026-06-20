/**
 * Isolated tests for the mem0 backfill (memory/mem0-backfill/backfill.ts).
 *
 * Mocks the NARROWEST dependency only: `../../store/db` (getDb) is an in-memory
 * stand-in over `memory_sources`, `memory_chunks`, and `mem0_chunk_map`, so the
 * read/write SQL round-trips without Postgres. The Mem0Client is NOT
 * module-mocked — it is a plain fake passed straight into `runBackfill`, the real
 * injection seam. This keeps the mock surface minimal (per the isolated-lane
 * mock-leak gotcha: mock the narrowest dependency).
 *
 * Coverage:
 *   - a source with N chunks → N addMemory calls (infer:false, enableGraph:false)
 *     with the correct user_id + reserved metadata + PRESERVED source_id, and N
 *     mem0_chunk_map inserts.
 *   - idempotency: a source already in mem0_chunk_map is skipped (no writes).
 *   - scoping: shared mode → sharedUserId; per-agent mode → agent_id.
 *   - dry-run: counts but writes nothing (no addMemory, no map inserts).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory tables ──────────────────────────────────────────────────────────

interface SourceRec {
  id: string;
  kind: string;
  agent_id: string;
  channel: string | null;
  chat_id: string | null;
  metadata_json: string;
  created_at: number;
}
interface ChunkRec {
  source_id: string;
  content: string;
  chunk_index: number;
}
interface MapRec {
  source_id: string;
  mem0_id: string;
}

let sources: SourceRec[] = [];
let chunks: ChunkRec[] = [];
let mapRows: MapRec[] = [];

// ── Stub: store/db ────────────────────────────────────────────────────────────
// A minimal tagged-template recognizing exactly the statements the backfill DAL +
// mem0-chunk-map DAL issue. Returns rows shaped like Postgres would.
mock.module("../../store/db", () => {
  function tagFn(strings: TemplateStringsArray, ...vals: unknown[]) {
    const sql = strings.join("?").trim().toLowerCase();

    // countSources
    if (sql.includes("count(*)::int as n") && sql.includes("from memory_sources")) {
      return Promise.resolve([{ n: sources.length }]);
    }

    // readSourcesPage: SELECT ... FROM memory_sources ... ORDER BY ... LIMIT ? OFFSET ?
    if (sql.includes("from memory_sources") && sql.includes("order by created_at")) {
      // vals tail: [..., limit, offset]. Apply deterministic order then page.
      const offset = Number(vals[vals.length - 1]);
      const limit = Number(vals[vals.length - 2]);
      const ordered = [...sources].sort((a, b) =>
        a.created_at !== b.created_at
          ? a.created_at - b.created_at
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );
      return Promise.resolve(ordered.slice(offset, offset + limit));
    }

    // readChunks
    if (sql.includes("from memory_chunks") && sql.includes("order by chunk_index")) {
      const sourceId = vals[0] as string;
      const rows = chunks
        .filter((c) => c.source_id === sourceId)
        .sort((a, b) => a.chunk_index - b.chunk_index)
        .map((c) => ({ content: c.content, chunk_index: c.chunk_index }));
      return Promise.resolve(rows);
    }

    // isAlreadyBackfilled: SELECT 1 FROM mem0_chunk_map WHERE source_id = ? LIMIT 1
    if (sql.includes("select 1 from mem0_chunk_map")) {
      const sourceId = vals[0] as string;
      const hit = mapRows.some((r) => r.source_id === sourceId);
      return Promise.resolve(hit ? [{ "?column?": 1 }] : []);
    }

    // recordMem0Ids: INSERT INTO mem0_chunk_map (...) VALUES (?, ?) ON CONFLICT ...
    if (sql.includes("insert into mem0_chunk_map")) {
      const source_id = vals[0] as string;
      const mem0_id = vals[1] as string;
      if (!mapRows.some((r) => r.source_id === source_id && r.mem0_id === mem0_id)) {
        mapRows.push({ source_id, mem0_id });
      }
      return Promise.resolve([]);
    }

    throw new Error(`Unexpected SQL in backfill test stub: ${sql}`);
  }
  return { getDb: () => tagFn };
});

// Import AFTER mock.module.
import { runBackfill } from "./backfill";
import { getDb } from "../../store/db";
import type {
  Mem0AddResult,
  Mem0Client,
  Mem0SearchResult,
} from "../../sige/knowledge/mem0-client";

// ── Fake Mem0Client (injected directly) ───────────────────────────────────────

interface AddCall {
  content: string;
  userId: string;
  infer?: boolean;
  enableGraph?: boolean;
  metadata?: Record<string, unknown>;
}

function makeFakeClient(): { client: Mem0Client; addCalls: AddCall[] } {
  const addCalls: AddCall[] = [];
  let counter = 0;
  const client = {
    async addMemory(params: AddCall): Promise<Mem0AddResult> {
      addCalls.push(params);
      counter += 1;
      return {
        memories: [{ id: `mem-${counter}`, memory: params.content }],
        relations: [],
      };
    },
    async search(): Promise<Mem0SearchResult> {
      return { memories: [], relations: [] };
    },
    async deleteMemory(): Promise<void> {},
  } as unknown as Mem0Client;
  return { client, addCalls };
}

// The mocked getDb() returns the in-memory tagged-template; pass it as the db
// handle into runBackfill (the real injection seam).
const db = getDb();

const SHARED_USER = "opencrow-shared";

function seedSource(rec: Partial<SourceRec> & { id: string }): void {
  sources.push({
    kind: "note",
    agent_id: "agent-1",
    channel: null,
    chat_id: null,
    metadata_json: "{}",
    created_at: 1_700_000_000,
    ...rec,
  });
}

beforeEach(() => {
  sources = [];
  chunks = [];
  mapRows = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runBackfill — write path", () => {
  test("a source with N chunks → N addMemory calls with correct metadata + N map rows", async () => {
    seedSource({
      id: "11111111-1111-1111-1111-111111111111",
      kind: "reddit_post",
      agent_id: "agent-x",
      metadata_json: JSON.stringify({ topic: "infra", postId: "abc" }),
      created_at: 1_700_000_100,
    });
    chunks.push(
      { source_id: "11111111-1111-1111-1111-111111111111", content: "chunk zero text", chunk_index: 0 },
      { source_id: "11111111-1111-1111-1111-111111111111", content: "chunk one text", chunk_index: 1 },
      { source_id: "11111111-1111-1111-1111-111111111111", content: "chunk two text", chunk_index: 2 },
    );

    const { client, addCalls } = makeFakeClient();
    const result = await runBackfill(db, client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      batchSize: 10,
      concurrency: 3,
      dryRun: false,
    });

    expect(addCalls.length).toBe(3);
    for (const c of addCalls) {
      expect(c.infer).toBe(false);
      expect(c.enableGraph).toBe(false);
      expect(c.userId).toBe(SHARED_USER);
      // Reserved metadata: PRESERVED original source_id + kind + agent_id.
      expect(c.metadata?.source_id).toBe("11111111-1111-1111-1111-111111111111");
      expect(c.metadata?.source_type).toBe("reddit_post");
      expect(c.metadata?.agent_id).toBe("agent-x");
      expect(c.metadata?.created_at).toBe(1_700_000_100);
      // Caller metadata passthrough preserved (reserved keys win on collision).
      expect(c.metadata?.topic).toBe("infra");
      expect(c.metadata?.postId).toBe("abc");
    }
    // chunk_index preserved per chunk.
    expect(addCalls.map((c) => c.metadata?.chunk_index)).toEqual([0, 1, 2]);

    // One map row per returned mem0 id, keyed by the ORIGINAL source id.
    expect(mapRows.length).toBe(3);
    expect(mapRows.every((r) => r.source_id === "11111111-1111-1111-1111-111111111111")).toBe(true);

    expect(result).toEqual({
      processed: 1,
      written: 1,
      skipped: 0,
      empty: 0,
      memories: 3,
    });
  });

  test("a source with zero chunks is counted empty and writes nothing", async () => {
    seedSource({ id: "22222222-2222-2222-2222-222222222222" });
    const { client, addCalls } = makeFakeClient();

    const result = await runBackfill(db, client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      batchSize: 10,
      concurrency: 3,
      dryRun: false,
    });

    expect(addCalls.length).toBe(0);
    expect(mapRows.length).toBe(0);
    expect(result.empty).toBe(1);
    expect(result.written).toBe(0);
  });
});

describe("runBackfill — idempotency", () => {
  test("a source already in mem0_chunk_map is skipped (no writes)", async () => {
    seedSource({ id: "33333333-3333-3333-3333-333333333333" });
    chunks.push({
      source_id: "33333333-3333-3333-3333-333333333333",
      content: "already done",
      chunk_index: 0,
    });
    // Pre-existing map row marks this source as already backfilled.
    mapRows.push({ source_id: "33333333-3333-3333-3333-333333333333", mem0_id: "prev-1" });

    const { client, addCalls } = makeFakeClient();
    const result = await runBackfill(db, client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      batchSize: 10,
      concurrency: 3,
      dryRun: false,
    });

    expect(addCalls.length).toBe(0);
    // The pre-existing row is untouched; no new rows added.
    expect(mapRows).toEqual([
      { source_id: "33333333-3333-3333-3333-333333333333", mem0_id: "prev-1" },
    ]);
    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
  });
});

describe("runBackfill — scoping", () => {
  test("per-agent mode uses the source's agent_id as user_id (not the shared id)", async () => {
    seedSource({
      id: "44444444-4444-4444-4444-444444444444",
      agent_id: "agent-zeta",
    });
    chunks.push({
      source_id: "44444444-4444-4444-4444-444444444444",
      content: "per-agent chunk",
      chunk_index: 0,
    });

    const { client, addCalls } = makeFakeClient();
    await runBackfill(db, client, {
      scoping: { shared: false, sharedUserId: SHARED_USER },
      batchSize: 10,
      concurrency: 3,
      dryRun: false,
    });

    expect(addCalls.length).toBe(1);
    expect(addCalls[0]!.userId).toBe("agent-zeta");
  });

  test("shared mode routes every source's user_id to the shared pool", async () => {
    seedSource({ id: "55555555-5555-5555-5555-555555555555", agent_id: "agent-a" });
    seedSource({ id: "66666666-6666-6666-6666-666666666666", agent_id: "agent-b" });
    chunks.push(
      { source_id: "55555555-5555-5555-5555-555555555555", content: "c1", chunk_index: 0 },
      { source_id: "66666666-6666-6666-6666-666666666666", content: "c2", chunk_index: 0 },
    );

    const { client, addCalls } = makeFakeClient();
    await runBackfill(db, client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      batchSize: 10,
      concurrency: 3,
      dryRun: false,
    });

    expect(addCalls.length).toBe(2);
    expect(addCalls.every((c) => c.userId === SHARED_USER)).toBe(true);
  });
});

describe("runBackfill — dry-run", () => {
  test("dry-run counts what would be written but writes nothing", async () => {
    seedSource({ id: "77777777-7777-7777-7777-777777777777" });
    chunks.push(
      { source_id: "77777777-7777-7777-7777-777777777777", content: "a", chunk_index: 0 },
      { source_id: "77777777-7777-7777-7777-777777777777", content: "b", chunk_index: 1 },
    );

    const { client, addCalls } = makeFakeClient();
    const result = await runBackfill(db, client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      batchSize: 10,
      concurrency: 3,
      dryRun: true,
    });

    // No mem0 writes, no map inserts.
    expect(addCalls.length).toBe(0);
    expect(mapRows.length).toBe(0);
    // But it reports the source + chunk counts it WOULD have written.
    expect(result.written).toBe(1);
    expect(result.memories).toBe(2);
  });
});

describe("runBackfill — limit", () => {
  test("--limit stops after N sources", async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = `8888888${i}-8888-8888-8888-888888888888`;
      seedSource({ id, created_at: 1_700_000_000 + i });
      chunks.push({ source_id: id, content: `chunk ${i}`, chunk_index: 0 });
    }

    const { client, addCalls } = makeFakeClient();
    const result = await runBackfill(db, client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      batchSize: 2,
      concurrency: 2,
      dryRun: false,
      limit: 3,
    });

    expect(result.processed).toBe(3);
    expect(addCalls.length).toBe(3);
  });
});
