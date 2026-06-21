/**
 * Unit tests for clusterIntoFrontiersSemantic (embedding-based frontier
 * clustering) and the discoverFrontiers semantic→lexical fallback seam.
 *
 * NO mock.module: a FAKE embedder returning hand-crafted Float32Array vectors is
 * injected directly, so the tests stay in the unit lane (no DB / LLM / model).
 */
import { describe, expect, test } from "bun:test";
import { clusterIntoFrontiersSemantic, type FrontierEmbedder } from "./frontier-discovery";
import type { DivergentCandidate } from "../run";

function makeCandidate(title: string, summary = "A great idea"): DivergentCandidate {
  return { title, summary, proposedBy: "rational_player" };
}

/**
 * Fake embedder driven by an explicit text→vector map. Deterministic, no I/O.
 * Falls back to a zero vector for unmapped texts (never thrown).
 */
function fakeEmbedder(vecByText: Map<string, readonly number[]>, dim = 2): FrontierEmbedder {
  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = vecByText.get(t) ?? new Array(dim).fill(0);
        return new Float32Array(v);
      });
    },
  };
}

/** Build the embed text exactly as clusterIntoFrontiersSemantic does. */
function embedText(c: DivergentCandidate): string {
  return `${c.title}. ${c.summary}`.slice(0, 512);
}

