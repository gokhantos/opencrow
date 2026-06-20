/**
 * Isolated tests for createMem0Backend (memory/backend/mem0-backend.ts).
 *
 * Mocks the NARROWEST dependencies only:
 *   - `../../store/db` (getDb): an in-memory stand-in for the `mem0_chunk_map`
 *     table, so the DAL round-trips without Postgres.
 *   - `../../store/config-overrides` (getOverride → null): so the real chunk
 *     profiles + real chunker run (no DB), exercising the shared chunk-builders.
 *
 * The Mem0Client is NOT module-mocked — it is a plain fake object passed straight
 * into the backend config, which is the real injection seam. This keeps the
 * mock surface minimal (per the isolated-lane mock-leak gotcha).
 *
 * Coverage:
 *   - indexNote / indexObservations: write infer:false + enableGraph:false with
 *     correct user_id and reserved metadata; map rows inserted per returned id.
 *   - per-agent vs shared user_id selection.
 *   - search: maps a mem0 hit → SearchResult; applies kinds/channel/minScore net.
 *   - deleteSourceChunks: looks up map rows, deletes each mem0 id, clears rows.
 */

import { mock } from "bun:test";
import { test, expect, describe, beforeEach } from "bun:test";

// ── In-memory mem0_chunk_map ──────────────────────────────────────────────────

interface MapRow {
  source_id: string;
  mem0_id: string;
}
let mapRows: MapRow[] = [];

interface SourceRow {
  id: string;
  kind: string;
  agent_id: string;
}
/** memory_sources INSERTs the backend attempts (bookkeeping for evict/stats). */
let sourceInserts: SourceRow[] = [];
/** memory_sources DELETEs (id) the backend attempts. */
let sourceDeletes: string[] = [];

