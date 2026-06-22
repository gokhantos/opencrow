/**
 * Isolated tests for the SEED-stage segment-diversity directive injection (v2).
 *
 * Verifies the Pass-1 (discoverIntersections) seed prompt receives the learned
 * segment-diversity directive ONLY when smart.outcomeMemory.readAtSynthesis is
 * ON, and that the gate is byte-identical when OFF (no directive in the prompt).
 *
 * Filed as *.isolated.test.ts because mock.module stubs the LLM chat client, the
 * config loader, the db, and the existing-ideas store so no real LLM/DB access
 * occurs. The chat stub captures every prompt so we can assert on its contents.
 *
 * NOTE: mock.module must replace modules BEFORE they are imported, so this file
 * sets up stubs at the top level and then imports the units under test.
 */

import { mock, test, expect, describe, beforeEach } from "bun:test";

// ── chat stub: capture prompts, return one trivial intersection ──────────────
const capturedPrompts: string[] = [];

mock.module("../../agent/chat", () => ({
  chat: async (
    messages: ReadonlyArray<{ role: string; content: string }>,
    _opts: unknown,
  ) => {
    const last = messages[messages.length - 1];
    capturedPrompts.push(last?.content ?? "");
    // Minimal valid Pass-1 JSON so synthesize proceeds deterministically; Pass-2
    // (developIdeas) returns [] so the run ends after the seed without extra LLM
    // dependencies — the seed prompt is all we assert on.
    return {
      text: JSON.stringify([
        {
          title: "Test intersection",
          painSignal: "pain",
          capabilitySignal: "cap",
          marketSignal: "market",
          hypothesis: "h",
          signalStrength: 0.9,
        },
      ]),
    };
  },
}));

// ── config loader: outcomeMemory.readAtSynthesis is toggled per-test ─────────
let readAtSynthesis = false;

function smartConfig() {
  return {
    deepSearchReranker: false,
    rerankFetchK: 10,
    rerankTopK: 3,
    signalFacets: false,
    signalRanking: false,
    signalImportanceFloor: "medium",
    knowledgeGraphRetrieval: false,
    chainOfEvidence: false,
    validatedExemplars: false,
    generateWide: {
      overGenerate: false,
      seedsPerIntersection: 3,
      maxCandidates: 40,
      multiSegment: false,
      sigeDivergent: false,
    },
    giant: { enabled: false, enforceGates: false, weights: {} },
    taste: { antiExemplars: false, exemplarCount: 4 },
    outcomeMemory: {
      readAtSynthesis,
      writeBack: false,
      reinforceCap: 3,
      avoidCap: 3,
      searchLimit: 10,
    },
    graphReasoning: {
      enabled: false,
      maxHops: 3,
      maxPaths: 8,
      searchLimit: 25,
      minDegree: 3,
      maxDegree: 60,
    },
    sigeValuation: false,
    sigeAuto: { broadPoolSize: 20, maxDeepFrontiers: 1, memoryWriteback: false },
  };
}

mock.module("../../config/loader", () => ({
  loadConfig: () => ({ pipelines: { ideas: { smart: smartConfig() } } }),
}));

mock.module("../../store/db", () => ({
  getDb: () => {
    throw new Error("getDb should not be called in this test");
  },
}));

mock.module("../../sources/ideas/store", () => ({
  getAllExistingIdeas: async () => [],
}));

// Import AFTER the mocks are registered.
import { discoverIntersections } from "./synthesizer-generation";
import { synthesizeFromTrends } from "./synthesizer";
import { buildSegmentDiversityDirective, type RetrievedOutcome } from "./outcome-memory";
import type { TrendData, ClusteredPains, CapabilityScan } from "./types";

