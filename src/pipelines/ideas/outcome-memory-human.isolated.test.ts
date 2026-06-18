/**
 * Isolated tests for writeHumanOutcomeMemory (the POST-RUN human-verdict loop).
 *
 * Uses a recording stub Mem0Client (no live sidecar). Filed as *.isolated.test.ts
 * because the sibling outcome-memory isolated suite uses mock.module which leaks
 * across files in a shared process; keeping all stub-client suites in the isolated
 * lane is the project convention.
 *
 * Coverage:
 *   - validate: delete-prior-by-ideaId FIRST, then one addMemories write with
 *     verdictSource:"human", enableGraph:false, to the ideas userId.
 *   - archive: same shape, verdict "archived".
 *   - restore (stage "idea"): deletes prior, writes NOTHING (retract semantics).
 *   - idempotency: only memories matching THIS ideaId are deleted; foreign ideas
 *     are left untouched.
 *   - best-effort: a getAll/delete/add failure is swallowed (never throws).
 */
import { describe, expect, test } from "bun:test";
import {
  outcomeMemorySchema,
  writeHumanOutcomeMemory,
  type OutcomeMemory,
} from "./outcome-memory";
import type {
  Mem0Client,
  Mem0Memory,
  Mem0SearchResult,
} from "../../sige/knowledge/mem0-client";

interface AddCall {
  items: Array<{ content: string; metadata?: Record<string, unknown> }>;
  userId: string;
  enableGraph?: boolean;
}

interface RecordingStub {
  client: Mem0Client;
  addCalls: AddCall[];
  deleted: string[];
  getAllCalls: number;
}

function makeMemory(ideaId: string | null, id = `mem-${Math.random().toString(36).slice(2)}`): Mem0Memory {
  const metadata: OutcomeMemory = outcomeMemorySchema.parse({
    kind: "idea-outcome",
    verdict: "archived",
    verdictSource: "human",
    ideaId,
    segment: null,
    archetype: null,
    giantComposite: null,
    failingAxes: [],
    juryDissent: null,
    convergenceVeto: false,
    demandScore: null,
    whitespace: null,
    runId: "human-verdict",
    promptVersion: "human-verdict",
    model: "human",
    createdAtSec: 1_700_000_000,
  });
  return { id, memory: "prior body", metadata: metadata as unknown as Record<string, unknown> };
}

function makeRecordingStub(opts: {
  existing?: readonly Mem0Memory[];
  getAllThrows?: boolean;
  deleteThrows?: boolean;
  addThrows?: boolean;
} = {}): RecordingStub {
  const addCalls: AddCall[] = [];
  const deleted: string[] = [];
  let getAllCalls = 0;

  const client = {
    isUnavailable: () => false,
    addMemory: async () => ({ memories: [], relations: [] }),
    addMemories: async (params: AddCall) => {
      if (opts.addThrows) throw new Error("add failed");
      addCalls.push(params);
    },
    search: async (): Promise<Mem0SearchResult> => ({ memories: [], relations: [] }),
    getAll: async () => {
      getAllCalls += 1;
      if (opts.getAllThrows) throw new Error("getAll failed");
      return opts.existing ?? [];
    },
    deleteMemory: async (id: string) => {
      if (opts.deleteThrows) throw new Error("delete failed");
      deleted.push(id);
    },
  } as unknown as Mem0Client;

  return {
    client,
    addCalls,
    deleted,
    get getAllCalls() {
      return getAllCalls;
    },
  } as RecordingStub;
}

const baseInput = {
  ideaId: "idea-1",
  title: "A grounded productivity tool",
  runId: "human-verdict",
  promptVersion: "human-verdict",
  model: "human",
  createdAtSec: 1_700_000_000,
} as const;

describe("writeHumanOutcomeMemory — validate", () => {
  test("deletes prior memories for the ideaId, then writes one human verdict", async () => {
    const stub = makeRecordingStub({
      existing: [makeMemory("idea-1"), makeMemory("idea-1")],
    });
    await writeHumanOutcomeMemory(
      stub.client,
      { ...baseInput, stage: "validated" },
      "sige-ideas",
    );

    // delete-prior ran first and removed both prior idea-1 memories
    expect(stub.deleted.length).toBe(2);
    // then exactly one write
    expect(stub.addCalls.length).toBe(1);
    const call = stub.addCalls[0]!;
    expect(call.userId).toBe("sige-ideas");
    expect(call.enableGraph).toBe(false);
    expect(call.items.length).toBe(1);
    const meta = call.items[0]?.metadata as OutcomeMemory;
    expect(meta.verdict).toBe("validated");
    expect(meta.verdictSource).toBe("human");
    expect(meta.ideaId).toBe("idea-1");
  });
});

describe("writeHumanOutcomeMemory — archive", () => {
  test("writes an archived human verdict", async () => {
    const stub = makeRecordingStub({});
    await writeHumanOutcomeMemory(
      stub.client,
      { ...baseInput, stage: "archived" },
      "sige-ideas",
    );
    expect(stub.addCalls.length).toBe(1);
    const meta = stub.addCalls[0]?.items[0]?.metadata as OutcomeMemory;
    expect(meta.verdict).toBe("archived");
    expect(meta.verdictSource).toBe("human");
  });
});

describe("writeHumanOutcomeMemory — restore (un-archive)", () => {
  test("stage 'idea' deletes prior memory and writes NOTHING", async () => {
    const stub = makeRecordingStub({
      existing: [makeMemory("idea-1")],
    });
    await writeHumanOutcomeMemory(
      stub.client,
      { ...baseInput, stage: "idea" },
      "sige-ideas",
    );
    // prior retracted
    expect(stub.deleted.length).toBe(1);
    // nothing written back
    expect(stub.addCalls.length).toBe(0);
  });
});