// ── Stub: store/db ────────────────────────────────────────────────────────────
// Minimal tagged-template that recognizes the mem0_chunk_map + memory_sources
// statements the backend issues.
mock.module("../../store/db", () => {
  function tagFn(strings: TemplateStringsArray, ...vals: unknown[]) {
    const sql = strings.join("?").trim().toLowerCase();

    if (sql.includes("insert into mem0_chunk_map")) {
      const source_id = vals[0] as string;
      const mem0_id = vals[1] as string;
      if (!mapRows.some((r) => r.source_id === source_id && r.mem0_id === mem0_id)) {
        mapRows.push({ source_id, mem0_id });
      }
      return Promise.resolve([]);
    }

    if (sql.includes("select mem0_id from mem0_chunk_map")) {
      const source_id = vals[0] as string;
      return Promise.resolve(
        mapRows
          .filter((r) => r.source_id === source_id)
          .map((r) => ({ mem0_id: r.mem0_id })),
      );
    }

    if (sql.includes("delete from mem0_chunk_map")) {
      const source_id = vals[0] as string;
      mapRows = mapRows.filter((r) => r.source_id !== source_id);
      return Promise.resolve([]);
    }

    if (sql.includes("insert into memory_sources")) {
      // VALUES (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
      sourceInserts.push({
        id: vals[0] as string,
        kind: vals[1] as string,
        agent_id: vals[2] as string,
      });
      return Promise.resolve([]);
    }

    if (sql.includes("delete from memory_sources")) {
      sourceDeletes.push(vals[0] as string);
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  }
  return { getDb: () => tagFn };
});

// ── Stub: config-overrides (no DB; real chunk profiles apply) ─────────────────
mock.module("../../store/config-overrides", () => ({
  getOverride: async () => null,
}));

// Import AFTER mock.module calls.
import { createMem0Backend } from "./mem0-backend";
import type { Mem0Client } from "../../sige/knowledge/mem0-client";
import type {
  Mem0AddResult,
  Mem0Memory,
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

function makeFakeClient(opts?: {
  searchHits?: readonly Mem0Memory[];
}): {
  client: Mem0Client;
  addCalls: AddCall[];
  deleteCalls: string[];
  searchCalls: unknown[];
} {
  const addCalls: AddCall[] = [];
  const deleteCalls: string[] = [];
  const searchCalls: unknown[] = [];
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
    async search(params: unknown): Promise<Mem0SearchResult> {
      searchCalls.push(params);
      return { memories: opts?.searchHits ?? [], relations: [] };
    },
    async deleteMemory(id: string): Promise<void> {
      deleteCalls.push(id);
    },
  } as unknown as Mem0Client;

  return { client, addCalls, deleteCalls, searchCalls };
}

const SHARED_USER = "opencrow-shared";

/** Poll `cond` until true or the timeout elapses (for fire-and-forget paths). */
async function waitFor(
  cond: () => boolean,
  timeoutMs = 1000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeEach(() => {
  mapRows = [];
  sourceInserts = [];
  sourceDeletes = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createMem0Backend — writes", () => {
  test("indexNote writes infer:false + enableGraph:false with shared user_id and metadata, records map rows", async () => {
    const { client, addCalls } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const longNote =
      "This is a sufficiently long note about distributed systems. " +
      "It discusses consensus, replication, and fault tolerance in depth.";
    const sourceId = await backend.indexNote("agent-1", longNote, {
      topic: "infra",
    });

    expect(sourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(addCalls.length).toBeGreaterThan(0);

    const first = addCalls[0]!;
    expect(first.infer).toBe(false);
    expect(first.enableGraph).toBe(false);
    expect(first.userId).toBe(SHARED_USER);
    expect(first.metadata?.source_type).toBe("note");
    expect(first.metadata?.source_id).toBe(sourceId);
    expect(first.metadata?.agent_id).toBe("agent-1");
    expect(first.metadata?.chunk_index).toBe(0);
    expect(typeof first.metadata?.created_at).toBe("number");
    // Caller metadata passthrough preserved.
    expect(first.metadata?.topic).toBe("infra");

    // One map row per returned mem0 id.
    expect(mapRows.length).toBe(addCalls.length);
    expect(mapRows.every((r) => r.source_id === sourceId)).toBe(true);

    // A memory_sources bookkeeping row is inserted with the SAME sourceId, the
    // group kind, and agent_id — so evict()/getStats() can find this source.
    expect(sourceInserts.length).toBe(1);
    expect(sourceInserts[0]).toEqual({
      id: sourceId,
      kind: "note",
      agent_id: "agent-1",
    });
  });

  test("does not insert a memory_sources row when there are no chunks", async () => {
    const { client, addCalls } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    // Empty content → no chunks → no mem0 writes and no orphan source row.
    const sourceId = await backend.indexNote("agent-1", "");
    expect(typeof sourceId).toBe("string");
    expect(addCalls.length).toBe(0);
    expect(sourceInserts).toEqual([]);
  });

  test("per-agent mode uses agentId as user_id (not the shared id)", async () => {
    const { client, addCalls } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: false,
    });

    await backend.indexObservations("agent-xyz", [
      {
        id: "o1",
        observationType: "insight",
        title: "Observation title here",
        summary: "A reasonably long summary of the observation for chunking.",
        facts: ["fact one is here", "fact two is here"],
        concepts: ["alpha", "beta"],
      },
    ]);

    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls.every((c) => c.userId === "agent-xyz")).toBe(true);
    expect(addCalls[0]!.metadata?.source_type).toBe("observation");
  });
});

