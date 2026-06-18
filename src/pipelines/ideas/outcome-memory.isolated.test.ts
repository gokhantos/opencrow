/**
 * Isolated tests for writeOutcomeMemories + fetchOutcomeMemoryBlock.
 *
 * Uses mock.module to stub the Mem0Client so these tests are deterministic and
 * do NOT require a live Mem0 sidecar. Filed as *.isolated.test.ts because
 * mock.module leaks across files in a shared process.
 *
 * Coverage:
 *   writeOutcomeMemories:
 *     - items=[] is a no-op (zero addMemories calls)
 *     - items=[…] calls addMemories ONCE with enableGraph:false and the correct userId
 *     - a throwing client is swallowed (no throw, caller receives void)
 *     - a breaker-open (unavailable) client — the stub throws — is also swallowed
 *     - dedup-rejected entry gets verdict "dedup-rejected" and verdictSource "dedup"
 *     - stored-pending entry gets verdict "stored-pending" and verdictSource "none"
 *
 *   fetchOutcomeMemoryBlock:
 *     - stubbed search returns fenced reinforce+avoid block with header
 *     - client-side post-filter drops a planted metadata.kind !== "idea-outcome" row
 *     - a thrown search => returns "" (never throws)
 */

import { describe, test, expect } from "bun:test";
import {
  writeOutcomeMemories,
  fetchOutcomeMemoryBlock,
  outcomeMemorySchema,
  type OutcomeMemoryItem,
  type OutcomeMemory,
} from "./outcome-memory";
import type { Mem0Client, Mem0Memory, Mem0SearchResult, Mem0AddResult } from "../../sige/knowledge/mem0-client";

// ── Stub Mem0Client ───────────────────────────────────────────────────────────

interface AddMemoriesCall {
  items: Array<{ content: string; metadata?: Record<string, unknown> }>;
  userId: string;
  enableGraph?: boolean;
  maxConcurrent?: number;
}

interface SearchCall {
  query: string;
  userId: string;
  limit?: number;
  enableGraph?: boolean;
  filters?: Record<string, unknown>;
}

function makeStubClient(opts: {
  addMemoriesImpl?: (params: AddMemoriesCall) => Promise<void>;
  searchImpl?: (params: SearchCall) => Promise<Mem0SearchResult>;
}): Mem0Client {
  const addMemoriesCalls: AddMemoriesCall[] = [];
  const searchCalls: SearchCall[] = [];

  const stub = {
    _addMemoriesCalls: addMemoriesCalls,
    _searchCalls: searchCalls,
    isUnavailable: () => false,
    addMemory: async () => ({ memories: [], relations: [] } as Mem0AddResult),
    addMemories: async (params: AddMemoriesCall) => {
      addMemoriesCalls.push(params);
      if (opts.addMemoriesImpl) return opts.addMemoriesImpl(params);
    },
    search: async (params: SearchCall) => {
      searchCalls.push(params);
      if (opts.searchImpl) return opts.searchImpl(params);
      return { memories: [], relations: [] } as Mem0SearchResult;
    },
    getAll: async () => [],
    deleteMemory: async () => undefined,
  } as unknown as Mem0Client & {
    _addMemoriesCalls: AddMemoriesCall[];
    _searchCalls: SearchCall[];
  };
  return stub;
}

function makeThrowingClient(): Mem0Client {
  return {
    isUnavailable: () => true,
    addMemory: async () => {
      throw new Error("Mem0 unavailable (circuit breaker open)");
    },
    addMemories: async () => {
      throw new Error("Mem0 unavailable (circuit breaker open)");
    },
    search: async () => {
      throw new Error("Mem0 unavailable (circuit breaker open)");
    },
    getAll: async () => [],
    deleteMemory: async () => undefined,
  } as unknown as Mem0Client;
}

// ── OutcomeMemoryItem helpers ─────────────────────────────────────────────────

function makeItem(
  verdict: OutcomeMemory["verdict"],
  verdictSource: string,
  ideaId: string | null,
  sentence = "A rendered outcome sentence",
): OutcomeMemoryItem {
  const metadata = outcomeMemorySchema.parse({
    kind: "idea-outcome",
    verdict,
    verdictSource,
    ideaId,
    segment: "test-segment",
    archetype: "hair-on-fire",
    giantComposite: 3.2,
    failingAxes: [],
    juryDissent: null,
    convergenceVeto: false,
    demandScore: 3.0,
    whitespace: 0.5,
    runId: "run-1",
    promptVersion: "v1",
    model: "test-model",
    createdAtSec: 1_000_000,
  });
  return { sentence, metadata };
}

