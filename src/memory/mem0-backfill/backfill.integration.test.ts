/**
 * Integration test for the mem0 backfill against a REAL Postgres.
 *
 * Seeds a `memory_sources` + `memory_chunks` fixture, runs `runBackfill` with a
 * FAKED Mem0Client (a live sidecar is not guaranteed in CI), and asserts the
 * `mem0_chunk_map` rows + idempotency. Only the read DAL + mem0-chunk-map writes
 * hit Postgres; the mem0 HTTP calls are in-process.
 *
 * Guarded by a Postgres reachability probe (`describe.skipIf`): when Postgres is
 * unreachable the whole suite is skipped so a CI job without a DB still exits 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import { runBackfill } from "./backfill";
import type {
  Mem0AddResult,
  Mem0Client,
  Mem0SearchResult,
} from "../../sige/knowledge/mem0-client";

const DB_URL = process.env.DATABASE_URL ?? "postgres://opencrow@127.0.0.1:5432/opencrow";
const TEST_AGENT = "itest-backfill-agent";
const SHARED_USER = "opencrow-shared";

/** Probe Postgres once; if unreachable the suite is skipped (CI exits 0). */
async function postgresReachable(): Promise<boolean> {
  try {
    await initDb(DB_URL, { max: 1 });
    await getDb()`SELECT 1`;
    await closeDb();
    return true;
  } catch {
    return false;
  }
}

const reachable = await postgresReachable();

function makeFakeClient(): { client: Mem0Client; addCount: () => number } {
  let counter = 0;
  const client = {
    async addMemory(params: { content: string }): Promise<Mem0AddResult> {
      counter += 1;
      return {
        memories: [{ id: `itest-backfill-mem-${counter}`, memory: params.content }],
        relations: [],
      };
    },
    async search(): Promise<Mem0SearchResult> {
      return { memories: [], relations: [] };
    },
    async deleteMemory(): Promise<void> {},
  } as unknown as Mem0Client;
  return { client, addCount: () => counter };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`
    DELETE FROM mem0_chunk_map
    WHERE source_id IN (SELECT id FROM memory_sources WHERE agent_id = ${TEST_AGENT})
  `;
  await db`DELETE FROM memory_chunks WHERE source_id IN (SELECT id FROM memory_sources WHERE agent_id = ${TEST_AGENT})`;
  await db`DELETE FROM memory_sources WHERE agent_id = ${TEST_AGENT}`;
}

describe.skipIf(!reachable)("mem0 backfill (integration)", () => {
  const SOURCE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(async () => {
    await initDb(DB_URL, { max: 2 });
    await cleanup();
    const db = getDb();
    await db`
      INSERT INTO memory_sources (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
      VALUES (${SOURCE_ID}, 'note', ${TEST_AGENT}, ${null}, ${null}, ${JSON.stringify({ topic: "infra" })}, ${1_700_000_000})
    `;
    await db`
      INSERT INTO memory_chunks (id, source_id, content, chunk_index, token_count, created_at)
      VALUES
        (${`${SOURCE_ID}-c0`}, ${SOURCE_ID}, 'first chunk text', 0, 4, ${1_700_000_000}),
        (${`${SOURCE_ID}-c1`}, ${SOURCE_ID}, 'second chunk text', 1, 4, ${1_700_000_000})
    `;
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("writes one mem0_chunk_map row per chunk for the seeded source", async () => {
    const { client, addCount } = makeFakeClient();
    const result = await runBackfill(getDb(), client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      agentId: TEST_AGENT,
      batchSize: 10,
      concurrency: 2,
      dryRun: false,
    });

    expect(addCount()).toBe(2);
    expect(result.written).toBe(1);
    expect(result.memories).toBe(2);

    const rows = (await getDb()`
      SELECT mem0_id FROM mem0_chunk_map WHERE source_id = ${SOURCE_ID} ORDER BY mem0_id
    `) as { mem0_id: string }[];
    expect(rows.length).toBe(2);
  });

  it("is idempotent: a second run skips the already-backfilled source", async () => {
    const first = makeFakeClient();
    await runBackfill(getDb(), first.client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      agentId: TEST_AGENT,
      batchSize: 10,
      concurrency: 2,
      dryRun: false,
    });
    expect(first.addCount()).toBe(2);

    // Second run: the source is already in mem0_chunk_map → skipped, no writes.
    const second = makeFakeClient();
    const result = await runBackfill(getDb(), second.client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      agentId: TEST_AGENT,
      batchSize: 10,
      concurrency: 2,
      dryRun: false,
    });

    expect(second.addCount()).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);

    // Still exactly two map rows (no double-write).
    const rows = (await getDb()`
      SELECT mem0_id FROM mem0_chunk_map WHERE source_id = ${SOURCE_ID}
    `) as { mem0_id: string }[];
    expect(rows.length).toBe(2);
  });

  it("dry-run writes nothing to mem0_chunk_map", async () => {
    const { client, addCount } = makeFakeClient();
    const result = await runBackfill(getDb(), client, {
      scoping: { shared: true, sharedUserId: SHARED_USER },
      agentId: TEST_AGENT,
      batchSize: 10,
      concurrency: 2,
      dryRun: true,
    });

    expect(addCount()).toBe(0);
    expect(result.written).toBe(1);
    expect(result.memories).toBe(2);

    const rows = (await getDb()`
      SELECT mem0_id FROM mem0_chunk_map WHERE source_id = ${SOURCE_ID}
    `) as { mem0_id: string }[];
    expect(rows.length).toBe(0);
  });
});
