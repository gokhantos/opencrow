import { test, expect, describe } from "bun:test";
import {
  normalizeTitle,
  buildValidSignalTokens,
  verifyCandidateEvidence,
  verifyEvidence,
  computeOriginality,
  nearestProductLabel,
  annotateOriginality,
  KNOWN_PRODUCT_KINDS,
} from "./validate";
import type { Capability, GeneratedIdeaCandidate } from "./types";
import type {
  MemoryManager,
  SearchOptions,
  SearchResult,
} from "../../memory/types";

// ── Test fixtures ───────────────────────────────────────────────────────────

function cap(source: string, title: string): Capability {
  return {
    title,
    source,
    url: `https://example.com/${title}`,
    description: title,
    type: "new_tech",
  };
}

function candidate(
  title: string,
  supportingSignalIds?: readonly string[],
): GeneratedIdeaCandidate {
  return {
    title,
    summary: `${title} summary`,
    reasoning: "r",
    designDescription: "d",
    monetizationDetail: "m",
    sourceLinks: [],
    sourcesUsed: "s",
    category: "mobile_app",
    qualityScore: 4,
    targetAudience: "a",
    keyFeatures: ["f"],
    revenueModel: "rm",
    trendIntersection: "ti",
    ...(supportingSignalIds ? { supportingSignalIds } : {}),
  };
}

// ── normalizeTitle ──────────────────────────────────────────────────────────

describe("normalizeTitle", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeTitle("  Quiet-Hours!!  App  ")).toBe("quiethours app");
  });

  test("is idempotent", () => {
    const once = normalizeTitle("Foo: Bar");
    expect(normalizeTitle(once)).toBe(once);
  });
});

// ── buildValidSignalTokens ──────────────────────────────────────────────────

describe("buildValidSignalTokens", () => {
  test("builds <source>_<index> tokens over capability ordering", () => {
    const tokens = buildValidSignalTokens([
      cap("hackernews", "A"),
      cap("producthunt", "B"),
      cap("github", "C"),
    ]);
    expect(tokens.has("hackernews_0")).toBe(true);
    expect(tokens.has("producthunt_1")).toBe(true);
    expect(tokens.has("github_2")).toBe(true);
    expect(tokens.has("hackernews_1")).toBe(false);
  });

  test("slugifies non-alphanumeric source names", () => {
    const tokens = buildValidSignalTokens([cap("Hacker News!", "A")]);
    expect(tokens.has("hacker_news_0")).toBe(true);
  });

  test("empty capabilities yields empty token set", () => {
    expect(buildValidSignalTokens([]).size).toBe(0);
  });
});

// ── verifyCandidateEvidence ─────────────────────────────────────────────────

describe("verifyCandidateEvidence", () => {
  const valid = new Set(["hackernews_0", "producthunt_1"]);

  test("no citations → neutral grounding, unchanged candidate", () => {
    const c = candidate("NoCite");
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(1);
    expect(r.fabricated).toEqual([]);
    expect(r.candidate).toBe(c);
  });

  test("all citations real → grounding 1, none dropped", () => {
    const c = candidate("AllReal", ["hackernews_0", "producthunt_1"]);
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(1);
    expect(r.fabricated).toEqual([]);
    expect(r.candidate.supportingSignalIds).toEqual(["hackernews_0", "producthunt_1"]);
  });

  test("partial fabrication → fractional grounding, fabricated stripped", () => {
    const c = candidate("Partial", ["hackernews_0", "ghost_9"]);
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(0.5);
    expect(r.fabricated).toEqual(["ghost_9"]);
    expect(r.candidate.supportingSignalIds).toEqual(["hackernews_0"]);
  });

  test("fully fabricated → grounding 0", () => {
    const c = candidate("Fake", ["ghost_9", "fake_3"]);
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(0);
    expect(r.fabricated).toEqual(["ghost_9", "fake_3"]);
  });

  test("token matching is case-insensitive", () => {
    const r = verifyCandidateEvidence(candidate("CaseTest", ["HACKERNEWS_0"]), valid);
    expect(r.signalGrounding).toBe(1);
  });

  test("does not mutate the input candidate", () => {
    const c = candidate("NoMutate", ["hackernews_0", "ghost_9"]);
    const snapshot = [...(c.supportingSignalIds ?? [])];
    verifyCandidateEvidence(c, valid);
    expect(c.supportingSignalIds).toEqual(snapshot);
  });
});

