import type { Mem0Client } from "../../sige/knowledge/mem0-client";
import { createMem0Backend } from "./mem0-backend";
import { createQdrantBackend, type QdrantBackendConfig } from "./qdrant-backend";
import type { MemoryBackend, MemoryBackendKind } from "./types";

/**
 * Dependencies needed to construct a memory backend.
 *
 * The Qdrant backend reads the embedding/Qdrant/ranking knobs (`QdrantBackendConfig`).
 * The mem0 backend additionally needs a `Mem0Client` (reusing SIGE's circuit-broken
 * HTTP client — never a second client) and the shared user-id. The mem0 fields are
 * OPTIONAL so the qdrant path never requires mem0 configuration; the factory only
 * asserts them when the mem0 backend is actually selected.
 */
export interface MemoryBackendDeps extends QdrantBackendConfig {
  readonly mem0Client?: Mem0Client | null;
  readonly mem0SharedUserId?: string;
}

/**
 * Select and construct the memory storage backend for the given kind.
 *
 * - `qdrant` → the live Postgres + Qdrant + FTS backend (default; unchanged
 *   behavior).
 * - `mem0` → the phase-2 backend: chunks stored as mem0 memories (verbatim,
 *   `infer:false`), with a `mem0_chunk_map` table for delete-by-source. Requires
 *   a `mem0Client` in the deps; throws an explicit, actionable error if absent.
 */
export function createMemoryBackend(
  kind: MemoryBackendKind,
  deps: MemoryBackendDeps,
): MemoryBackend {
  switch (kind) {
    case "qdrant":
      return createQdrantBackend(deps);
    case "mem0": {
      if (!deps.mem0Client) {
        throw new Error(
          "mem0 memory backend selected but no Mem0Client was provided " +
            "(construct one from sige.mem0 baseUrl/apiToken and pass it into the " +
            "manager); set OPENCROW_MEMORY_BACKEND=qdrant to use the default backend",
        );
      }
      return createMem0Backend({
        mem0Client: deps.mem0Client,
        sharedUserId: deps.mem0SharedUserId ?? "opencrow-shared",
        shared: deps.shared,
        defaultLimit: deps.defaultLimit,
        minScore: deps.minScore,
      });
    }
    default: {
      // Exhaustiveness guard: a new MemoryBackendKind must be handled here.
      const _exhaustive: never = kind;
      throw new Error(`Unknown memory backend: ${String(_exhaustive)}`);
    }
  }
}
