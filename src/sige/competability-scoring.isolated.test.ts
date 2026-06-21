/**
 * Behavioral coverage for the SIGE competability gate (PR #208 follow-up #1).
 *
 * Mocks the narrowest dependency — `../agent/chat` — so no real LLM call is
 * made, then asserts the shadow/enforce semantics, the heuristic short-circuit,
 * and the graceful degradation to a heuristic-only score on an LLM failure.
 *
 * Isolated lane: `mock.module` is process-wide and leaks across files in the
 * shared test:isolated process, so we mock only `../agent/chat` (the single
 * dependency this module pulls in for its LLM call).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

let scriptedText = "[]";
let shouldThrow = false;
const chatCalls: Array<Record<string, unknown>> = [];

mock.module("../agent/chat", () => ({
  chat: async (_messages: unknown, options: Record<string, unknown>) => {
    chatCalls.push(options);
    if (shouldThrow) throw new Error("LLM down");
    return { text: scriptedText, provider: "anthropic" };
  },
}));

import {
  extractRawArray,
  gateSigeIdeasOnCompetability,
} from "./competability-scoring";
import type { CompetabilityConfig } from "../config/schema";
import type { ScoredIdea, StrategicMetadata } from "./types";

const META: StrategicMetadata = {
  paretoOptimal: true,
  dominantStrategy: false,
  evolutionarilyStable: false,
  nashEquilibrium: true,
};

function idea(partial: Partial<ScoredIdea>): ScoredIdea {
  return {
    id: "idea-1",
    title: "A sharp niche CLI",
    description: "Lints SQL migrations for solo devs.",
    proposedBy: "founder",
    round: 1,
    expertScore: 0.6,
    incentiveBreakdown: {
      diversityBonus: 0,
      buildingBonus: 0,
      surpriseBonus: 0,
      accuracyPenalty: 0,
      memoryReward: 0,
      coalitionStability: 0,
      signalCredibility: 0,
      socialViability: 0,
    },
    strategicMetadata: META,
    ...partial,
  };
}

function config(overrides: Partial<CompetabilityConfig> = {}): CompetabilityConfig {
  return {
    enabled: true,
    enforceGate: false,
    rejectThreshold: 2,
    softPenaltyThreshold: 2.5,
    topNIncumbents: 100,
    hardVeto: true,
    hardVetoThreshold: 4,
    hardVetoDimensions: ["regulated", "capital", "logistics", "networkEffect"],
    // Default = solo bootstrapper = identity transform, so these SIGE gate tests
    // assert the same behavior as before builder profiles existed.
    builderProfile: {
      capital: "bootstrap",
      teamSize: 1,
      expertiseDomains: [],
      regulatoryAppetite: "low",
      opsAppetite: "low",
    },
    ...overrides,
  };
}

beforeEach(() => {
  scriptedText = "[]";
  shouldThrow = false;
  chatCalls.length = 0;
});

describe("extractRawArray", () => {
  it("parses a bare JSON array", () => {
    const arr = extractRawArray('[{"id":"a","overall":4}]');
    expect(arr).toHaveLength(1);
    expect(arr[0]!.id).toBe("a");
  });

  it("parses a fenced array", () => {
    const arr = extractRawArray('```json\n[{"id":"b","overall":1}]\n```');
    expect(arr[0]!.id).toBe("b");
  });

  it("returns [] for non-parseable text (never throws)", () => {
    expect(extractRawArray("not json at all")).toEqual([]);
  });
});

describe("gateSigeIdeasOnCompetability", () => {
  it("returns empty for no ideas", async () => {
    const r = await gateSigeIdeasOnCompetability({
      ideas: [],
      config: config(),
      model: "claude-sonnet-4-6",
    });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  it("shadow mode keeps an uncompetable idea but flags+persists it", async () => {
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 5, networkEffect: 5, logistics: 5, regulated: 0 },
        overall: 1,
        rationale: "a two-sided marketplace at national scale",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1" })],
      config: config({ enforceGate: false }),
      model: "claude-sonnet-4-6",
    });
    expect(r.dropped).toHaveLength(0);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.gated).toBe(true);
    expect(r.kept[0]!.persisted.overall).toBe(1);
    expect(r.kept[0]!.persisted.gated).toBe(true);
  });

  it("enforce mode DROPS an uncompetable idea before persistence", async () => {
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 5, networkEffect: 5, logistics: 5, regulated: 5 },
        overall: 0.5,
        rationale: "build a DoorDash",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1" })],
      config: config({ enforceGate: true }),
      model: "claude-sonnet-4-6",
    });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.gated).toBe(true);
  });

  it("keeps a clearly competable solo-buildable idea", async () => {
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 0, networkEffect: 0, logistics: 0, regulated: 0 },
        overall: 5,
        rationale: "wide open niche tool",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1" })],
      config: config({ enforceGate: true }),
      model: "claude-sonnet-4-6",
    });
    expect(r.dropped).toHaveLength(0);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.gated).toBe(false);
  });

  it("degrades to a heuristic-only neutral score on an LLM failure", async () => {
    shouldThrow = true;
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1", title: "Clean niche tool", description: "no moats" })],
      config: config({ enforceGate: true }),
      model: "claude-sonnet-4-6",
    });
    // Neutral midpoint (2.5) is above the reject threshold, so it survives.
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.persisted.overall).toBe(2.5);
    expect(r.kept[0]!.gated).toBe(false);
  });

  it("the heuristic flags an obvious uncompetable shell even when the LLM is lenient", async () => {
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 0, networkEffect: 0, logistics: 0, regulated: 0 },
        overall: 5,
        rationale: "lenient",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [
        idea({
          id: "idea-1",
          title: "A food delivery app to rival DoorDash",
          description: "last-mile courier fleet for restaurants",
        }),
      ],
      config: config({ enforceGate: true }),
      // Heuristic needs a named incumbent in the set to mark it obvious.
      incumbentSet: new Set(["doordash"]),
      model: "claude-sonnet-4-6",
    });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.gated).toBe(true);
  });

  it("HARD-VETOES a regulated idea even when overall is high (composite gate would keep it)", async () => {
    // regulated=4 raw, but overall=4.5 — the composite gate alone would PASS this;
    // the hard per-dimension veto kills it regardless of the high overall.
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 1, networkEffect: 1, logistics: 1, regulated: 4 },
        overall: 4.5,
        rationale: "needs a banking license",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1", title: "A neobank for freelancers" })],
      config: config({ enforceGate: true }),
      model: "claude-sonnet-4-6",
    });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.gated).toBe(true);
    expect(r.dropped[0]!.reason).toContain("hard-veto: regulated=4");
  });

  it("hard veto is SHADOW (kept) when not enforcing, but still flagged + reasoned", async () => {
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 5, networkEffect: 1, logistics: 1, regulated: 1 },
        overall: 4.5,
        rationale: "heavy capex",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1", title: "A robotics fulfillment rig" })],
      config: config({ enforceGate: false }),
      model: "claude-sonnet-4-6",
    });
    // Shadow mode: kept, but flagged gated with the veto reason persisted.
    expect(r.dropped).toHaveLength(0);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.gated).toBe(true);
    expect(r.kept[0]!.reason).toContain("hard-veto: capital=5");
  });

  it("hardVeto:false disables the per-dimension veto (composite gate still applies)", async () => {
    // regulated=4, high overall — with the veto OFF this PASSES (composite only).
    scriptedText = JSON.stringify([
      {
        id: "idea-1",
        dimensions: { capital: 1, networkEffect: 1, logistics: 1, regulated: 4 },
        overall: 4.5,
        rationale: "regulated but veto disabled",
      },
    ]);
    const r = await gateSigeIdeasOnCompetability({
      ideas: [idea({ id: "idea-1", title: "A compliance tool" })],
      config: config({ enforceGate: true, hardVeto: false }),
      model: "claude-sonnet-4-6",
    });
    expect(r.dropped).toHaveLength(0);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.gated).toBe(false);
  });
});
