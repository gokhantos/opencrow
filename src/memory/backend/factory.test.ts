import { test, expect, describe } from "bun:test";
import { createMemoryBackend, type MemoryBackendDeps } from "./factory";
import type { Mem0Client } from "../../sige/knowledge/mem0-client";

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

  test('"mem0" without a Mem0Client throws an actionable error', () => {
    // Phase 2: the mem0 backend is implemented but requires a Mem0Client in the
    // deps. Selecting it without one must fail loudly (not silently no-op).
    expect(() => createMemoryBackend("mem0", deps)).toThrow(
      /mem0 memory backend selected but no Mem0Client/,
    );
  });

  test('"mem0" with a Mem0Client returns the full storage seam', () => {
    const fakeClient = {} as unknown as Mem0Client;
    const backend = createMemoryBackend("mem0", {
      ...deps,
      mem0Client: fakeClient,
    });

    expect(typeof backend.search).toBe("function");
    expect(typeof backend.indexTweets).toBe("function");
    expect(typeof backend.indexObservations).toBe("function");
    expect(typeof backend.indexIdea).toBe("function");
    expect(typeof backend.deleteSourceChunks).toBe("function");
    expect(typeof backend.deleteSourceVectors).toBe("function");
  });

  test('default "qdrant" deleteSourceVectors is a graceful no-op when no qdrant client', async () => {
    const backend = createMemoryBackend("qdrant", deps);
    // No Qdrant client → must resolve without throwing.
    await expect(
      backend.deleteSourceVectors(["a", "b"]),
    ).resolves.toBeUndefined();
  });
});
