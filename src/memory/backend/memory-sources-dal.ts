import type { SQL } from "bun";
import type { MemorySourceKind } from "../types";

/**
 * Data-access layer for inserting `memory_sources` bookkeeping rows from the
 * mem0 memory backend.
 *
 * Under `OPENCROW_MEMORY_BACKEND=mem0`, retrieval lives in mem0 and the only
 * Postgres state is the `mem0_chunk_map` table. But `MemoryManager.evict()` and
 * `getStats()` (src/memory/manager.ts) read exclusively from `memory_sources`
 * (TTL keys off `created_at`; stats count `DISTINCT id` per `agent_id`). So the
 * mem0 backend must also persist a `memory_sources` row per indexed source, or
 * eviction never finds mem0 memories (unbounded growth) and stats report zero.
 *
 * This mirrors the EXACT column shape the Qdrant indexer writes inline in
 * `indexer.ts` (`indexSourceWithChunks`): id, kind, agent_id, channel, chat_id,
 * metadata_json, created_at — so both backends produce schema-identical source
 * rows that the manager treats uniformly. The mem0 path writes NO
 * `memory_chunks` rows: those back the Qdrant/FTS path only, and the manager's
 * `LEFT JOIN memory_chunks` tolerates their absence (chunk_count/total_tokens
 * report 0; source_count and TTL eviction stay correct).
 *
 * The function takes the `Bun.sql` handle explicitly so callers control the
 * connection and tests can inject a stub (per the isolated-lane mock seam).
 */

type Db = InstanceType<typeof SQL>;

export interface InsertMemorySourceArgs {
  readonly id: string;
  readonly kind: MemorySourceKind;
  readonly agentId: string;
  readonly channel: string | null;
  readonly chatId: string | null;
  readonly metadataJson: string;
  /** Epoch seconds; same clock the Qdrant indexer uses for TTL parity. */
  readonly createdAt: number;
}

/**
 * Insert one `memory_sources` bookkeeping row. Idempotent on the primary key
 * (`id`) via `ON CONFLICT DO NOTHING`, so a retried index call cannot fail on a
 * duplicate source row.
 */
export async function insertMemorySource(
  db: Db,
  args: InsertMemorySourceArgs,
): Promise<void> {
  await db`
    INSERT INTO memory_sources
      (id, kind, agent_id, channel, chat_id, metadata_json, created_at)
    VALUES (
      ${args.id},
      ${args.kind},
      ${args.agentId},
      ${args.channel},
      ${args.chatId},
      ${args.metadataJson},
      ${args.createdAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}