// ── verifyEvidence (batch) ──────────────────────────────────────────────────

describe("verifyEvidence", () => {
  const capabilities = [cap("hackernews", "A"), cap("producthunt", "B")];

  test("keeps all candidates (annotate-don't-drop); penalizes unverified grounding", () => {
    const result = verifyEvidence(
      [
        candidate("Grounded", ["hackernews_0"]),
        candidate("Unverified", ["ghost_9"]),
        candidate("NoCite"),
      ],
      capabilities,
    );

    const titles = result.kept.map((c) => c.title);
    // No candidate is dropped — even fully-unverified citations are kept.
    expect(titles).toContain("Grounded");
    expect(titles).toContain("NoCite");
    expect(titles).toContain("Unverified");
    // The unverified one is penalized to grounding 0 and noted.
    expect(result.groundingByTitle.get("Unverified")).toBe(0);
    expect(result.notes.some((n) => n.includes("UNVERIFIED"))).toBe(true);
  });

  test("empty token set (no capabilities) → keep all, neutral grounding", () => {
    const result = verifyEvidence(
      [candidate("LandscapeOnly", ["starbucks_ios_rating"])],
      [],
    );
    expect(result.kept.map((c) => c.title)).toContain("LandscapeOnly");
    expect(result.groundingByTitle.get("LandscapeOnly")).toBe(0.5);
  });

  test("records grounding scores by title for kept candidates", () => {
    const result = verifyEvidence(
      [candidate("Half", ["hackernews_0", "ghost_1"])],
      capabilities,
    );
    expect(result.groundingByTitle.get("Half")).toBe(0.5);
  });

  test("empty input yields empty output", () => {
    const result = verifyEvidence([], capabilities);
    expect(result.kept).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.groundingByTitle.size).toBe(0);
  });
});

// ── computeOriginality (pure math) ──────────────────────────────────────────

describe("computeOriginality", () => {
  test("empty similarities → neutral 1 (no prior art found)", () => {
    expect(computeOriginality([])).toBe(1);
  });

  test("uses MAX similarity (nearest neighbor), not mean", () => {
    // mean would be 0.5 → originality 0.5; max is 0.9 → originality 0.1.
    expect(computeOriginality([0.1, 0.9])).toBeCloseTo(0.1, 10);
  });

  test("near-identical product → originality near 0", () => {
    expect(computeOriginality([0.98])).toBeCloseTo(0.02, 10);
  });

  test("distant product → high originality", () => {
    expect(computeOriginality([0.2])).toBeCloseTo(0.8, 10);
  });

  test("clamps to [0, 1] for out-of-range similarities", () => {
    expect(computeOriginality([1.4])).toBe(0);
    expect(computeOriginality([-0.3])).toBe(1);
  });
});

// ── nearestProductLabel (pure) ──────────────────────────────────────────────

function searchResult(
  content: string,
  score: number,
  metadata: Record<string, string> = {},
): SearchResult {
  return {
    chunk: {
      id: "c1",
      sourceId: "s1",
      content,
      chunkIndex: 0,
      tokenCount: 1,
      createdAt: 0,
    },
    score,
    source: {
      id: "s1",
      kind: "producthunt_product",
      agentId: "shared",
      channel: null,
      chatId: null,
      metadata,
      createdAt: 0,
    },
  };
}