describe("createMem0Backend — search", () => {
  // Shape hits like the REAL self-hosted mem0 server: it PROMOTES `agent_id`
  // (and `created_at`, as an ISO string) to TOP-LEVEL fields and STRIPS them
  // from `metadata`. Only source_type/source_id/chunk_index/channel survive in
  // metadata. This is the exact shape that exposed the Phase 2 mapping bug.
  function hit(
    id: string,
    overrides: Partial<Mem0Memory> & {
      metadata?: Record<string, unknown>;
    },
  ): Mem0Memory {
    return {
      id,
      memory: overrides.memory ?? "some content",
      score: overrides.score ?? 0.9,
      // Server-promoted top-level fields (NOT in metadata).
      agentId: "agentId" in overrides ? overrides.agentId : "agent-1",
      createdAt:
        "createdAt" in overrides
          ? overrides.createdAt
          : "2023-11-14T22:13:20.000Z", // == epoch 1_700_000_000
      metadata: {
        source_type: "note",
        source_id: "src-1",
        chunk_index: 0,
        ...overrides.metadata,
      },
    };
  }

  test("maps a server-shaped mem0 hit (agent_id + created_at TOP-LEVEL) to a SearchResult", async () => {
    const { client } = makeFakeClient({
      searchHits: [hit("mem-a", { memory: "hello world", score: 0.8 })],
    });
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const results = await backend.search("agent-1", "hello", { minScore: 0.3 });
    // Regression: pre-fix, the hit was DROPPED (mapper required agent_id INSIDE
    // metadata) → search returned []. It must now map and return non-empty.
    expect(results.length).toBe(1);
    expect(results[0]!.chunk.content).toBe("hello world");
    expect(results[0]!.source.kind).toBe("note");
    expect(results[0]!.source.id).toBe("src-1");
    expect(results[0]!.score).toBe(0.8);
    // agent_id reconstructed from the promoted TOP-LEVEL field.
    expect(results[0]!.source.agentId).toBe("agent-1");
    // created_at reconstructed from the promoted ISO string → epoch seconds.
    expect(results[0]!.source.createdAt).toBe(1_700_000_000);
    expect(results[0]!.chunk.createdAt).toBe(1_700_000_000);
  });

  test("maps a hit whose agent_id is ONLY top-level (not in metadata)", async () => {
    const { client } = makeFakeClient({
      searchHits: [
        // No agent_id anywhere in metadata — only the promoted top-level field.
        hit("only-top", { memory: "top-level only", score: 0.7 }),
      ],
    });
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const results = await backend.search("agent-1", "q", { minScore: 0.3 });
    expect(results.length).toBe(1);
    expect(results[0]!.source.agentId).toBe("agent-1");
  });

  test("falls back to metadata agent_id when top-level is absent (forward-compat)", async () => {
    const { client } = makeFakeClient({
      searchHits: [
        // Older server shape: agent_id kept in metadata, no top-level promotion.
        hit("meta-only", {
          memory: "metadata agent_id",
          score: 0.7,
          agentId: undefined,
          metadata: { agent_id: "agent-1" },
        }),
      ],
    });
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const results = await backend.search("agent-1", "q", { minScore: 0.3 });
    expect(results.length).toBe(1);
    expect(results[0]!.source.agentId).toBe("agent-1");
  });

  test("drops a hit whose agent_id is absent in BOTH top-level and metadata", async () => {
    const { client } = makeFakeClient({
      searchHits: [
        hit("no-agent", {
          memory: "no agent id anywhere",
          score: 0.9,
          agentId: undefined, // no top-level
          // and no metadata.agent_id
        }),
      ],
    });
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const results = await backend.search("agent-1", "q", { minScore: 0.3 });
    expect(results).toEqual([]);
  });

  test("applies kinds, minScore, and conversation channel filtering client-side", async () => {
    const { client } = makeFakeClient({
      searchHits: [
        hit("keep", {
          memory: "kept note",
          score: 0.9,
          metadata: { source_type: "note" },
        }),
        hit("wrong-kind", {
          memory: "an idea",
          score: 0.9,
          metadata: { source_type: "idea", source_id: "src-2" },
        }),
        hit("low-score", {
          memory: "low score note",
          score: 0.1,
          metadata: { source_type: "note", source_id: "src-3" },
        }),
        hit("other-channel", {
          memory: "convo from another channel",
          score: 0.9,
          metadata: {
            source_type: "conversation",
            source_id: "src-4",
            channel: "telegram",
          },
        }),
      ],
    });
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const results = await backend.search("agent-1", "q", {
      kinds: ["note", "conversation"],
      minScore: 0.3,
      channel: "whatsapp",
    });

    // wrong-kind (idea), low-score (<0.3), and other-channel (telegram≠whatsapp)
    // are all filtered; only the "keep" note survives.
    expect(results.map((r) => r.chunk.id)).toEqual(["keep"]);
  });

  test("per-agent search scopes by user_id and does NOT send a redundant agent_id filter", async () => {
    const { client, searchCalls } = makeFakeClient({
      searchHits: [hit("mem-a", { memory: "scoped hit", score: 0.8 })],
    });
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: false, // per-agent mode
    });

    const results = await backend.search("agent-1", "q", { minScore: 0.3 });
    expect(results.length).toBe(1);

    // Isolation is via user_id (== agentId in per-agent mode), NOT a metadata
    // agent_id filter — the server promotes agent_id out of metadata, so that
    // filter is version-fragile and redundant. It must not be sent.
    expect(searchCalls.length).toBe(1);
    const call = searchCalls[0] as {
      userId: string;
      filters?: Record<string, unknown>;
    };
    expect(call.userId).toBe("agent-1");
    expect(call.filters?.agent_id).toBeUndefined();
  });

  test("degrades to no results when the client search throws", async () => {
    const client = {
      async search() {
        throw new Error("mem0 unavailable (circuit breaker open)");
      },
    } as unknown as Mem0Client;
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });
    const results = await backend.search("agent-1", "q");
    expect(results).toEqual([]);
  });
});

