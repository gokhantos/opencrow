import { describe, expect, test } from "bun:test";
import {
  createSemanticDemandProbe,
  SEMANTIC_SIMILARITY_THRESHOLD,
  type SemanticCandidateRow,
  type SemanticRowSource,
} from "./semantic-demand-probe";
import type { CrossEncoderEmbedder } from "./deep-search-rerank";
import { ABSENCE_SCORE_CAP, aggregateDemand, hasCitedDemand } from "./demand";

// ── DI fakes (no DB, no model → stays in the unit lane) ───────────────────────

/** A row source that always returns the canned rows it was constructed with. */
function fakeRowSource(rows: readonly SemanticCandidateRow[]): SemanticRowSource {
  return { async fetchCandidates() { return rows; } };
}

/**
 * Deterministic embedder: returns a hardcoded vector per exact input text, so a
 * test controls the cosine similarity each row gets relative to the idea text.
 * The idea text is `kws.join(" ")`; for the default keywords below that is
 * "invoice reconciliation".
 */
function fakeEmbedder(vectorByText: Record<string, readonly number[]>): CrossEncoderEmbedder {
  return {
    async embed(texts) {
      return texts.map((t) => {
        const v = vectorByText[t.slice(0, 500)] ?? vectorByText[t] ?? [0, 0, 0];
        return Float32Array.from(v);
      });
    },
  };
}

const KEYWORDS = ["invoice", "reconciliation"] as const;
const IDEA_TEXT = KEYWORDS.join(" "); // "invoice reconciliation"

const OPTS = { windowSec: 86_400, limit: 50 };

