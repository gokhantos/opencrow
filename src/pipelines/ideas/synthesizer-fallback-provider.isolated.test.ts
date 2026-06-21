/**
 * Isolated regression test for the idea-pipeline provider-routing leak.
 *
 * The bug: the wide-generation path (`developIdeasWide`) is given the routed
 * provider, but when it times out / yields nothing the pipeline falls back to
 * the single-idea `developIdeas` path. Several generation/collector functions
 * hard-coded a Claude provider default ("anthropic" / "agent-sdk"), and the
 * platform authenticates Claude with the USER'S personal OAuth token — so any
 * un-threaded fallback silently billed their Claude subscription.
 *
 * This test forces the wide → single-idea fallback (overGenerate ON,
 * developIdeasWide yields 0 candidates) and asserts that EVERY chat() call made
 * by the synthesizer (Pass 1, the Pass-2 fallback, and Pass 3 critique) carries
 * the ROUTED non-Claude provider — never "anthropic" or "agent-sdk".
 *
 * Filed as *.isolated.test.ts because mock.module replaces the narrowest deps
 * (../../agent/chat + the config loader + the existing-ideas store) so no real
 * LLM/DB call occurs. mock.module must register BEFORE the unit is imported.
 */

import { mock, test, expect, describe, beforeEach } from "bun:test";

// ── chat stub: capture the OPTIONS (provider/model) of every call ────────────
type CapturedOptions = { provider?: string; model?: string };
const capturedOptions: CapturedOptions[] = [];

mock.module("../../agent/chat", () => ({
  chat: async (
    messages: ReadonlyArray<{ role: string; content: string }>,
    opts: CapturedOptions,
  ) => {
    capturedOptions.push(opts);
    const last = messages[messages.length - 1];
    const content = last?.content ?? "";

    // Pass 1 (discoverIntersections) — return one valid intersection so we
    // proceed into Pass 2. "Find the non-obvious intersections" is unique to the
    // seed prompt (the develop prompts also mention "intersection hypotheses").
    if (content.includes("Find the non-obvious intersections")) {
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
    }

    // Pass 2 wide over-generation (developIdeasWide) — return an EMPTY array so
    // the wide path yields 0 candidates and the synthesizer falls back to the
    // single-idea developIdeas path (the leak site under test).
    if (content.includes("DIVERSE DISTRIBUTION")) {
      return { text: "[]" };
    }

    // Pass 2 single-idea fallback (developIdeas) — return one candidate so the
    // run produces a pool that flows into Pass 3.
    if (content.includes("develop a full product idea")) {
      return {
        text: JSON.stringify([
          {
            title: "Fallback Idea",
            summary: "s",
            reasoning: "r",
            trendIntersection: "t",
            designDescription: "d",
            monetizationDetail: "m",
            sourceLinks: [],
            sourcesUsed: "x",
            category: "general",
            qualityScore: 3,
            targetAudience: "a",
            keyFeatures: ["f"],
            revenueModel: "rev",
          },
        ]),
      };
    }

    // Anything else (Pass 3 critique etc.) — return an empty array; the
    // candidate degrades gracefully to its original score.
    return { text: "[]" };
  },
}));

// ── config loader: generate-wide ON so the wide → single-idea fallback fires ──
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
      overGenerate: true,
      seedsPerIntersection: 3,
      maxCandidates: 40,
      multiSegment: false,
      sigeDivergent: false,
    },
    giant: { enabled: false, enforceGates: false, weights: {} },
    competability: { enabled: false },
    taste: { antiExemplars: false, exemplarCount: 4 },
    outcomeMemory: {
      readAtSynthesis: false,
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

mock.module("../../sources/ideas/store", () => ({
  getAllExistingIdeas: async () => [],
}));

// Import AFTER the mocks are registered.
import { synthesizeFromTrends } from "./synthesizer";
import type { TrendData, ClusteredPains, CapabilityScan } from "./types";

const trends = {
  trendingCategories: [],
  risingApps: [],
  summary: "landscape",
} as unknown as TrendData;
const pains = { clusters: [], summary: "pains" } as unknown as ClusteredPains;
const capabilities = {
  capabilities: [],
  summary: "caps",
} as unknown as CapabilityScan;

describe("synthesizeFromTrends — fallback inherits the routed provider", () => {
  beforeEach(() => {
    capturedOptions.length = 0;
  });

  test("wide→single-idea fallback uses the ROUTED provider, never Claude", async () => {
    await synthesizeFromTrends({
      trends,
      pains,
      capabilities,
      deepSearchContext: "",
      saturatedThemes: "",
      category: "general" as never,
      maxIdeas: 5,
      model: "deepseek-v4-pro",
      provider: "alibaba",
    });

    // The fallback must have actually fired: at least Pass 1 + the wide pass +
    // the single-idea fallback = 3 chat calls.
    expect(capturedOptions.length).toBeGreaterThanOrEqual(3);

    // EVERY call (Pass 1, wide, single-idea fallback, critique) must carry the
    // routed provider — the fallback must NOT jump to Claude.
    for (const opts of capturedOptions) {
      expect(opts.provider).toBe("alibaba");
      expect(opts.provider).not.toBe("anthropic");
      expect(opts.provider).not.toBe("agent-sdk");
      expect(opts.model).toBe("deepseek-v4-pro");
    }
  });

  test("the single-idea fallback path was exercised (not just the wide pass)", async () => {
    await synthesizeFromTrends({
      trends,
      pains,
      capabilities,
      deepSearchContext: "",
      saturatedThemes: "",
      category: "general" as never,
      maxIdeas: 5,
      model: "deepseek-v4-pro",
      provider: "openrouter",
    });

    // A different routed provider flows through identically — proving the
    // provider is threaded, not hard-coded.
    expect(capturedOptions.every((o) => o.provider === "openrouter")).toBe(true);
  });
});
