/**
 * Isolated tests for the SEED-stage graph-reasoning directive injection.
 *
 * Verifies the Pass-1 (discoverIntersections) seed prompt receives the
 * OPPORTUNITY PATHS directive ONLY when smart.graphReasoning.enabled is ON, and
 * that the prompt is byte-identical when the flag is OFF or the directive is "".
 *
 * Mirrors synthesizer-diversity-seed.isolated.test.ts. Filed as
 * *.isolated.test.ts because mock.module stubs the LLM chat client, the config
 * loader, the db, and the existing-ideas store. The chat stub captures every
 * prompt so we can assert on its contents.
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

// ── config loader: graphReasoning.enabled is toggled per-test ────────────────
let graphReasoningEnabled = false;

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
      readAtSynthesis: false,
      writeBack: false,
      reinforceCap: 3,
      avoidCap: 3,
      searchLimit: 10,
    },
    graphReasoning: {
      enabled: graphReasoningEnabled,
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
import { buildGraphReasoningDirective } from "./graph-reasoning";
import type { GraphPath } from "../../sige/knowledge/neo4j-client";
import type { TrendData, ClusteredPains, CapabilityScan } from "./types";

// Build a REAL directive from the production helper so the test stays coupled to
// production wording, not a hand-copied string that can drift.
function directive(): string {
  const paths: GraphPath[] = [
    {
      seed: "clunky export",
      steps: [
        { rel: "LACKS", node: "bulk export" },
        { rel: "HAS_FEATURE", node: "csv export" },
      ],
    },
  ];
  return buildGraphReasoningDirective(paths, 8);
}

const DIRECTIVE = directive();

const trends = { summary: "trend summary", trendingCategories: [] } as unknown as TrendData;
const pains = { summary: "pain summary" } as unknown as ClusteredPains;
const capabilities = {
  summary: "capability summary",
  capabilities: [],
} as unknown as CapabilityScan;

beforeEach(() => {
  capturedPrompts.length = 0;
  graphReasoningEnabled = false;
});

describe("discoverIntersections — SEED graph directive injection", () => {
  test("directive present in seed prompt when supplied", async () => {
    await discoverIntersections(trends, pains, capabilities, "model-x", false, "", DIRECTIVE, "alibaba");
    expect(capturedPrompts.length).toBe(1);
    expect(capturedPrompts[0]).toContain("OPPORTUNITY PATHS");
    // The untrusted fence around each chain survives into the prompt.
    expect(capturedPrompts[0]).toContain('<<UNTRUSTED_DATA source="graph-reasoning">>');
  });

  test("no directive in seed prompt when empty string (byte-identical seed)", async () => {
    // Baseline: no segment directive, no graph directive.
    await discoverIntersections(trends, pains, capabilities, "model-x", false, "", "", "alibaba");
    const baseline = capturedPrompts[0];

    capturedPrompts.length = 0;
    // Same call again with an empty graph directive — must be byte-identical.
    await discoverIntersections(trends, pains, capabilities, "model-x", false, "", "", "alibaba");
    const omitted = capturedPrompts[0];

    expect(baseline).not.toContain("OPPORTUNITY PATHS");
    // Empty-string graph directive must produce a stable, identical seed prompt.
    expect(omitted).toBe(baseline);
  });
});

describe("synthesizeFromTrends — directive gated on graphReasoning.enabled", () => {
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

  test("graphReasoning ON → directive reaches the Pass-1 prompt", async () => {
    graphReasoningEnabled = true;
    await synthesizeFromTrends({ ...baseInput, graphDirective: DIRECTIVE });
    expect(capturedPrompts[0]).toContain("OPPORTUNITY PATHS");
  });

  test("graphReasoning OFF → directive is NOT forwarded even if supplied (byte-identical)", async () => {
    graphReasoningEnabled = false;
    await synthesizeFromTrends({ ...baseInput, graphDirective: DIRECTIVE });
    const gated = capturedPrompts[0];

    capturedPrompts.length = 0;
    // A run that supplies NOTHING must produce the same Pass-1 prompt.
    await synthesizeFromTrends({ ...baseInput });
    const baseline = capturedPrompts[0];

    expect(gated).not.toContain("OPPORTUNITY PATHS");
    expect(gated).toBe(baseline);
  });
});
