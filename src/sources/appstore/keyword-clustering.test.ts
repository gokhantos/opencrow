import { describe, expect, it } from "bun:test";
import type { EmbeddingProvider } from "../../memory/types";
import {
  clusterByCosine,
  isClusterableKeyword,
  l2Normalize,
  pickClusterLabel,
  runKeywordClustering,
  stripToConceptResidual,
  type ClusterAssignmentRow,
  type ClusterItem,
  type RawCandidate,
} from "./keyword-clustering";

function vec(...nums: number[]): Float32Array {
  return new Float32Array(nums);
}

function item(key: string, ...nums: number[]): ClusterItem {
  return { key, vec: vec(...nums) };
}

describe("l2Normalize", () => {
  it("scales a vector to unit length", () => {
    const unit = l2Normalize(vec(3, 4));
    expect(unit[0]).toBeCloseTo(0.6, 6);
    expect(unit[1]).toBeCloseTo(0.8, 6);
  });

  it("returns a zero vector unchanged (no divide-by-zero)", () => {
    const unit = l2Normalize(vec(0, 0, 0));
    expect(Array.from(unit)).toEqual([0, 0, 0]);
  });
});

describe("clusterByCosine", () => {
  it("groups near-identical vectors into one cluster", () => {
    const clusters = clusterByCosine(
      [item("a", 1, 0, 0), item("b", 1, 0, 0), item("c", 0.99, 0.14, 0)],
      0.9,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(["a", "b", "c"]);
  });

  it("splits orthogonal vectors into separate clusters", () => {
    const clusters = clusterByCosine([item("x", 1, 0), item("y", 0, 1)], 0.5);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.members).toEqual(["x"]);
    expect(clusters[1]?.members).toEqual(["y"]);
  });

  it("is threshold-sensitive: the same pair merges below and splits above their cosine", () => {
    // cos([1,0], [0.8,0.6]) = 0.8.
    const pair: ClusterItem[] = [item("p", 1, 0), item("q", 0.8, 0.6)];

    const merged = clusterByCosine(pair, 0.75);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.members).toEqual(["p", "q"]);

    const split = clusterByCosine(pair, 0.85);
    expect(split).toHaveLength(2);
  });

  it("returns a singleton cluster for a single item", () => {
    const clusters = clusterByCosine([item("solo", 1, 2, 3)], 0.74);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(["solo"]);
  });

  it("returns no clusters for an empty input", () => {
    expect(clusterByCosine([], 0.74)).toEqual([]);
  });

  it("assigns 0-based cluster ids in creation order", () => {
    const clusters = clusterByCosine([item("x", 1, 0), item("y", 0, 1)], 0.9);
    expect(clusters.map((c) => c.clusterId)).toEqual([0, 1]);
  });
});

describe("isClusterableKeyword", () => {
  it("drops sole generic-noise tokens from the extended clustering stoplist", () => {
    for (const junk of ["updated", "update", "updating", "app", "apps", "ios", "iphone", "all", "popular"]) {
      expect(isClusterableKeyword(junk)).toBe(false);
    }
  });

  it("drops multi-word keywords made entirely of generic tokens", () => {
    expect(isClusterableKeyword("best free app")).toBe(false);
    expect(isClusterableKeyword("top new apps")).toBe(false);
  });

  it("drops sub-3-char and numeric/punctuation-only keywords", () => {
    expect(isClusterableKeyword("ab")).toBe(false);
    expect(isClusterableKeyword("42")).toBe(false);
    expect(isClusterableKeyword("  --  ")).toBe(false);
  });

  it("keeps real single- and multi-word concepts", () => {
    for (const good of ["music", "budget planner", "flight tracker", "sleep sounds", "fatty liver diet"]) {
      expect(isClusterableKeyword(good)).toBe(true);
    }
  });

  it("keeps a multi-word keyword even when one token is generic", () => {
    // "budget" is a real token, "app" is generic — not ALL tokens are junk.
    expect(isClusterableKeyword("budget app")).toBe(true);
  });
});

describe("stripToConceptResidual", () => {
  it("drops generic modifier tokens, keeping the concept residual", () => {
    expect(stripToConceptResidual("budget planner app")).toBe("budget planner");
    expect(stripToConceptResidual("best free music app")).toBe("music");
    expect(stripToConceptResidual("flight tracker")).toBe("flight");
    expect(stripToConceptResidual("photo editor pro")).toBe("photo");
  });

  it("keeps concept tokens untouched when there are no generics", () => {
    expect(stripToConceptResidual("fatty liver diet")).toBe("fatty liver diet");
  });

  it("lowercases before stripping", () => {
    expect(stripToConceptResidual("Music APP Player")).toBe("music player");
  });

  it("empties a keyword made entirely of generic tokens", () => {
    for (const pure of ["free app", "the app", "updated", "ios", "what", "best top new"]) {
      expect(stripToConceptResidual(pure)).toBe("");
    }
  });
});

