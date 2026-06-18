/**
 * Isolated tests for the provider-driven paths in synthesizer.ts.
 *
 * Filed as *.isolated.test.ts because mock.module is used to stub the config
 * loader and the memory manager so no real LLM calls or DB access occur.
 *
 * Coverage:
 *   deepSearch:
 *     - empty themes list returns "" immediately (no searches)
 *     - single theme with search results returns a formatted corpus section
 *     - all searches returning empty yields "" (no section)
 *     - search throw is swallowed and yields "" gracefully
 *
 *   The "signal ranking" and "graph evidence" branches are off by default
 *   (smart.signalFacets/signalRanking/knowledgeGraphRetrieval all false).
 *
 * NOTE: mock.module must replace modules BEFORE they are imported, so this file
 * sets up stubs at the top level and then imports the unit under test.
 */

import { mock } from "bun:test";
import { test, expect, describe } from "bun:test";

// ── Stub: config loader (smart flags all OFF → legacy path) ──────────────────
const SMART_DEFAULTS = {
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
  outcomeMemory: { readAtSynthesis: false },
  sigeValuation: false,
  sigeAuto: {
    broadPoolSize: 20,
    maxDeepFrontiers: 1,
    memoryWriteback: false,
  },
};

mock.module("../../config/loader", () => ({
  loadConfig: () => ({
    pipelines: { ideas: { smart: SMART_DEFAULTS } },
  }),
}));

// ── Stub: store/db (not called on this path, but imported transitively) ──────
mock.module("../../store/db", () => ({
  getDb: () => {
    throw new Error("getDb should not be called in deepSearch unit tests");
  },
}));

// ── Stub: sources/ideas/store ─────────────────────────────────────────────────
mock.module("../../sources/ideas/store", () => ({
  getAllExistingIdeas: async () => [],
}));

// Import AFTER mock.module calls so the stubs are already in place.
import { deepSearch } from "./synthesizer";
import type { MemoryManager, SearchOptions } from "../../memory/types";

// ── helpers ──────────────────────────────────────────────────────────────────

type SearchCall = { namespace: string; query: string };

function makeMemoryManager(
  results: Partial<Record<string, Array<{ id: string; score: number; content: string }>>> = {},
  shouldThrow = false,
): { manager: MemoryManager; calls: SearchCall[] } {
  const calls: SearchCall[] = [];

  const manager: MemoryManager = {
    search: async (namespace: string, query: string, _opts?: SearchOptions) => {
      calls.push({ namespace, query });
      if (shouldThrow) throw new Error("search failed");
      const key = query;
      const hits = results[key] ?? [];
      return hits.map((h) => ({
        score: h.score,
        chunk: { content: h.content, id: crypto.randomUUID() },
        source: {
          id: h.id,
          kind: "hackernews_story" as const,
          agentId: "test",
          channel: null,
          chatId: null,
          createdAt: 0,
          metadata: { title: h.content.slice(0, 40), url: "" },
        },
      }));
    },
    // Stub the remaining MemoryManager methods — they are not called by deepSearch.
    indexIdea: async () => "",
    indexNote: async () => "",
    deleteSourceChunks: async () => undefined,
  } as unknown as MemoryManager;

  return { manager, calls };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("deepSearch", () => {
  test("returns empty string immediately for empty themes", async () => {
    const { manager } = makeMemoryManager();
    const result = await deepSearch([], manager);
    expect(result).toBe("");
  });

  test("returns empty string when all search results are empty", async () => {
    const { manager } = makeMemoryManager({ "no-op theme": [] });
    const result = await deepSearch(["no-op theme"], manager);
    expect(result).toBe("");
  });

  test("returns a formatted corpus section for a theme with results", async () => {
    const { manager } = makeMemoryManager({
      "AI automation": [
        {
          id: "src-1",
          score: 0.8,
          content: "AI is automating workflows fast in 2024",
        },
        {
          id: "src-2",
          score: 0.75,
          content: "Enterprises adopt AI automation tools rapidly",
        },
        {
          id: "src-3",
          score: 0.7,
          content: "AI automation market reached $10B",
        },
      ],
    });

    const result = await deepSearch(["AI automation"], manager);
    expect(result).toContain("DEEP SEARCH");
    expect(result).toContain("AI automation");
    expect(result).toContain("evidence_strength");
  });

  test("swallows a search throw and returns empty string", async () => {
    const { manager } = makeMemoryManager({}, true);
    const result = await deepSearch(["risky theme"], manager);
    // Should not throw; returns "" since all searches failed.
    expect(result).toBe("");
  });

  test("slices themes to at most 6 search queries", async () => {
    const manyThemes = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"];
    const { manager, calls } = makeMemoryManager(
      Object.fromEntries(manyThemes.map((t) => [t, []])),
    );
    await deepSearch(manyThemes, manager);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  test("deduplicates hits across themes (same source id not repeated in a second section)", async () => {
    // The same source id appears in results for two different themes.
    // deepSearch deduplicates by source.id: the shared hit only appears in the
    // FIRST theme's section; the second theme's section gets it filtered out.
    // Use a unique marker string that won't appear in any theme/section heading.
    const sharedHit = {
      id: "shared-src-xyz",
      score: 0.9,
      content: "DEDUPMARKER987",
    };
    const { manager } = makeMemoryManager({
      "Theme A": [sharedHit, { id: "unique-1", score: 0.8, content: "unique A content" }],
      "Theme B": [sharedHit, { id: "unique-2", score: 0.75, content: "unique B content" }],
    });

    const result = await deepSearch(["Theme A", "Theme B"], manager);
    // The chunk text "DEDUPMARKER987" rendered at most once (meta.title also has it,
    // so the entry may contain 2 occurrences — but the second theme section must
    // NOT add a second entry for the same source).
    // Proxy: unique-2 SHOULD appear (not filtered), unique-1 SHOULD appear.
    expect(result).toContain("unique A content");
    expect(result).toContain("unique B content");
    // The DEDUPMARKER appears only in theme A's section, not again in theme B's.
    // We can verify this by checking the output between the two theme headings.
    const themeAIdx = result.indexOf('Theme: "Theme A"');
    const themeBIdx = result.indexOf('Theme: "Theme B"');
    if (themeAIdx !== -1 && themeBIdx !== -1) {
      const themeBSection = result.slice(themeBIdx);
      expect(themeBSection).not.toContain("DEDUPMARKER987");
    }
  });
});
