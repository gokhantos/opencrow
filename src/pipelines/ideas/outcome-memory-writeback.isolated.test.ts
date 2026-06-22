/**
 * Isolated tests for runOutcomeMemoryWriteBack — the Phase-1 write-back gating.
 *
 * Uses a hand-rolled stub Mem0Client (no mock.module, so nothing leaks into the
 * shared isolated process). Verifies:
 *   - writePendingMemories=false (default) → stored-pending / verdictSource:"none"
 *     ideas are NOT written; dedup-rejected writes still happen.
 *   - writePendingMemories=true → pending ideas ARE written.
 *   - supersedePriorOnRerun=true (default) → prior memories for a REAL-verdict
 *     ideaId are deleted (getAll + deleteMemory) before the fresh write.
 *   - supersedePriorOnRerun=false → no deletion.
 */

import { describe, test, expect } from "bun:test";
import { runOutcomeMemoryWriteBack, type StoredIdeaPair } from "./pipeline-runner";
import { outcomeMemorySchema, type OutcomeMemory } from "./outcome-memory";
import type { GeneratedIdeaCandidate } from "./types";
import type { ProxyLabel } from "./feedback-bootstrap";
import type {
  Mem0Client,
  Mem0Memory,
  Mem0AddResult,
  Mem0SearchResult,
} from "../../sige/knowledge/mem0-client";

interface AddCall {
  items: Array<{ content: string; metadata?: Record<string, unknown> }>;
  userId: string;
}

function makeClient(
  opts: { getAllImpl?: () => Promise<readonly Mem0Memory[]> } = {},
): Mem0Client & {
  _adds: AddCall[];
  _deletes: string[];
  _getAllCalls: number;
} {
  const adds: AddCall[] = [];
  const deletes: string[] = [];
  let getAllCalls = 0;
  const stub = {
    _adds: adds,
    _deletes: deletes,
    get _getAllCalls() {
      return getAllCalls;
    },
    isUnavailable: () => false,
    addMemory: async () => ({ memories: [], relations: [] }) as Mem0AddResult,
    addMemories: async (p: AddCall) => {
      adds.push(p);
    },
    search: async () => ({ memories: [], relations: [] }) as Mem0SearchResult,
    getAll: async () => {
      getAllCalls += 1;
      return opts.getAllImpl ? await opts.getAllImpl() : [];
    },
    deleteMemory: async (id: string) => {
      deletes.push(id);
    },
  } as unknown as Mem0Client & {
    _adds: AddCall[];
    _deletes: string[];
    _getAllCalls: number;
  };
  return stub;
}

function candidate(title: string): GeneratedIdeaCandidate {
  // Minimal cast: runOutcomeMemoryWriteBack only reads title / archetype /
  // giantComposite / competability* / segment-derivation off the candidate.
  return {
    title,
    archetype: "hair-on-fire",
    giantComposite: 3.2,
  } as unknown as GeneratedIdeaCandidate;
}

function pair(ideaId: string, title: string): StoredIdeaPair {
  return { ideaId, candidate: candidate(title) };
}

function proxyLabel(ideaId: string): ProxyLabel {
  return {
    event: { kind: "validated", idea_id: ideaId },
    reason: "test-proxy",
  } as unknown as ProxyLabel;
}

function priorMemory(ideaId: string): Mem0Memory {
  const metadata: OutcomeMemory = outcomeMemorySchema.parse({
    kind: "idea-outcome",
    verdict: "validated",
    verdictSource: "human",
    ideaId,
    segment: "seg",
    archetype: "hard-fact",
    giantComposite: 3.0,
    failingAxes: [],
    juryDissent: null,
    convergenceVeto: false,
    demandScore: 2.0,
    whitespace: 0.3,
    runId: "old-run",
    promptVersion: "v0",
    model: "old-model",
    createdAtSec: 1,
  });
  return {
    id: `prior-${ideaId}`,
    memory: "old body",
    metadata: metadata as unknown as Record<string, unknown>,
  };
}

const base = {
  demandByCandidate: new Map(),
  giantGateByCandidate: new Map(),
  sigeSignals: new Map(),
  convergenceVetoed: false,
  ideasUserId: "sige-ideas",
  runId: "run-1",
  promptVersion: "v1",
  model: "test-model",
  createdAtSec: 1_000_000,
} as const;

describe("runOutcomeMemoryWriteBack — writePendingMemories gating", () => {
  test("default (false) skips stored-pending ideas but still writes dedup-rejected", async () => {
    const client = makeClient();
    await runOutcomeMemoryWriteBack({
      ...base,
      storedPairs: [pair("idea-1", "Pending idea title")],
      dedupRejected: ["A duplicate title [dup]"],
      proxyLabels: [], // no real verdict → idea-1 is stored-pending
      outcomeMem0: client,
    });
    // One addMemories batch; it should contain ONLY the dedup-rejected memory.
    expect(client._adds).toHaveLength(1);
    const written = client._adds[0]!.items;
    expect(written).toHaveLength(1);
    expect(written[0]!.metadata?.["verdict"]).toBe("dedup-rejected");
  });

  test("writePendingMemories=true writes the stored-pending idea too", async () => {
    const client = makeClient();
    await runOutcomeMemoryWriteBack({
      ...base,
      storedPairs: [pair("idea-1", "Pending idea title")],
      dedupRejected: [],
      proxyLabels: [],
      outcomeMem0: client,
      writePendingMemories: true,
    });
    expect(client._adds).toHaveLength(1);
    const verdicts = client._adds[0]!.items.map((i) => i.metadata?.["verdict"]);
    expect(verdicts).toContain("stored-pending");
  });
});

describe("runOutcomeMemoryWriteBack — supersedePriorOnRerun", () => {
  test("default (true) deletes prior memories for a real-verdict ideaId before writing", async () => {
    const client = makeClient({ getAllImpl: async () => [priorMemory("idea-1")] });
    await runOutcomeMemoryWriteBack({
      ...base,
      storedPairs: [pair("idea-1", "Validated idea")],
      dedupRejected: [],
      proxyLabels: [proxyLabel("idea-1")], // real verdict
      outcomeMem0: client,
    });
    expect(client._getAllCalls).toBeGreaterThan(0);
    expect(client._deletes).toContain("prior-idea-1");
    // The fresh verdict is still written after the supersede.
    expect(client._adds).toHaveLength(1);
  });

  test("supersedePriorOnRerun=false performs no deletion", async () => {
    const client = makeClient({ getAllImpl: async () => [priorMemory("idea-1")] });
    await runOutcomeMemoryWriteBack({
      ...base,
      storedPairs: [pair("idea-1", "Validated idea")],
      dedupRejected: [],
      proxyLabels: [proxyLabel("idea-1")],
      outcomeMem0: client,
      supersedePriorOnRerun: false,
    });
    expect(client._deletes).toHaveLength(0);
  });
});