describe("pickClusterLabel", () => {
  const meta = (demand: number, buildability: number): RawCandidate => ({
    keyword: "",
    demand,
    buildability,
  });

  it("picks the highest-demand member", () => {
    const by = new Map<string, RawCandidate>([
      ["a", meta(5, 90)],
      ["b", meta(10, 10)],
      ["c", meta(8, 50)],
    ]);
    expect(pickClusterLabel(["a", "b", "c"], by)).toBe("b");
  });

  it("breaks demand ties by buildability", () => {
    const by = new Map<string, RawCandidate>([
      ["a", meta(10, 20)],
      ["b", meta(10, 55)],
    ]);
    expect(pickClusterLabel(["a", "b"], by)).toBe("b");
  });

  it("falls back to the first member when metadata is missing", () => {
    expect(pickClusterLabel(["only"], new Map())).toBe("only");
  });
});

/** Deterministic fake: "music*" -> [1,0], everything else -> [0,1]. */
function fakeEmbedder(seen: string[]): EmbeddingProvider {
  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      seen.push(...texts);
      return texts.map((t) => (t.includes("music") ? vec(1, 0) : vec(0, 1)));
    },
  };
}

describe("runKeywordClustering", () => {
  it("drops junk + pure-generic noise, embeds residuals, clusters + labels by ORIGINAL keyword", async () => {
    const candidates: RawCandidate[] = [
      // Highest demand but junk — dropped by isClusterableKeyword before embed.
      { keyword: "updated", demand: 100, buildability: 90 },
      // Passes the junk prefilter but its residual is empty (all generic) -> noise.
      { keyword: "the widget maker", demand: 50, buildability: 80 },
      { keyword: "music player", demand: 10, buildability: 50 },
      // Residual "music" (strips "app") -> clusters with the other music keyword.
      { keyword: "music app", demand: 9, buildability: 45 },
      { keyword: "music streaming", demand: 8, buildability: 40 },
      { keyword: "grocery shopping", demand: 5, buildability: 30 },
    ];
    const seenByEmbedder: string[] = [];
    let persisted: readonly ClusterAssignmentRow[] = [];
    let persistedNow = 0;

    const result = await runKeywordClustering({
      embedder: fakeEmbedder(seenByEmbedder),
      loadCandidates: async () => candidates,
      persist: async (rows, now) => {
        persisted = rows;
        persistedNow = now;
      },
      threshold: 0.78,
      now: () => 1_700_000_000,
    });

    // The embedder saw RESIDUALS, not raw keywords: "music app" -> "music".
    expect(seenByEmbedder).not.toContain("updated");
    expect(seenByEmbedder).not.toContain("the widget maker");
    expect(seenByEmbedder).toEqual(["music player", "music", "music streaming", "grocery shopping"]);

    expect(result.fetched).toBe(6);
    expect(result.droppedAsJunk).toBe(1); // "updated"
    expect(result.droppedAsNoise).toBe(1); // "the widget maker"
    expect(result.embedded).toBe(4);
    expect(result.clusterCount).toBe(2);
    expect(result.assignmentCount).toBe(4);

    // Members + label are always the ORIGINAL keyword, never the residual.
    const byKeyword = new Map(persisted.map((r) => [r.keyword, r]));
    expect(byKeyword.has("music app")).toBe(true);
    expect(byKeyword.has("music")).toBe(false);
    expect(byKeyword.has("the widget maker")).toBe(false);

    const musicPlayer = byKeyword.get("music player");
    const musicApp = byKeyword.get("music app");
    const musicStreaming = byKeyword.get("music streaming");
    const grocery = byKeyword.get("grocery shopping");
    expect(musicPlayer?.clusterId).toBe(musicApp?.clusterId);
    expect(musicPlayer?.clusterId).toBe(musicStreaming?.clusterId);
    expect(grocery?.clusterId).not.toBe(musicPlayer?.clusterId);

    // Label = highest-demand ORIGINAL member of each cluster.
    expect(musicPlayer?.clusterLabel).toBe("music player");
    expect(musicApp?.clusterLabel).toBe("music player");
    expect(grocery?.clusterLabel).toBe("grocery shopping");

    // Similarity to centroid is a real [0,1] cosine (identical vectors -> ~1).
    expect(musicPlayer?.similarity).toBeCloseTo(1, 5);
    expect(grocery?.similarity).toBeCloseTo(1, 5);

    expect(persistedNow).toBe(1_700_000_000);
  });

  it("persists an empty assignment set when no candidate is clusterable", async () => {
    let persistedLen = -1;
    const result = await runKeywordClustering({
      embedder: fakeEmbedder([]),
      loadCandidates: async () => [{ keyword: "updated", demand: 5, buildability: 5 }],
      persist: async (rows) => {
        persistedLen = rows.length;
      },
    });
    expect(result.clusterCount).toBe(0);
    expect(persistedLen).toBe(0);
  });
});
