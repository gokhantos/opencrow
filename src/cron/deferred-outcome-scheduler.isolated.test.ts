/**
 * Isolated tests for createDeferredOutcomeScheduler.
 *
 * The store and the mem0 client are CONSTRUCTOR deps (hand-rolled fakes — no
 * mock.module needed for them). The ONE module-level dependency that must be
 * stubbed is `enrichDemand` (DB-bound), so we mock.module the NARROWEST dep
 * (./demand-probes) — per the isolated-lane discipline (the lane shares one
 * process and mock.module leaks; mock the smallest surface).
 *
 * Verifies:
 *   - one tick CLAIMS due rows and supersedes via ADD-BEFORE-DELETE (write the new
 *     reprobe memory, THEN delete priors) when demand moved decisively.
 *   - the inconclusive path (baseline/current at the absence floor) writes NO mem0
 *     memory and only records the row.
 *   - tickOnce() never throws even when a processing step (mem0) throws.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ABSENCE_CONFIDENCE_CAP, type DemandArtifact } from "../pipelines/ideas/demand";

// ── mock the NARROWEST DB-bound dep: enrichDemand ────────────────────────────
// A per-test switch the stub reads, so each test controls the "current" demand.
let nextDemand: DemandArtifact = { score: 4, confidence: 0.9, whitespace: 0.5, evidence: [] };
mock.module("../pipelines/ideas/demand-probes", () => ({
  DEFAULT_DEMAND_PROBES: [],
  enrichDemand: async () => nextDemand,
}));

import { createDeferredOutcomeScheduler } from "./deferred-outcome-scheduler";
import type { DeferredOutcomeSchedulerConfig } from "./deferred-outcome-scheduler";
import type {
  ClaimedReprobe,
  DeferredOutcomeStore,
  RecordReprobeOutcomeInput,
} from "../pipelines/ideas/deferred-outcome-store";
import type { Mem0Client } from "../sige/knowledge/mem0-client";
import type { OutcomeMemory } from "../pipelines/ideas/outcome-memory";
import type { DemandConfig } from "../config/schema";

afterEach(() => {
  nextDemand = { score: 4, confidence: 0.9, whitespace: 0.5, evidence: [] };
});

function baseDemand(score: number, confidence = 0.8): DemandArtifact {
  return { score, confidence, whitespace: 0.5, evidence: [] };
}

function claimed(over: Partial<ClaimedReprobe> = {}): ClaimedReprobe {
  return {
    id: 1,
    ideaId: "idea-1",
    title: "An idea title",
    segment: "b2b-saas",
    archetype: "hair-on-fire",
    validationSource: "proxy:high-giant",
    validatedAt: 1_000_000,
    baselineDemand: baseDemand(2),
    dueAt: 1_000_000,
    ...over,
  };
}

/** Fake store recording calls; claimDueReprobes returns the queued batch once. */
function makeStore(due: readonly ClaimedReprobe[]): DeferredOutcomeStore & {
  _records: RecordReprobeOutcomeInput[];
  _claims: number;
} {
  const records: RecordReprobeOutcomeInput[] = [];
  let claims = 0;
  return {
    _records: records,
    get _claims() {
      return claims;
    },
    enqueueValidatedIdea: async () => true,
    claimDueReprobes: async () => {
      claims += 1;
      return claims === 1 ? due : [];
    },
    recordReprobeOutcome: async (input: RecordReprobeOutcomeInput) => {
      records.push(input);
      return true;
    },
  } as unknown as DeferredOutcomeStore & { _records: RecordReprobeOutcomeInput[]; _claims: number };
}

/** A prior outcome memory for idea-1 so deletePriorOutcomeMemories has a match. */
function priorMemoryFor(ideaId: string): { id: string; memory: string; metadata: OutcomeMemory } {
  return {
    id: "prior-mem-1",
    memory: "prior proxy memory",
    metadata: {
      kind: "idea-outcome",
      verdict: "validated",
      verdictSource: "proxy:high-giant",
      ideaId,
      segment: null,
      archetype: null,
      giantComposite: null,
      failingAxes: [],
      juryDissent: null,
      convergenceVeto: false,
      demandScore: 2,
      whitespace: null,
      runId: "old",
      promptVersion: "old",
      model: "old",
      createdAtSec: 1,
    },
  };
}