function makeMemory(
  verdict: OutcomeMemory["verdict"],
  verdictSource: string,
  ideaId: string | null,
  body = "Memory text",
): Mem0Memory {
  const metadata: OutcomeMemory = outcomeMemorySchema.parse({
    kind: "idea-outcome",
    verdict,
    verdictSource,
    ideaId,
    segment: "seg",
    archetype: "hard-fact",
    giantComposite: 3.0,
    failingAxes: [],
    juryDissent: null,
    convergenceVeto: false,
    demandScore: 2.0,
    whitespace: 0.3,
    runId: "run-2",
    promptVersion: "v1",
    model: "model",
    createdAtSec: 2_000_000,
  });
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    memory: body,
    metadata: metadata as unknown as Record<string, unknown>,
  };
}

// ── writeOutcomeMemories ──────────────────────────────────────────────────────

describe("writeOutcomeMemories — basic calls", () => {
  test("empty items array is a no-op (zero addMemories calls)", async () => {
    let called = false;
    const client = makeStubClient({
      addMemoriesImpl: async () => {
        called = true;
      },
    });
    await writeOutcomeMemories(client, [], "sige-ideas");
    expect(called).toBe(false);
  });

  test("calls addMemories once with the correct userId and enableGraph=false", async () => {
    const calls: AddMemoriesCall[] = [];
    const client = makeStubClient({
      addMemoriesImpl: async (p) => {
        calls.push(p);
      },
    });

    const items = [
      makeItem("validated", "human", "idea-1", "Validated sentence"),
      makeItem("archived", "proxy:low-giant", "idea-2", "Archived sentence"),
    ];

    await writeOutcomeMemories(client, items, "sige-ideas");

    expect(calls.length).toBe(1);
    expect(calls[0]?.userId).toBe("sige-ideas");
    expect(calls[0]?.enableGraph).toBe(false);
  });

  test("passes all items as content/metadata pairs", async () => {
    const calls: AddMemoriesCall[] = [];
    const client = makeStubClient({ addMemoriesImpl: async (p) => { calls.push(p); } });

    const items = [
      makeItem("validated", "human", "id-a", "Sentence A"),
      makeItem("archived", "proxy:x", "id-b", "Sentence B"),
    ];
    await writeOutcomeMemories(client, items, "sige-ideas");

    const sentPayload = calls[0]?.items ?? [];
    expect(sentPayload.length).toBe(2);
    expect(sentPayload[0]?.content).toBe("Sentence A");
    expect(sentPayload[1]?.content).toBe("Sentence B");
  });

  test("verdict and verdictSource are reflected in the metadata sent to mem0", async () => {
    const calls: AddMemoriesCall[] = [];
    const client = makeStubClient({ addMemoriesImpl: async (p) => { calls.push(p); } });

    const items = [
      makeItem("dedup-rejected", "dedup", null, "Dedup sentence"),
      makeItem("stored-pending", "none", "id-sp", "Pending sentence"),
    ];
    await writeOutcomeMemories(client, items, "sige-ideas");

    const payload = calls[0]?.items ?? [];
    const dedupItem = payload.find((i) => (i.metadata as OutcomeMemory | undefined)?.verdict === "dedup-rejected");
    const pendingItem = payload.find((i) => (i.metadata as OutcomeMemory | undefined)?.verdict === "stored-pending");

    expect(dedupItem).toBeDefined();
    expect((dedupItem?.metadata as OutcomeMemory | undefined)?.verdictSource).toBe("dedup");
    expect(pendingItem).toBeDefined();
    expect((pendingItem?.metadata as OutcomeMemory | undefined)?.verdictSource).toBe("none");
  });
});

describe("writeOutcomeMemories — error handling", () => {
  test("a throwing client is swallowed — writeOutcomeMemories resolves (does not throw)", async () => {
    const client = makeThrowingClient();
    const items = [makeItem("validated", "human", "id-1")];
    // Must not throw
    await expect(writeOutcomeMemories(client, items, "sige-ideas")).resolves.toBeUndefined();
  });

  test("a generic error in addMemories is swallowed (best-effort)", async () => {
    const client = makeStubClient({
      addMemoriesImpl: async () => {
        throw new Error("network timeout");
      },
    });
    const items = [makeItem("archived", "proxy:x", "id-1")];
    await expect(writeOutcomeMemories(client, items, "sige-ideas")).resolves.toBeUndefined();
  });
});

// ── fetchOutcomeMemoryBlock ────────────────────────────────────────────────────