describe("createSemanticDemandProbe", () => {
  test("(a) rows above the cosine threshold become cited semantic_corpus evidence", async () => {
    const rows: readonly SemanticCandidateRow[] = [
      {
        id: "rp_1",
        text: "We spend days every month matching payments to ledgers by hand.",
        engagement: 40,
      },
    ];
    // Idea vector and the row vector are identical → cosine 1.0 (>= threshold),
    // even though the row text shares NO literal keyword with the idea.
    const sameVec = [1, 0, 0];
    const probe = createSemanticDemandProbe({
      rowSource: fakeRowSource(rows),
      embedder: fakeEmbedder({
        [IDEA_TEXT]: sameVec,
        [rows[0]!.text]: sameVec,
      }),
    });

    const evidence = await probe.probe(KEYWORDS, OPTS);

    expect(evidence).toHaveLength(1);
    const e = evidence[0]!;
    expect(e.kind).toBe("semantic_corpus");
    expect(e.sourceId).toBe("rp_1");
    expect(e.quote && e.quote.length).toBeGreaterThan(0);
    // Quote must be REAL text drawn from the row, never invented.
    expect(rows[0]!.text).toContain(e.quote!.trim());
    expect(e.count).toBeGreaterThan(1); // engagement-weighted (1 + log1p(40))
  });

  test("(b) when nothing clears the threshold → [] (honest absence preserved)", async () => {
    const rows: readonly SemanticCandidateRow[] = [
      { id: "rp_2", text: "Totally unrelated chatter about gardening tools.", engagement: 5 },
    ];
    // Orthogonal vectors → cosine 0, well below the threshold.
    const probe = createSemanticDemandProbe({
      rowSource: fakeRowSource(rows),
      embedder: fakeEmbedder({
        [IDEA_TEXT]: [1, 0, 0],
        [rows[0]!.text]: [0, 1, 0],
      }),
    });

    const evidence = await probe.probe(KEYWORDS, OPTS);
    expect(evidence).toEqual([]);
  });

  test("(b') borderline below threshold is excluded, at/above is included", async () => {
    // Build two rows whose cosine to the idea straddles the threshold.
    const below = SEMANTIC_SIMILARITY_THRESHOLD - 0.05;
    const above = SEMANTIC_SIMILARITY_THRESHOLD + 0.05;
    const rows: readonly SemanticCandidateRow[] = [
      { id: "below", text: "row below threshold text here", engagement: 1 },
      { id: "above", text: "row above threshold text here", engagement: 1 },
    ];
    // With idea = [1,0], a vector [c, sqrt(1-c^2)] has cosine == c to the idea.
    const vec = (c: number): readonly number[] => [c, Math.sqrt(Math.max(0, 1 - c * c))];
    const probe = createSemanticDemandProbe({
      rowSource: fakeRowSource(rows),
      embedder: fakeEmbedder({
        [IDEA_TEXT]: [1, 0],
        [rows[0]!.text]: vec(below),
        [rows[1]!.text]: vec(above),
      }),
    });

    const evidence = await probe.probe(KEYWORDS, OPTS);
    expect(evidence.map((e) => e.sourceId)).toEqual(["above"]);
  });

  test("(c) embedder throwing → [] (graceful, never throws)", async () => {
    const probe = createSemanticDemandProbe({
      rowSource: fakeRowSource([{ id: "x", text: "some text", engagement: 1 }]),
      embedder: {
        async embed() {
          throw new Error("model offline");
        },
      },
    });
    await expect(probe.probe(KEYWORDS, OPTS)).resolves.toEqual([]);
  });

  test("(c) rowSource throwing → [] (graceful)", async () => {
    const probe = createSemanticDemandProbe({
      embedder: fakeEmbedder({ [IDEA_TEXT]: [1, 0, 0] }),
      rowSource: {
        async fetchCandidates() {
          throw new Error("db down");
        },
      },
    });
    await expect(probe.probe(KEYWORDS, OPTS)).resolves.toEqual([]);
  });

  test("(c) embedder factory returning undefined → [] (no provider configured)", async () => {
    const probe = createSemanticDemandProbe({
      embedder: () => undefined,
      rowSource: fakeRowSource([{ id: "x", text: "some text", engagement: 1 }]),
    });
    await expect(probe.probe(KEYWORDS, OPTS)).resolves.toEqual([]);
  });

  test("no usable keywords → [] without touching deps", async () => {
    let touched = false;
    const probe = createSemanticDemandProbe({
      embedder: () => {
        touched = true;
        return undefined;
      },
      rowSource: fakeRowSource([]),
    });
    // All keywords below the len>=3 floor → queryKeywords empties them.
    const evidence = await probe.probe(["a", "b"], OPTS);
    expect(evidence).toEqual([]);
    expect(touched).toBe(false);
  });
});

// ── (d) END-TO-END through the pure scorer ────────────────────────────────────

describe("semantic_corpus evidence lifts demand above the absence cap", () => {
  test("produced evidence → aggregateDemand clears ABSENCE_SCORE_CAP & hasCitedDemand", async () => {
    const rows: readonly SemanticCandidateRow[] = [
      { id: "rp_a", text: "Reconciling payments by hand wastes our whole month.", engagement: 80 },
      { id: "rp_b", text: "Matching ledger entries to bank statements is brutal.", engagement: 30 },
    ];
    const v = [1, 0, 0];
    const probe = createSemanticDemandProbe({
      rowSource: fakeRowSource(rows),
      embedder: fakeEmbedder({
        [IDEA_TEXT]: v,
        [rows[0]!.text]: v,
        [rows[1]!.text]: v,
      }),
    });

    const evidence = await probe.probe(KEYWORDS, OPTS);
    expect(evidence.length).toBe(2);
    expect(evidence.every((e) => e.kind === "semantic_corpus")).toBe(true);

    const artifact = aggregateDemand(evidence);
    expect(artifact.score).toBeGreaterThan(ABSENCE_SCORE_CAP);
    expect(hasCitedDemand(artifact)).toBe(true);
  });

  test("contrast: empty evidence → score pinned at ABSENCE_SCORE_CAP, not cited", () => {
    const artifact = aggregateDemand([]);
    expect(artifact.score).toBe(ABSENCE_SCORE_CAP);
    expect(hasCitedDemand(artifact)).toBe(false);
  });
});