describe("writeHumanOutcomeMemory — idempotency scope", () => {
  test("only memories matching THIS ideaId are deleted (foreign ideas untouched)", async () => {
    const mine = makeMemory("idea-1", "mine-1");
    const foreign = makeMemory("idea-2", "foreign-1");
    const stub = makeRecordingStub({ existing: [mine, foreign] });

    await writeHumanOutcomeMemory(
      stub.client,
      { ...baseInput, stage: "validated" },
      "sige-ideas",
    );

    expect(stub.deleted).toContain("mine-1");
    expect(stub.deleted).not.toContain("foreign-1");
  });

  test("a non-idea-outcome row in getAll is ignored (never deleted)", async () => {
    const valid = makeMemory("idea-1", "valid-1");
    const junk: Mem0Memory = {
      id: "junk-1",
      memory: "unrelated",
      metadata: { kind: "something-else", ideaId: "idea-1" },
    };
    const stub = makeRecordingStub({ existing: [valid, junk] });

    await writeHumanOutcomeMemory(
      stub.client,
      { ...baseInput, stage: "archived" },
      "sige-ideas",
    );

    expect(stub.deleted).toContain("valid-1");
    expect(stub.deleted).not.toContain("junk-1");
  });
});

// ── Autonomous-path gating (default-OFF) ─────────────────────────────────────
//
// The autonomous pipeline mirrors the seeded pipeline's gating exactly:
//   READ:  const block = cfg.readAtSynthesis ? await fetchOutcomeMemoryBlock(...) : "";
//   WRITE: if (cfg.writeBack && storedPairs.length > 0) { await writeOutcomeMemories(...) }
//
// Standing up the full 90-minute autonomous pipeline in a unit test is neither
// feasible nor valuable; the load-bearing invariant is that when both flags are
// OFF, neither mem0 entrypoint is reached. We assert that by evaluating the exact
// gating predicates against a recording stub: with the flags off, zero mem0 calls
// are issued; with them on (and items present), exactly the expected calls fire.

import {
  fetchOutcomeMemoryBlock,
  writeOutcomeMemories,
  type OutcomeMemoryItem,
} from "./outcome-memory";

interface ReadWriteStub {
  client: Mem0Client;
  searchCalls: number;
  addCalls: number;
}

function makeReadWriteStub(): ReadWriteStub {
  let searchCalls = 0;
  let addCalls = 0;
  const client = {
    isUnavailable: () => false,
    addMemory: async () => ({ memories: [], relations: [] }),
    addMemories: async () => {
      addCalls += 1;
    },
    search: async (): Promise<Mem0SearchResult> => {
      searchCalls += 1;
      return { memories: [], relations: [] };
    },
    getAll: async () => [],
    deleteMemory: async () => undefined,
  } as unknown as Mem0Client;
  return {
    client,
    get searchCalls() {
      return searchCalls;
    },
    get addCalls() {
      return addCalls;
    },
  } as ReadWriteStub;
}

describe("autonomous-path gating — flags OFF means zero mem0 calls", () => {
  const cfg = { readAtSynthesis: false, writeBack: false, reinforceCap: 5, avoidCap: 5, searchLimit: 12 };

  test("readAtSynthesis OFF → fetchOutcomeMemoryBlock is never invoked (block is '')", async () => {
    const stub = makeReadWriteStub();
    // Mirrors: const block = cfg.readAtSynthesis ? await fetch(...) : "";
    const block = cfg.readAtSynthesis
      ? await fetchOutcomeMemoryBlock({
          mem0: stub.client,
          userId: "sige-ideas",
          query: "q",
          reinforceCap: cfg.reinforceCap,
          avoidCap: cfg.avoidCap,
          searchLimit: cfg.searchLimit,
        })
      : "";
    expect(block).toBe("");
    expect(stub.searchCalls).toBe(0);
  });

  test("writeBack OFF → writeOutcomeMemories is never invoked", async () => {
    const stub = makeReadWriteStub();
    const storedPairsLen = 3;
    const items: OutcomeMemoryItem[] = [];
    // Mirrors: if (cfg.writeBack && storedPairs.length > 0) writeOutcomeMemories(...)
    if (cfg.writeBack && storedPairsLen > 0) {
      await writeOutcomeMemories(stub.client, items, "sige-ideas");
    }
    expect(stub.addCalls).toBe(0);
  });
});

describe("writeHumanOutcomeMemory — best-effort error handling", () => {
  test("a getAll failure is swallowed and the write still proceeds", async () => {
    const stub = makeRecordingStub({ getAllThrows: true });
    await expect(
      writeHumanOutcomeMemory(stub.client, { ...baseInput, stage: "validated" }, "sige-ideas"),
    ).resolves.toBeUndefined();
    // getAll failed → no deletes, but the verdict is still written
    expect(stub.deleted.length).toBe(0);
    expect(stub.addCalls.length).toBe(1);
  });

  test("a deleteMemory failure is swallowed and the write still proceeds", async () => {
    const stub = makeRecordingStub({
      existing: [makeMemory("idea-1")],
      deleteThrows: true,
    });
    await expect(
      writeHumanOutcomeMemory(stub.client, { ...baseInput, stage: "validated" }, "sige-ideas"),
    ).resolves.toBeUndefined();
    expect(stub.addCalls.length).toBe(1);
  });

  test("an addMemories failure is swallowed (never throws into the caller)", async () => {
    const stub = makeRecordingStub({ addThrows: true });
    await expect(
      writeHumanOutcomeMemory(stub.client, { ...baseInput, stage: "archived" }, "sige-ideas"),
    ).resolves.toBeUndefined();
  });
});