describe("fetchOutcomeMemoryBlock — normal operation", () => {
  test("returns '' when all searches return empty", async () => {
    const client = makeStubClient({});
    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "saas productivity tool",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });
    expect(result).toBe("");
  });

  test("returns a fenced block when validated memories come back from search", async () => {
    const validatedMemory = makeMemory("validated", "human", "idea-1", "Great validated idea");

    const client = makeStubClient({
      searchImpl: async (params) => {
        const verdict = (params.filters?.["verdict"] as string | undefined) ?? "";
        if (verdict === "validated") {
          return { memories: [validatedMemory], relations: [] };
        }
        return { memories: [], relations: [] };
      },
    });

    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "saas productivity",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    expect(result).toContain("=== OUTCOME MEMORY");
    expect(result).toContain("REINFORCE");
    expect(result).toContain("<<UNTRUSTED_DATA");
  });

  test("client-side post-filter drops a row with metadata.kind !== 'idea-outcome'", async () => {
    const wrongKind = makeMemory("validated", "human", "idea-bad", "Should be filtered out");
    // Tamper with the kind in metadata
    const tamperedMemory: Mem0Memory = {
      ...wrongKind,
      metadata: {
        ...(wrongKind.metadata ?? {}),
        kind: "not-an-idea-outcome",
      },
    };

    const client = makeStubClient({
      searchImpl: async (params) => {
        const verdict = (params.filters?.["verdict"] as string | undefined) ?? "";
        if (verdict === "validated") {
          return { memories: [tamperedMemory], relations: [] };
        }
        return { memories: [], relations: [] };
      },
    });

    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "saas",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    // Filtered out → empty block
    expect(result).toBe("");
  });

  test("client-side post-filter drops a row where metadata.verdict mismatches the bucket", async () => {
    // Server returns a "validated" row in the "archived" bucket search (shouldn't happen but must be handled)
    const mismatch = makeMemory("validated", "human", "idea-mismatch", "Mismatch row");

    const client = makeStubClient({
      searchImpl: async (params) => {
        const verdict = (params.filters?.["verdict"] as string | undefined) ?? "";
        if (verdict === "archived") {
          // Return a validated row — this is the mismatch scenario
          return { memories: [mismatch], relations: [] };
        }
        return { memories: [], relations: [] };
      },
    });

    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "saas",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    // The mismatch row is filtered out — but a true validated row wasn't returned,
    // so result should be "" because no valid rows in any bucket.
    expect(result).toBe("");
  });

  test("issues THREE parallel searches (one per fetch verdict bucket)", async () => {
    const calls: SearchCall[] = [];
    const client = makeStubClient({
      searchImpl: async (params) => {
        calls.push(params);
        return { memories: [], relations: [] };
      },
    });

    await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "query",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    expect(calls.length).toBe(3);
    const verdicts = calls.map((c) => c.filters?.["verdict"] as string | undefined);
    expect(verdicts).toContain("validated");
    expect(verdicts).toContain("archived");
    expect(verdicts).toContain("dedup-rejected");
  });

  test("sends enableGraph:false on every search", async () => {
    const calls: SearchCall[] = [];
    const client = makeStubClient({
      searchImpl: async (params) => {
        calls.push(params);
        return { memories: [], relations: [] };
      },
    });

    await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "query",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    for (const call of calls) {
      expect(call.enableGraph).toBe(false);
    }
  });

  test("excludes proxy-validated from REINFORCE bucket", async () => {
    const proxyMem = makeMemory("validated", "proxy:high-giant", "p-idea", "Proxy validated idea");
    const humanMem = makeMemory("validated", "human", "h-idea", "Human validated idea");

    const client = makeStubClient({
      searchImpl: async (params) => {
        const verdict = (params.filters?.["verdict"] as string | undefined) ?? "";
        if (verdict === "validated") {
          return { memories: [proxyMem, humanMem], relations: [] };
        }
        return { memories: [], relations: [] };
      },
    });

    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "saas",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    expect(result).toContain("Human validated idea");
    expect(result).not.toContain("Proxy validated idea");
  });
});

describe("fetchOutcomeMemoryBlock — error handling", () => {
  test("a fully throwing client returns '' (never throws)", async () => {
    const client = makeThrowingClient();
    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "anything",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });
    expect(result).toBe("");
  });

  test("a single bucket throwing is swallowed and other buckets still contribute", async () => {
    const validatedMemory = makeMemory("validated", "human", "idea-v", "Good validated idea");
    let callCount = 0;

    const client = makeStubClient({
      searchImpl: async (params) => {
        callCount++;
        const verdict = (params.filters?.["verdict"] as string | undefined) ?? "";
        if (verdict === "archived") {
          throw new Error("archived bucket search failed");
        }
        if (verdict === "validated") {
          return { memories: [validatedMemory], relations: [] };
        }
        return { memories: [], relations: [] };
      },
    });

    // Should not throw, and should still include the validated memory
    const result = await fetchOutcomeMemoryBlock({
      mem0: client,
      userId: "sige-ideas",
      query: "saas",
      reinforceCap: 5,
      avoidCap: 5,
      searchLimit: 12,
    });

    // The archived bucket threw but the validated bucket succeeded
    expect(result).toContain("Good validated idea");
    expect(result).not.toBe("");
  });
});
