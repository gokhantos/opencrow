/**
 * Integration tests for the mem0 backend's Postgres DAL (`mem0_chunk_map`,
 * migration 029) against a REAL database.
 *
 * The Mem0Client HTTP is faked (a live sidecar isn't guaranteed in CI), so this
 * isolates the `(source_id, mem0_id)` map round-trip: a backend index() inserts
 * rows, and deleteSourceChunks() looks them up and clears them. Only the DAL +
 * SQL hit Postgres; the mem0 calls are in-process.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import {
  deleteMem0Map,
  getMem0Ids,
  recordMem0Ids,
} from "./mem0-chunk-map";
import { createMem0Backend } from "./mem0-backend";
import { createMemoryManager } from "../manager";
import type {
  Mem0AddResult,
  Mem0Client,
  Mem0SearchResult,
} from "../../sige/knowledge/mem0-client";

const TEST_SOURCE_PREFIX = "itest-mem0-";
/** Unique agent id so getStats()/evict() scope to this test's rows only. */
const TEST_AGENT = "itest-mem0-agent";

function makeFakeClient(): {
  client: Mem0Client;
  deleteCalls: string[];
} {
  const deleteCalls: string[] = [];
  let counter = 0;
  const client = {
    async addMemory(params: {
      content: string;
    }): Promise<Mem0AddResult> {
      counter += 1;
      return {
        memories: [{ id: `${TEST_SOURCE_PREFIX}mem-${counter}`, memory: params.content }],
        relations: [],
      };
    },
    async search(): Promise<Mem0SearchResult> {
      return { memories: [], relations: [] };
    },
    async deleteMemory(id: string): Promise<void> {
      deleteCalls.push(id);
    },
  } as unknown as Mem0Client;
  return { client, deleteCalls };
}

/** Poll `cond` until true or the timeout elapses (for fire-and-forget paths). */
async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 2000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function makeManager(client: Mem0Client) {
  return createMemoryManager({
    embeddingProvider: null,
    qdrantClient: null,
    qdrantCollection: "unused-in-mem0-path",
    backend: "mem0",
    mem0Client: client,
    mem0SharedUserId: "opencrow-shared",
    // Per-agent scoping so the bookkeeping rows carry TEST_AGENT.
    shared: false,
  });
}

async function cleanup(): Promise<void> {
  const db = getDb();
  // Map rows are keyed by mem0_id prefix or by the per-agent source rows; clear
  // both the explicit-prefix rows and everything tied to the test agent.
  await db`
    DELETE FROM mem0_chunk_map
    WHERE source_id LIKE ${`${TEST_SOURCE_PREFIX}%`}
       OR source_id IN (SELECT id FROM memory_sources WHERE agent_id = ${TEST_AGENT})
  `;
  await db`DELETE FROM memory_sources WHERE agent_id = ${TEST_AGENT}`;
}

