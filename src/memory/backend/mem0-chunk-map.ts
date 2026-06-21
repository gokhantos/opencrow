import type { SQL } from "bun";

/**
 * Data-access layer for the `mem0_chunk_map` table (migration 029).
 *
 * The mem0 memory backend writes one mem0 memory per text chunk and records the
 * resulting `(sourceId, mem0Id)` pairs here so it can later delete every mem0
 * memory belonging to a source. The qdrant backend never touches this table.
 *
 * All functions take the `Bun.sql` handle explicitly (via `getDb()`) so callers
 * control the connection and tests can inject a stub.
 */

type Db = InstanceType<typeof SQL>;

interface Mem0ChunkMapRow {
  readonly mem0_id: string;
}

/**
 * Record the mem0 ids produced for a single source. No-op when `mem0Ids` is
 * empty. Idempotent: the primary key is `(source_id, mem0_id)`, so re-inserting
 * the same pair is skipped via `ON CONFLICT DO NOTHING`.
 */
export async function recordMem0Ids(
  db: Db,
  sourceId: string,
  mem0Ids: readonly string[],
): Promise<void> {
  for (const mem0Id of mem0Ids) {
    await db`
      INSERT INTO mem0_chunk_map (source_id, mem0_id)
      VALUES (${sourceId}, ${mem0Id})
      ON CONFLICT (source_id, mem0_id) DO NOTHING
    `;
  }
}

/** Look up every mem0 id recorded for a source (empty when none). */
export async function getMem0Ids(
  db: Db,
  sourceId: string,
): Promise<readonly string[]> {
  const rows = (await db`
    SELECT mem0_id FROM mem0_chunk_map WHERE source_id = ${sourceId}
  `) as Mem0ChunkMapRow[];
  return rows.map((r) => r.mem0_id);
}

/** Delete every map row for a source after its mem0 memories are removed. */
export async function deleteMem0Map(db: Db, sourceId: string): Promise<void> {
  await db`DELETE FROM mem0_chunk_map WHERE source_id = ${sourceId}`;
}