describe("createMem0Backend — delete by source", () => {
  test("deleteSourceChunks looks up map rows, deletes each mem0 id, then clears rows", async () => {
    const { client, deleteCalls } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const note =
      "A long enough note to produce at least one chunk for deletion testing. " +
      "Adding a second sentence so the chunker has material to work with here.";
    const sourceId = await backend.indexNote("agent-1", note);

    const writtenIds = mapRows
      .filter((r) => r.source_id === sourceId)
      .map((r) => r.mem0_id);
    expect(writtenIds.length).toBeGreaterThan(0);

    await backend.deleteSourceChunks(sourceId);

    // Every recorded mem0 id was deleted, and the map rows are gone.
    expect(deleteCalls.sort()).toEqual([...writtenIds].sort());
    expect(mapRows.filter((r) => r.source_id === sourceId)).toEqual([]);
    // Caller-driven delete also removes the memory_sources row (Qdrant parity).
    expect(sourceDeletes).toEqual([sourceId]);
  });

  test("deleteSourceVectors (eviction path) clears mem0 + map but NOT the source row", async () => {
    const { client, deleteCalls } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: SHARED_USER,
      shared: true,
    });

    const note =
      "A long enough note to produce at least one chunk for eviction testing. " +
      "Adding a second sentence so the chunker has material to work with here.";
    const sourceId = await backend.indexNote("agent-1", note);
    const writtenIds = mapRows
      .filter((r) => r.source_id === sourceId)
      .map((r) => r.mem0_id);

    await backend.deleteSourceVectors([sourceId]);
    // deleteSourceVectors is intentionally fire-and-forget (best-effort, never
    // throws into eviction), so wait for the per-source deletes to settle.
    await waitFor(
      () => mapRows.filter((r) => r.source_id === sourceId).length === 0,
    );

    expect(deleteCalls.sort()).toEqual([...writtenIds].sort());
    expect(mapRows.filter((r) => r.source_id === sourceId)).toEqual([]);
    // The manager already deleted memory_sources; the backend must NOT re-delete.
    expect(sourceDeletes).toEqual([]);
  });
});
