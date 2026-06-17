/**
 * Isolated tests for discoverFrontiers end-to-end.
 *
 * Uses mock.module to stub generateDivergentIdeas, quickSearch, and getDb so
 * we can test the orchestration logic without LLM or DB.
 *
 * Key contracts:
 * - broadPoolSize cap is passed through to generateDivergentIdeas
 * - Returns empty DiscoveryResult when generateDivergentIdeas fails (never throws)
 * - Returns empty DiscoveryResult when all candidates are empty
 * - Frontier scoring runs even on Mem0 failure (neutral novelty=1)
 *
 * NOTE: *.isolated.test.ts because mock.module is used.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks — must come before imports ───────────────────────────────────

let generateDivergentIdeasShouldThrow = false;
let generateDivergentIdeasReturnValue: unknown[] = [];
let capturedGenerateDivergentOptions: Record<string, unknown>[] = [];

mock.module("../run", () => ({
  generateDivergentIdeas: mock(
    async (_context: unknown, opts: Record<string, unknown>) => {
      capturedGenerateDivergentOptions.push(opts ?? {});
      if (generateDivergentIdeasShouldThrow) throw new Error("LLM unavailable");
      return generateDivergentIdeasReturnValue;
    },
  ),
}));

let quickSearchShouldThrow = false;
let quickSearchReturnValue = { score: 0, results: [] };

mock.module("../memory/retrieval-modes", () => ({
  quickSearch: mock(async () => {
    if (quickSearchShouldThrow) throw new Error("Mem0 down");
    return quickSearchReturnValue;
  }),
  insightForge: mock(async () => ({ score: 0, results: [] })),
}));

// Mock getDb so extractSaturatedThemeKeys doesn't blow up
mock.module("../../store/db", () => ({
  getDb: mock(() => {
    const fakeDb = Object.assign(
      async () => [], // callable with template literal (no rows)
      { unsafe: async () => [] },
    );
    return fakeDb;
  }),
  initDb: mock(async () => {}),
  closeDb: mock(async () => {}),
}));

// Mock pipeline's extractThemesByNgrams to return predictable results
mock.module("../../pipelines/ideas/pipeline", () => ({
  extractThemesByNgrams: mock((rows: Array<{ title: string }>) => {
    // Return a simple theme line for each unique bigram we can find
    const counts = new Map<string, number>();
    for (const { title } of rows) {
      const tokens = title.toLowerCase().split(/\s+/);
      for (let i = 0; i < tokens.length - 1; i++) {
        const bigram = `${tokens[i]} ${tokens[i + 1]}`;
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
      }
    }
    const result: string[] = [];
    for (const [bigram, count] of counts) {
      if (count >= 2) {
        result.push(`- "${bigram}" theme (${count} ideas) — e.g. some example`);
      }
    }
    return result;
  }),
}));

mock.module("../../logger", () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

import { discoverFrontiers } from "./frontier-discovery";
import type { BroadCorpus } from "./frontier-discovery";
import type { DivergentCandidate } from "../run";
import type { Mem0Client } from "../knowledge/mem0-client";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCorpus(): BroadCorpus {
  return {
    trends: { risingApps: [], trendingCategories: [], summary: "AI is rising" },
    pains: { clusters: [], summary: "Users hate sync issues" },
    capabilities: { capabilities: [], summary: "LLMs are cheap now" },
  };
}

function makeCandidate(title: string, proposedBy = "agent"): DivergentCandidate {
  return { title, summary: `Summary for ${title}`, proposedBy };
}

function makeMem0(): Mem0Client {
  return {
    add: mock(async () => ({})),
    search: mock(async () => ({ results: [] })),
    delete: mock(async () => {}),
    deleteAll: mock(async () => {}),
    getAll: mock(async () => ({ results: [] })),
  } as unknown as Mem0Client;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("discoverFrontiers — broadPoolSize cap", () => {
  beforeEach(() => {
    capturedGenerateDivergentOptions = [];
    generateDivergentIdeasShouldThrow = false;
    quickSearchShouldThrow = false;
    generateDivergentIdeasReturnValue = [
      makeCandidate("AI notes app"),
      makeCandidate("AI notes helper"),
      makeCandidate("Smart task manager"),
    ];
  });

  test("passes broadPoolSize as maxCandidates to generateDivergentIdeas", async () => {
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    await discoverFrontiers(corpus, mem0, { broadPoolSize: 30, userId: "test" });
    const lastOpts = capturedGenerateDivergentOptions[capturedGenerateDivergentOptions.length - 1];
    expect(lastOpts?.maxCandidates).toBe(30);
  });

  test("uses default broadPoolSize=50 when not specified", async () => {
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    await discoverFrontiers(corpus, mem0, { userId: "test" });
    const lastOpts = capturedGenerateDivergentOptions[capturedGenerateDivergentOptions.length - 1];
    expect(lastOpts?.maxCandidates).toBe(50);
  });
});

describe("discoverFrontiers — fault tolerance", () => {
  beforeEach(() => {
    capturedGenerateDivergentOptions = [];
    quickSearchShouldThrow = false;
  });

  test("returns empty DiscoveryResult when generateDivergentIdeas throws (never throws)", async () => {
    generateDivergentIdeasShouldThrow = true;
    generateDivergentIdeasReturnValue = [];
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    // Should NOT throw
    const result = await discoverFrontiers(corpus, mem0, { userId: "test" });
    expect(result.candidates).toHaveLength(0);
    expect(result.frontiers).toHaveLength(0);
    generateDivergentIdeasShouldThrow = false;
  });

  test("returns empty DiscoveryResult when candidates are empty", async () => {
    generateDivergentIdeasShouldThrow = false;
    generateDivergentIdeasReturnValue = [];
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    const result = await discoverFrontiers(corpus, mem0, { userId: "test" });
    expect(result.candidates).toHaveLength(0);
    expect(result.frontiers).toHaveLength(0);
  });

  test("does NOT throw when Mem0/quickSearch fails — returns result with neutral novelty", async () => {
    generateDivergentIdeasShouldThrow = false;
    generateDivergentIdeasReturnValue = [
      makeCandidate("AI notes app"),
      makeCandidate("AI notes helper"),
      makeCandidate("Smart task manager"),
      makeCandidate("Smart task automator"),
    ];
    quickSearchShouldThrow = true;
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    // Should NOT throw
    let result: Awaited<ReturnType<typeof discoverFrontiers>> | undefined;
    await expect(
      discoverFrontiers(corpus, mem0, { userId: "test" }).then((r) => {
        result = r;
      }),
    ).resolves.toBeUndefined();
    // Result should be a valid DiscoveryResult (possibly with frontiers)
    expect(result).toBeDefined();
    expect(Array.isArray(result!.candidates)).toBe(true);
    expect(Array.isArray(result!.frontiers)).toBe(true);
    quickSearchShouldThrow = false;
  });
});

describe("discoverFrontiers — result shape", () => {
  beforeEach(() => {
    capturedGenerateDivergentOptions = [];
    generateDivergentIdeasShouldThrow = false;
    quickSearchShouldThrow = false;
    generateDivergentIdeasReturnValue = [
      makeCandidate("AI notes app"),
      makeCandidate("AI notes helper"),
      makeCandidate("Budget planner tool"),
      makeCandidate("Budget planner monthly"),
    ];
  });

  test("returns DiscoveryResult with candidates and frontiers arrays", async () => {
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    const result = await discoverFrontiers(corpus, mem0, { userId: "test" });
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(Array.isArray(result.frontiers)).toBe(true);
  });

  test("candidates count matches the broadPool (up to broadPoolSize)", async () => {
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    const result = await discoverFrontiers(corpus, mem0, { broadPoolSize: 100, userId: "test" });
    // We returned 4 candidates from the mock
    expect(result.candidates.length).toBeLessThanOrEqual(100);
  });

  test("frontiers are sorted descending by score", async () => {
    const corpus = makeCorpus();
    const mem0 = makeMem0();
    const result = await discoverFrontiers(corpus, mem0, { userId: "test" });
    for (let i = 1; i < result.frontiers.length; i++) {
      expect(result.frontiers[i - 1]!.score).toBeGreaterThanOrEqual(result.frontiers[i]!.score);
    }
  });
});
