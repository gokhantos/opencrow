import { createQdrantBackend, type QdrantBackendConfig } from "./qdrant-backend";
import type { MemoryBackend, MemoryBackendKind } from "./types";

/**
 * Dependencies needed to construct a memory backend. Today only the Qdrant
 * backend exists, so these mirror its config. When the mem0 backend lands it can
 * read what it needs from this same dependency bag (or the bag grows additively).
 */
export type MemoryBackendDeps = QdrantBackendConfig;

/**
 * Select and construct the memory storage backend for the given kind.
 *
 * - `qdrant` → the live Postgres + Qdrant + FTS backend (default; unchanged
 *   behavior).
 * - `mem0` → not implemented yet; throws an explicit, actionable error so the
 *   operator knows to keep the flag at its default until phase 2 ships.
 */
export function createMemoryBackend(
  kind: MemoryBackendKind,
  deps: MemoryBackendDeps,
): MemoryBackend {
  switch (kind) {
    case "qdrant":
      return createQdrantBackend(deps);
    case "mem0":
      throw new Error(
        "mem0 memory backend not yet implemented (planned phase 2); set OPENCROW_MEMORY_BACKEND=qdrant",
      );
    default: {
      // Exhaustiveness guard: a new MemoryBackendKind must be handled here.
      const _exhaustive: never = kind;
      throw new Error(`Unknown memory backend: ${String(_exhaustive)}`);
    }
  }
}
