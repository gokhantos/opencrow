import type { BackfillSource } from "./dal";

/**
 * Scoping config for the backfill — mirrors the live mem0 backend's read/write
 * axis EXACTLY so backfilled memories land under the same `user_id` a flipped
 * backend will read from.
 *
 * The live system has ONE global `memorySearch.shared` flag (default `true`,
 * config/schema.ts) applied uniformly across every source: there is NO per-source
 * or per-kind shared/per-agent split. The mem0 backend's `resolveUserId` is
 * `shared ? sharedUserId : agentId`. The backfill replicates that 1:1.
 */
export interface BackfillScoping {
  /** The global `memorySearch.shared` flag the live backend uses. */
  readonly shared: boolean;
  /** `memorySearch.mem0SharedUserId` (default "opencrow-shared"). */
  readonly sharedUserId: string;
}

/**
 * Resolve the mem0 `user_id` for a source, identically to the live backend's
 * `resolveUserId(config, agentId)`:
 *   - shared mode (the default): every source → the shared pool `user_id`.
 *   - per-agent mode: each source → its own `agent_id`.
 *
 * This is the load-bearing contract: get it wrong and the flipped backend reads
 * a different `user_id` than the backfill wrote, so backfilled memories are
 * invisible. It deliberately reads the source's stored `agentId` (the same value
 * the indexer passed as `agentId` when first indexing).
 */
export function resolveBackfillUserId(
  scoping: BackfillScoping,
  source: BackfillSource,
): string {
  return scoping.shared ? scoping.sharedUserId : source.agentId;
}
