import type {
  MemoryIndexer,
  MemorySearch,
  SearchOptions,
  SearchResult,
} from "../types";

/**
 * Selectable memory storage backends.
 *
 * - `qdrant` — the default, live backend: Postgres rows + Qdrant vectors + FTS,
 *   wired through the existing indexer/search helpers (see `QdrantBackend`).
 * - `mem0` — planned phase-2 backend; not implemented yet. Selecting it throws
 *   an explicit error from the backend factory.
 */
export type MemoryBackendKind = "qdrant" | "mem0";

/**
 * Internal storage seam between {@link MemoryManager} and the concrete
 * vector/embedding/FTS storage code. The manager owns the public, caller-facing
 * API and the backend-agnostic Postgres bookkeeping (stats, source/chunk row
 * deletion in eviction); a `MemoryBackend` owns everything storage-specific:
 * writing/indexing content, hybrid retrieval, and removing a source's vectors
 * from the underlying store.
 *
 * This captures ONLY the operations the manager delegates. The index methods
 * mirror {@link MemoryIndexer} (writes + per-source chunk deletion); `search`
 * mirrors {@link MemorySearch} (ranked hybrid results). `deleteSourceVectors`
 * is the store-specific point removal the manager invokes during eviction —
 * the Postgres row deletes around it stay in the manager because they are
 * identical regardless of backend.
 *
 * All domain types (the ranked-result shape, source-kind filters, scope/agentId)
 * live in `../types`, so the manager never needs to know which backend is wired.
 */
export interface MemoryBackend extends MemoryIndexer, MemorySearch {
  /**
   * Remove all vectors/points associated with the given source ids from the
   * underlying vector store. Best-effort and non-throwing: a store that is
   * unavailable, or a backend that has no separate vector store, is a no-op.
   * The caller (eviction) has already removed the corresponding Postgres rows.
   */
  deleteSourceVectors(sourceIds: readonly string[]): Promise<void>;
}

/** Re-exported for convenience at the seam boundary. */
export type { SearchOptions, SearchResult };
