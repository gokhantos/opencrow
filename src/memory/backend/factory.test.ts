import { test, expect, describe } from "bun:test";
import { createMemoryBackend, type MemoryBackendDeps } from "./factory";

/**
 * Unit tests for the memory backend selection factory. Pure construction logic —
 * no DB, Qdrant, or embedding I/O is exercised (the deps are nulled out), so
 * this lives in the unit (`*.test.ts`) lane.
 */

const deps: MemoryBackendDeps = {
  embeddingProvider: null,
  qdrantClient: null,
  qdrantCollection: "test_collection",
};

describe("createMemoryBackend", () => {
  test('"qdrant" returns a backend exposing the full storage seam', () => {
    const backend = createMemoryBackend("qdrant", deps);

    // The MemoryBackend seam = MemoryIndexer + MemorySearch + vector deletion.
    expect(typeof backend.search).toBe("function");
    expect(typeof backend.indexTweets).toBe("function");
    expect(typeof backend.indexArticles).toBe("function");
    expect(typeof backend.indexObservations).toBe("function");
    expect(typeof backend.indexIdea).toBe("function");
    expect(typeof backend.deleteSourceChunks).toBe("function");
    expect(typeof backend.deleteSourceVectors).toBe("function");
  });

  test('"mem0" throws the explicit not-implemented error', () => {
    expect(() => createMemoryBackend("mem0", deps)).toThrow(
      "mem0 memory backend not yet implemented (planned phase 2); set OPENCROW_MEMORY_BACKEND=qdrant",
    );
  });

  test('default "qdrant" deleteSourceVectors is a graceful no-op when no qdrant client', async () => {
    const backend = createMemoryBackend("qdrant", deps);
    // No Qdrant client → must resolve without throwing.
    await expect(
      backend.deleteSourceVectors(["a", "b"]),
    ).resolves.toBeUndefined();
  });
});