/** Fake mem0 recording the ORDER of add vs delete (to assert add-before-delete). */
function makeMem0(opts: { throwOnAdd?: boolean; priorIdeaId?: string } = {}): Mem0Client & {
  _ops: string[];
} {
  const ops: string[] = [];
  return {
    _ops: ops,
    isUnavailable: () => false,
    addMemories: async () => {
      if (opts.throwOnAdd) throw new Error("mem0 down");
      ops.push("add");
    },
    addMemory: async () => ({ memories: [], relations: [] }),
    search: async () => ({ memories: [], relations: [] }),
    getAll: async () => (opts.priorIdeaId ? [priorMemoryFor(opts.priorIdeaId)] : []),
    deleteMemory: async () => {
      ops.push("delete");
    },
  } as unknown as Mem0Client & { _ops: string[] };
}

function config(): DeferredOutcomeSchedulerConfig {
  return {
    reprobe: { scoreDeltaGrew: 0.75, scoreDeltaDecayed: -0.75, tickIntervalMs: 3_600_000, batchSize: 5 },
    demand: { enabled: true } as unknown as DemandConfig,
    ideasUserId: "sige-ideas",
  };
}

describe("createDeferredOutcomeScheduler — one tick", () => {
  test("supersedes via ADD-BEFORE-DELETE when demand grew decisively", async () => {
    nextDemand = baseDemand(4, 0.9); // baseline 2 → current 4 = +2 (grew)
    const store = makeStore([claimed({ ideaId: "idea-1", baselineDemand: baseDemand(2, 0.85) })]);
    const mem0 = makeMem0({ priorIdeaId: "idea-1" });
    const scheduler = createDeferredOutcomeScheduler({
      deferredStore: store,
      mem0Factory: () => mem0,
      config: config(),
    });

    await scheduler.tickOnce();

    // mem0 ADD happened BEFORE the DELETE (crash leaves a dup, never a hole).
    expect(mem0._ops).toEqual(["add", "delete"]);
    // The outcome was recorded with the grew label + delta.
    expect(store._records.length).toBe(1);
    expect(store._records[0]?.label).toBe("grew");
    expect(store._records[0]?.scoreDelta).toBe(2);
  });

  test("inconclusive (current at absence floor) writes NO mem0 memory, records only", async () => {
    nextDemand = baseDemand(1, ABSENCE_CONFIDENCE_CAP); // at floor → inconclusive
    const store = makeStore([claimed({ baselineDemand: baseDemand(2, 0.85) })]);
    const mem0 = makeMem0();
    const scheduler = createDeferredOutcomeScheduler({
      deferredStore: store,
      mem0Factory: () => mem0,
      config: config(),
    });

    await scheduler.tickOnce();

    expect(mem0._ops).toEqual([]); // NO mem0 write at all
    expect(store._records.length).toBe(1);
    expect(store._records[0]?.label).toBe("inconclusive");
  });

  test("no due rows → no mem0 client work, no records", async () => {
    const store = makeStore([]);
    const mem0 = makeMem0();
    const scheduler = createDeferredOutcomeScheduler({
      deferredStore: store,
      mem0Factory: () => mem0,
      config: config(),
    });

    await scheduler.tickOnce();
    expect(mem0._ops).toEqual([]);
    expect(store._records.length).toBe(0);
  });

  test("a tick error (claimDueReprobes throws) is CAUGHT — tick does not throw", async () => {
    // The top-level try/catch must contain a throw from anywhere in the tick body
    // so it can never become an unhandledRejection that crash-loops the cron child.
    const store = {
      enqueueValidatedIdea: async () => true,
      claimDueReprobes: async () => {
        throw new Error("postgres unreachable");
      },
      recordReprobeOutcome: async () => true,
    } as unknown as DeferredOutcomeStore;
    const mem0 = makeMem0();
    const scheduler = createDeferredOutcomeScheduler({
      deferredStore: store,
      mem0Factory: () => mem0,
      config: config(),
    });

    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
    expect(mem0._ops).toEqual([]); // nothing processed
  });

  test("a per-idea processing error (mem0 add throws) does not throw out of the tick", async () => {
    // writeOutcomeMemories is best-effort (swallows), so the supersede degrades to
    // a no-op add but the row is still recorded — and the tick still resolves.
    nextDemand = baseDemand(4, 0.9);
    const store = makeStore([claimed({ ideaId: "idea-1", baselineDemand: baseDemand(2, 0.85) })]);
    const mem0 = makeMem0({ throwOnAdd: true, priorIdeaId: "idea-1" });
    const scheduler = createDeferredOutcomeScheduler({
      deferredStore: store,
      mem0Factory: () => mem0,
      config: config(),
    });

    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
  });
});