describe("nearestProductLabel", () => {
  test("prefers metadata.title when present", () => {
    const r = searchResult("ignored content", 0.5, { title: "Acme Inc" });
    expect(nearestProductLabel(r)).toBe("Acme Inc");
  });

  test("falls back to product-name prefix of chunk content", () => {
    const r = searchResult(
      "Notion (#3, 1200 votes): the all-in-one workspace\nLong description...",
      0.5,
    );
    expect(nearestProductLabel(r)).toBe("Notion (#3, 1200 votes)");
  });

  test("handles app-ranking style chunk content", () => {
    const r = searchResult(
      "[appstore] Calm by Calm.com | Category: Health\nMeditation app",
      0.5,
    );
    expect(nearestProductLabel(r)).toBe(
      "[appstore] Calm by Calm.com | Category",
    );
  });

  test("empty content → unknown product", () => {
    expect(nearestProductLabel(searchResult("", 0.5))).toBe("unknown product");
  });
});

// ── annotateOriginality (orchestration, injected memory) ────────────────────

function fakeMemory(
  handler: (query: string, opts?: SearchOptions) => readonly SearchResult[],
): MemoryManager {
  const search: MemoryManager["search"] = async (_agentId, query, opts) =>
    handler(query, opts);
  return { search } as unknown as MemoryManager;
}

describe("annotateOriginality", () => {
  test("no memory manager → neutral originality 1, no nearestProduct", async () => {
    const out = await annotateOriginality([candidate("Solo")], null);
    expect(out[0]!.originality).toBe(1);
    expect(out[0]!.nearestProduct).toBeUndefined();
  });

  test("empty search results → neutral originality, no nearestProduct", async () => {
    const mem = fakeMemory(() => []);
    const out = await annotateOriginality([candidate("Novel")], mem);
    expect(out[0]!.originality).toBe(1);
    expect(out[0]!.nearestProduct).toBeUndefined();
  });

  test("annotates originality + nearestProduct from nearest hit", async () => {
    const mem = fakeMemory(() => [
      searchResult("FarApp: unrelated", 0.3),
      searchResult("CloseApp (#1): twin product", 0.85),
    ]);
    const out = await annotateOriginality([candidate("Twin")], mem);
    expect(out[0]!.originality).toBeCloseTo(0.15, 10);
    expect(out[0]!.nearestProduct).toBe("CloseApp (#1)");
    expect(out[0]!.nearestSimilarity).toBe(0.85);
  });

  test("searches ONLY the known-product corpus kinds", async () => {
    let seenKinds: readonly string[] | undefined;
    const mem = fakeMemory((_q, opts) => {
      seenKinds = opts?.kinds;
      return [];
    });
    await annotateOriginality([candidate("Probe")], mem);
    expect(seenKinds).toEqual(KNOWN_PRODUCT_KINDS);
  });

  test("graceful: search throws → neutral originality, candidate kept", async () => {
    const mem = fakeMemory(() => {
      throw new Error("qdrant down");
    });
    const out = await annotateOriginality([candidate("Resilient")], mem);
    expect(out).toHaveLength(1);
    expect(out[0]!.originality).toBe(1);
    expect(out[0]!.title).toBe("Resilient");
  });

  test("does not drop candidates and preserves order", async () => {
    const mem = fakeMemory((q) =>
      q.startsWith("B") ? [searchResult("Dup: x", 0.9)] : [],
    );
    const out = await annotateOriginality(
      [candidate("A"), candidate("B"), candidate("C")],
      mem,
    );
    expect(out.map((c) => c.title)).toEqual(["A", "B", "C"]);
    expect(out[0]!.originality).toBe(1);
    expect(out[1]!.originality).toBeCloseTo(0.1, 10);
    expect(out[2]!.originality).toBe(1);
  });

  test("does not mutate the input candidate", async () => {
    const c = candidate("Immutable");
    const mem = fakeMemory(() => [searchResult("X: y", 0.7)]);
    await annotateOriginality([c], mem);
    expect("originality" in c).toBe(false);
  });
});