describe("clusterIntoFrontiersSemantic", () => {
  test("splits two well-separated vector groups into 2 frontiers (titles share no words)", async () => {
    // Group A near [1, 0]; Group B near [0, 1]. Titles deliberately share no
    // tokens, so the LEXICAL clusterer would collapse them — semantic must not.
    const a1 = makeCandidate("Quantum ledger reconciler");
    const a2 = makeCandidate("Atomic ledger settlement engine");
    const b1 = makeCandidate("Garden moisture whisperer");
    const b2 = makeCandidate("Soil hydration coach for plants");

    const vecs = new Map<string, readonly number[]>([
      [embedText(a1), [1, 0]],
      [embedText(a2), [0.97, 0.03]],
      [embedText(b1), [0, 1]],
      [embedText(b2), [0.04, 0.99]],
    ]);

    const frontiers = await clusterIntoFrontiersSemantic(
      [a1, b1, a2, b2],
      fakeEmbedder(vecs),
      { maxFrontiers: 8, similarityThreshold: 0.62 },
    );

    expect(frontiers).toHaveLength(2);
    const titleSets = frontiers.map((f) => f.candidates.map((c) => c.title).sort());
    // One frontier holds the two "ledger" ideas, the other the two "plant" ideas.
    expect(titleSets).toContainEqual(
      ["Atomic ledger settlement engine", "Quantum ledger reconciler"].sort(),
    );
    expect(titleSets).toContainEqual(
      ["Garden moisture whisperer", "Soil hydration coach for plants"].sort(),
    );
  });

  test("respects maxFrontiers cap — extras fold into nearest, nothing dropped", async () => {
    // 4 distinct groups but cap = 2: the 3rd/4th candidate must fold into the
    // nearest existing cluster, never be dropped.
    const c0 = makeCandidate("Alpha one");
    const c1 = makeCandidate("Beta two");
    const c2 = makeCandidate("Gamma three"); // near c0
    const c3 = makeCandidate("Delta four"); // near c1

    const vecs = new Map<string, readonly number[]>([
      [embedText(c0), [1, 0]],
      [embedText(c1), [0, 1]],
      [embedText(c2), [0.9, 0.1]], // closest to c0's cluster
      [embedText(c3), [0.1, 0.9]], // closest to c1's cluster
    ]);

    const frontiers = await clusterIntoFrontiersSemantic(
      [c0, c1, c2, c3],
      fakeEmbedder(vecs),
      { maxFrontiers: 2, similarityThreshold: 0.99 }, // high threshold forces capping
    );

    expect(frontiers).toHaveLength(2);
    const totalMembers = frontiers.reduce((n, f) => n + f.candidates.length, 0);
    expect(totalMembers).toBe(4); // never drops a candidate
  });

  test("allows singletons (minClusterSize default 1) — many distinct themes survive", async () => {
    const c0 = makeCandidate("Solo one");
    const c1 = makeCandidate("Solo two");
    const c2 = makeCandidate("Solo three");

    const vecs = new Map<string, readonly number[]>([
      [embedText(c0), [1, 0]],
      [embedText(c1), [0, 1]],
      [embedText(c2), [-1, 0]],
    ]);

    const frontiers = await clusterIntoFrontiersSemantic(
      [c0, c1, c2],
      fakeEmbedder(vecs),
      { maxFrontiers: 8, similarityThreshold: 0.62 },
    );

    expect(frontiers).toHaveLength(3);
    for (const f of frontiers) expect(f.candidates).toHaveLength(1);
  });

  test("medoid labelling — theme equals the central candidate's title", async () => {
    // Symmetric edges around a central member: c0/c2 sit at +/-θ off the axis,
    // c1 sits exactly ON the running-mean centroid direction, so c1 is the
    // medoid (closest to the centroid) and must become the theme label.
    const c0 = makeCandidate("Edge member low");
    const c1 = makeCandidate("Central pivot idea");
    const c2 = makeCandidate("Edge member high");

    const vecs = new Map<string, readonly number[]>([
      [embedText(c0), [1, 0.2]],
      [embedText(c1), [1, 0.1]], // on the eventual mean direction
      [embedText(c2), [1, 0]],
    ]);

    const frontiers = await clusterIntoFrontiersSemantic(
      [c0, c1, c2],
      fakeEmbedder(vecs),
      { maxFrontiers: 8, similarityThreshold: 0.5 },
    );

    expect(frontiers).toHaveLength(1);
    expect(frontiers[0]?.theme).toBe("Central pivot idea");
    expect(frontiers[0]?.themeKeys).toContain("central");
  });

  test("filters blank-titled candidates before embedding", async () => {
    const blank = makeCandidate("   ");
    const real = makeCandidate("Real idea");
    const vecs = new Map<string, readonly number[]>([[embedText(real), [1, 0]]]);

    const frontiers = await clusterIntoFrontiersSemantic(
      [blank, real],
      fakeEmbedder(vecs),
      { maxFrontiers: 8, similarityThreshold: 0.62 },
    );

    expect(frontiers).toHaveLength(1);
    expect(frontiers[0]?.candidates.map((c) => c.title)).toEqual(["Real idea"]);
  });

  test("throws on vector/candidate count mismatch (caller falls back to lexical)", async () => {
    const c0 = makeCandidate("Idea one");
    const c1 = makeCandidate("Idea two");
    const shortEmbedder: FrontierEmbedder = {
      async embed(): Promise<Float32Array[]> {
        return [new Float32Array([1, 0])]; // 1 vector for 2 candidates
      },
    };

    await expect(
      clusterIntoFrontiersSemantic([c0, c1], shortEmbedder, {
        maxFrontiers: 8,
        similarityThreshold: 0.62,
      }),
    ).rejects.toThrow();
  });

  test("does not mutate the input candidates array", async () => {
    const input = [makeCandidate("One"), makeCandidate("Two")];
    const snapshot = [...input];
    const vecs = new Map<string, readonly number[]>([
      [embedText(input[0]!), [1, 0]],
      [embedText(input[1]!), [0, 1]],
    ]);

    await clusterIntoFrontiersSemantic(input, fakeEmbedder(vecs), {
      maxFrontiers: 8,
      similarityThreshold: 0.62,
    });

    expect(input).toEqual(snapshot);
  });

  test("a throwing embedder propagates (so the orchestrator can fall back)", async () => {
    const throwing: FrontierEmbedder = {
      async embed(): Promise<Float32Array[]> {
        throw new Error("embed boom");
      },
    };

    await expect(
      clusterIntoFrontiersSemantic([makeCandidate("X")], throwing, {
        maxFrontiers: 8,
        similarityThreshold: 0.62,
      }),
    ).rejects.toThrow("embed boom");
  });
});