describe("mem0_chunk_map DAL", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("records, looks up, and deletes mem0 ids for a source", async () => {
    const db = getDb();
    const sourceId = `${TEST_SOURCE_PREFIX}src-1`;
    const ids = [
      `${TEST_SOURCE_PREFIX}a`,
      `${TEST_SOURCE_PREFIX}b`,
      `${TEST_SOURCE_PREFIX}c`,
    ];

    await recordMem0Ids(db, sourceId, ids);
    const looked = await getMem0Ids(db, sourceId);
    expect([...looked].sort()).toEqual([...ids].sort());

    await deleteMem0Map(db, sourceId);
    expect(await getMem0Ids(db, sourceId)).toEqual([]);
  });

  it("recordMem0Ids is idempotent on the (source_id, mem0_id) primary key", async () => {
    const db = getDb();
    const sourceId = `${TEST_SOURCE_PREFIX}src-2`;
    await recordMem0Ids(db, sourceId, [`${TEST_SOURCE_PREFIX}x`]);
    // Re-inserting the same pair must not throw (ON CONFLICT DO NOTHING).
    await recordMem0Ids(db, sourceId, [`${TEST_SOURCE_PREFIX}x`]);
    const looked = await getMem0Ids(db, sourceId);
    expect(looked).toEqual([`${TEST_SOURCE_PREFIX}x`]);
  });

  it("backend index() inserts map rows and deleteSourceChunks clears them", async () => {
    const { client, deleteCalls } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: "opencrow-shared",
      shared: true,
    });

    const note =
      "An integration note long enough to chunk. It has two sentences so the " +
      "chunker produces at least one chunk and the DAL records a mem0 id row.";
    const sourceId = await backend.indexNote("itest-agent", note);

    const db = getDb();
    const written = await getMem0Ids(db, sourceId);
    expect(written.length).toBeGreaterThan(0);

    // Re-prefix the source row so cleanup() removes it (indexNote returns a UUID).
    // Instead, assert + delete directly here to avoid leaking the UUID-keyed row.
    await backend.deleteSourceChunks(sourceId);
    expect(deleteCalls.sort()).toEqual([...written].sort());
    expect(await getMem0Ids(db, sourceId)).toEqual([]);
  });

  it("index writes a memory_sources bookkeeping row keyed by the same sourceId", async () => {
    const { client } = makeFakeClient();
    const backend = createMem0Backend({
      mem0Client: client,
      sharedUserId: "opencrow-shared",
      shared: false,
    });

    const note =
      "A bookkeeping note long enough to chunk. Two sentences so the chunker " +
      "produces a chunk and the backend records a memory_sources row.";
    const sourceId = await backend.indexNote(TEST_AGENT, note);

    const db = getDb();
    const rows = (await db`
      SELECT id, kind, agent_id FROM memory_sources WHERE id = ${sourceId}
    `) as { id: string; kind: string; agent_id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      id: sourceId,
      kind: "note",
      agent_id: TEST_AGENT,
    });

    // Map rows + source row share the same sourceId (eviction lines up).
    const mapped = await getMem0Ids(db, sourceId);
    expect(mapped.length).toBeGreaterThan(0);
  });

  it("getStats counts mem0-backed sources for the agent", async () => {
    const { client } = makeFakeClient();
    const manager = makeManager(client);

    await manager.indexObservations(TEST_AGENT, [
      {
        id: "o-stats-1",
        observationType: "insight",
        title: "An observation title for stats",
        summary: "A reasonably long observation summary so it chunks cleanly.",
        facts: ["fact one here", "fact two here"],
        concepts: ["alpha", "beta"],
      },
    ]);
    await manager.indexObservations(TEST_AGENT, [
      {
        id: "o-stats-2",
        observationType: "insight",
        title: "A second observation title for stats",
        summary: "Another reasonably long observation summary so it chunks well.",
        facts: ["fact three here"],
        concepts: ["gamma"],
      },
    ]);

    const stats = await manager.getStats(TEST_AGENT);
    // Two index calls → two memory_sources rows for this agent. No memory_chunks
    // rows in the mem0 path, so chunkCount stays 0 (LEFT JOIN tolerates this).
    expect(stats.sourceCount).toBe(2);
    expect(stats.chunkCount).toBe(0);
  });

  it("manager.evict removes stale memory_sources rows AND clears mem0 + map", async () => {
    const { client, deleteCalls } = makeFakeClient();
    const manager = makeManager(client);

    const sourceId = await manager.indexObservations(TEST_AGENT, [
      {
        id: "o-evict",
        observationType: "insight",
        title: "An evictable observation",
        summary: "A reasonably long summary so the chunker yields a mem0 memory.",
        facts: ["evictable fact one", "evictable fact two"],
        concepts: ["delta"],
      },
    ]);

    const db = getDb();
    const writtenIds = await getMem0Ids(db, sourceId);
    expect(writtenIds.length).toBeGreaterThan(0);

    // Backdate the source row to epoch 0 (oldest possible) so it is stale.
    await db`
      UPDATE memory_sources SET created_at = 0 WHERE id = ${sourceId}
    `;

    // Choose a TTL so large the cutoff (now - ttlDays*86400) lands just below
    // "now" — only our epoch-0 row qualifies; real rows (created_at ~ now) are
    // safely AFTER the cutoff and are NOT evicted. This keeps the test hermetic
    // and non-destructive against the shared dev DB while still exercising the
    // real manager.evict() path end-to-end.
    const nowSec = Math.floor(Date.now() / 1000);
    const hugeTtlDays = Math.floor((nowSec - 5) / 86400);
    const result = await manager.evict({
      ttlDays: hugeTtlDays,
      batchSize: 100,
    });
    expect(result.sourcesDeleted).toBeGreaterThanOrEqual(1);

    // memory_sources row gone (manager deleted it synchronously)...
    const remaining = (await db`
      SELECT id FROM memory_sources WHERE id = ${sourceId}
    `) as { id: string }[];
    expect(remaining).toEqual([]);

    // ...and deleteSourceVectors → backend deletes the mapped mem0 ids + map
    // rows. That path is intentionally fire-and-forget (best-effort, never
    // throws into eviction), so poll for eventual completion.
    await waitFor(async () => (await getMem0Ids(db, sourceId)).length === 0);
    expect(deleteCalls.sort()).toEqual([...writtenIds].sort());
    expect(await getMem0Ids(db, sourceId)).toEqual([]);
  });
});