// Build a REAL v2 directive (fenced over-explored clause + balanced-spread prose)
// from the actual helper so the test stays coupled to production wording, not a
// hand-copied string that can drift.
function directive(): string {
  const items: RetrievedOutcome[] = [
    {
      memory: "body",
      metadata: {
        kind: "idea-outcome",
        verdict: "archived",
        verdictSource: "human",
        ideaId: "h1",
        segment: "healthcare",
        archetype: "hair-on-fire",
        giantComposite: 2.0,
        failingAxes: [],
        juryDissent: null,
        convergenceVeto: false,
        demandScore: 2.0,
        whitespace: 0.3,
        runId: "run-001",
        promptVersion: "v1.0",
        model: "claude-test",
        createdAtSec: 1_000_000,
      },
      relevance: 1,
    },
    {
      memory: "body2",
      metadata: {
        kind: "idea-outcome",
        verdict: "archived",
        verdictSource: "human",
        ideaId: "h2",
        segment: "healthcare",
        archetype: "hair-on-fire",
        giantComposite: 2.0,
        failingAxes: [],
        juryDissent: null,
        convergenceVeto: false,
        demandScore: 2.0,
        whitespace: 0.3,
        runId: "run-001",
        promptVersion: "v1.0",
        model: "claude-test",
        createdAtSec: 1_000_000,
      },
      relevance: 1,
    },
  ];
  return buildSegmentDiversityDirective(items);
}

const DIRECTIVE = directive();

// Minimal corpus on the raw-summary fallback path (no `.insights`): the only
// hard requirement is capabilities.capabilities being an array (the citation
// builder iterates it). Cast through unknown — these are deliberately partial.
const trends = { summary: "trend summary", trendingCategories: [] } as unknown as TrendData;
const pains = { summary: "pain summary" } as unknown as ClusteredPains;
const capabilities = {
  summary: "capability summary",
  capabilities: [],
} as unknown as CapabilityScan;

beforeEach(() => {
  capturedPrompts.length = 0;
  readAtSynthesis = false;
});

describe("discoverIntersections — SEED directive injection", () => {
  test("directive present in seed prompt when supplied", async () => {
    await discoverIntersections(trends, pains, capabilities, "model-x", false, DIRECTIVE, "", "alibaba");
    expect(capturedPrompts.length).toBe(1);
    expect(capturedPrompts[0]).toContain("SEGMENT DIVERSITY (learned from past runs)");
    expect(capturedPrompts[0]).toContain("BALANCED SPREAD");
    // the untrusted fence around the over-explored clause survives into the prompt
    expect(capturedPrompts[0]).toContain('<<UNTRUSTED_DATA source="outcome-memory-segments">>');
  });

  test("no directive in seed prompt when empty string (byte-identical seed)", async () => {
    await discoverIntersections(trends, pains, capabilities, "model-x", false, "", "", "alibaba");
    expect(capturedPrompts.length).toBe(1);
    expect(capturedPrompts[0]).not.toContain("SEGMENT DIVERSITY");
  });

  test("empty directive injects nothing (provider still required)", async () => {
    await discoverIntersections(trends, pains, capabilities, "model-x", false, "", "", "alibaba");
    expect(capturedPrompts[0]).not.toContain("SEGMENT DIVERSITY");
  });
});

describe("synthesizeFromTrends — directive gated on readAtSynthesis", () => {
  const baseInput = {
    trends,
    pains,
    capabilities,
    deepSearchContext: "",
    saturatedThemes: "",
    category: "general" as never,
    maxIdeas: 5,
    model: "model-x",
    provider: "alibaba" as const,
  };

  test("readAtSynthesis ON → directive reaches the Pass-1 prompt", async () => {
    readAtSynthesis = true;
    await synthesizeFromTrends({ ...baseInput, segmentDirective: DIRECTIVE });
    // Pass-1 prompt is the first chat call.
    expect(capturedPrompts[0]).toContain("SEGMENT DIVERSITY (learned from past runs)");
  });

  test("readAtSynthesis OFF → directive is NOT forwarded even if supplied", async () => {
    readAtSynthesis = false;
    await synthesizeFromTrends({ ...baseInput, segmentDirective: DIRECTIVE });
    expect(capturedPrompts[0]).not.toContain("SEGMENT DIVERSITY");
  });
});
