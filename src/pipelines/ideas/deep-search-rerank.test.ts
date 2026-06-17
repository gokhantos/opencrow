import { test, expect, describe } from "bun:test";
import {
  candidateText,
  embeddingRerank,
  llmListwiseRerank,
  type RerankCandidate,
} from "./deep-search-rerank";
import type { SearchResult } from "../../memory/types";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeHit(id: string, title: string, content: string, score: number): SearchResult {
  return {
    score,
    chunk: {
      id: `chunk-${id}`,
      sourceId: id,
      content,
      chunkIndex: 0,
      tokenCount: 0,
      createdAt: 0,
    },
    source: {
      id,
      kind: "hackernews_story",
      agentId: "shared",
      channel: null,
      chatId: null,
      metadata: { title },
      createdAt: 0,
    },
  };
}

function candidate(id: string, title: string, content: string): RerankCandidate {
  const hit = makeHit(id, title, content, 0.5);
  return { hit, text: candidateText(hit) };
}

// ── candidateText ──────────────────────────────────────────────────────────

describe("candidateText", () => {
  test("combines title and body", () => {
    const hit = makeHit("a", "My Title", "Body content here", 0.5);
    expect(candidateText(hit)).toBe("My Title Body content here");
  });

  test("handles missing title", () => {
    const hit = makeHit("a", "", "just body", 0.5);
    expect(candidateText(hit)).toBe("just body");
  });

  test("truncates long body to 300 chars", () => {
    const hit = makeHit("a", "T", "x".repeat(500), 0.5);
    // "T " + 300 chars
    expect(candidateText(hit).length).toBe(302);
  });
});

// ── embeddingRerank (short-circuit, no embedder call) ──────────────────────

describe("embeddingRerank short-circuit", () => {
  test("returns empty for empty input without calling embedder", async () => {
    let called = false;
    const embedder = {
      embed: async () => {
        called = true;
        return [];
      },
    };
    const out = await embeddingRerank("theme", [], 6, embedder);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns input unchanged when count <= topK without embedding", async () => {
    let called = false;
    const embedder = {
      embed: async () => {
        called = true;
        return [];
      },
    };
    const cands = [candidate("a", "A", "x"), candidate("b", "B", "y")];
    const out = await embeddingRerank("theme", cands, 6, embedder);
    expect(out).toBe(cands);
    expect(called).toBe(false);
  });

  test("ranks by cosine similarity when over-fetched", async () => {
    const themeVec = new Float32Array([1, 0]);
    // c0 orthogonal, c1 aligned, c2 anti-aligned
    const vecs = [
      themeVec,
      new Float32Array([0, 1]),
      new Float32Array([1, 0]),
      new Float32Array([-1, 0]),
    ];
    const embedder = { embed: async () => vecs };
    const cands = [candidate("c0", "C0", "a"), candidate("c1", "C1", "b"), candidate("c2", "C2", "c")];
    const out = await embeddingRerank("theme", cands, 2, embedder);
    expect(out.length).toBe(2);
    // most aligned (c1) first, then orthogonal (c0); anti-aligned (c2) dropped
    expect(out[0]?.hit.source.id).toBe("c1");
    expect(out[1]?.hit.source.id).toBe("c0");
  });

  test("degrades to input order when embedder throws", async () => {
    const embedder = {
      embed: async () => {
        throw new Error("boom");
      },
    };
    const cands = [candidate("a", "A", "x"), candidate("b", "B", "y"), candidate("c", "C", "z")];
    const out = await embeddingRerank("theme", cands, 2, embedder);
    expect(out.map((c) => c.hit.source.id)).toEqual(["a", "b"]);
  });
});

// ── llmListwiseRerank (short-circuit, no chat call) ────────────────────────

describe("llmListwiseRerank short-circuit", () => {
  test("returns empty for empty input", async () => {
    const out = await llmListwiseRerank("theme", [], 6, "model");
    expect(out).toEqual([]);
  });

  test("returns input unchanged when count <= topK", async () => {
    const cands = [candidate("a", "A", "x")];
    const out = await llmListwiseRerank("theme", cands, 6, "model");
    expect(out).toBe(cands);
  });
});
