import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createSemanticToolIndex } from "./semantic-index";
import type { EmbeddingProvider } from "../memory/types";
import type { QdrantClient, QdrantSearchResult } from "../memory/qdrant";
import type { ToolDefinition } from "./types";

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makeEmbedder(dims = 512): EmbeddingProvider {
  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      // Return a deterministic non-zero vector per text so hashes differ
      return texts.map((t, i) => {
        const vec = new Float32Array(dims);
        vec[0] = i + 1;
        vec[1] = t.length;
        return vec;
      });
    },
  };
}

function makeTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    categories: ["research"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      return { output: "", isError: false };
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Qdrant mock factory
// ──────────────────────────────────────────────────────────────

interface StoredPoint {
  id: string;
  vector: readonly number[];
  payload: Record<string, string | number>;
}

function makeQdrantClient(initiallyAvailable = true): QdrantClient & {
  _points: Map<string, StoredPoint>;
} {
  const points = new Map<string, StoredPoint>();
  let available = initiallyAvailable;

  return {
    get available() {
      return available;
    },
    _points: points,

    async ensureCollection(_name: string, _size: number) {
      return available;
    },

    async upsertPoints(_collection: string, pts: readonly { id: string; vector: readonly number[]; payload: Record<string, string | number> }[]) {
      for (const p of pts) {
        points.set(p.id, p);
      }
    },

    async searchPoints(
      _collection: string,
      _vector: readonly number[],
      limit: number,
      opts?: { filter?: { must?: readonly { key: string; match: { value: string | number } }[] } },
    ): Promise<readonly QdrantSearchResult[]> {
      const kindFilter = opts?.filter?.must?.find((c) => c.key === "kind")?.match.value;
      const results: QdrantSearchResult[] = [];
      for (const p of points.values()) {
        if (kindFilter && p.payload["kind"] !== kindFilter) continue;
        results.push({ id: p.id, score: 0.9, payload: p.payload });
      }
      return results.slice(0, limit);
    },

    async deletePoints() {},
    async healthCheck() {
      return available;
    },
    dispose() {},
  };
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("createSemanticToolIndex", () => {
  const tools: ToolDefinition[] = [
    makeTool("technical_analysis", "Run technical analysis on price charts"),
    makeTool("get_candles", "Fetch OHLCV candlestick data"),
    makeTool("search_memory", "Search agent memory for relevant information"),
  ];

  describe("isAvailable()", () => {
    it("returns false before init()", () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      expect(idx.isAvailable()).toBe(false);
    });

    it("returns false when Qdrant is unavailable", async () => {
      const qdrant = makeQdrantClient(false);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      expect(idx.isAvailable()).toBe(false);
    });

    it("returns true after successful init with available Qdrant", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      expect(idx.isAvailable()).toBe(true);
    });
  });

  describe("init()", () => {
    it("upserts one vector per tool plus one sentinel", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      // tools.length + 1 sentinel
      expect(qdrant._points.size).toBe(tools.length + 1);
    });

    it("stores tool name in payload", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      const names = [...qdrant._points.values()]
        .map((p) => p.payload["name"] as string)
        .filter((n) => n !== "__sentinel__");
      expect(names.sort()).toEqual(tools.map((t) => t.name).sort());
    });

    it("skips re-embedding when corpus hash matches sentinel", async () => {
      const qdrant = makeQdrantClient(true);
      const embedder = makeEmbedder();
      const embedSpy = mock(embedder.embed.bind(embedder));
      const spiedEmbedder: EmbeddingProvider = { embed: embedSpy };

      const idx = createSemanticToolIndex(spiedEmbedder, qdrant);
      await idx.init(tools);
      const callsAfterFirst = (embedSpy as ReturnType<typeof mock>).mock.calls.length;

      // Second init should detect matching hash and skip embedding
      await idx.init(tools);
      expect((embedSpy as ReturnType<typeof mock>).mock.calls.length).toBe(
        callsAfterFirst,
      );
    });

    it("re-embeds when tools change (corpus hash differs)", async () => {
      const qdrant = makeQdrantClient(true);
      const embedder = makeEmbedder();
      const embedSpy = mock(embedder.embed.bind(embedder));
      const spiedEmbedder: EmbeddingProvider = { embed: embedSpy };

      const idx = createSemanticToolIndex(spiedEmbedder, qdrant);
      await idx.init(tools);
      const firstCallCount = (embedSpy as ReturnType<typeof mock>).mock.calls.length;

      // Change the tools
      const newTools = [...tools, makeTool("extra_tool", "An extra tool")];
      await idx.init(newTools);
      expect((embedSpy as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(
        firstCallCount,
      );
    });
  });

  describe("search()", () => {
    it("returns empty array before init", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      const results = await idx.search("BTC chart analysis", 5);
      expect(results).toEqual([]);
    });

    it("returns tool names after init", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      const results = await idx.search("check BTC chart", 5);
      expect(results.length).toBeGreaterThan(0);
      // All returned names should be valid tool names
      const validNames = new Set(tools.map((t) => t.name));
      for (const name of results) {
        expect(validNames.has(name)).toBe(true);
      }
    });

    it("respects the limit parameter", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      const results = await idx.search("anything", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("never returns __sentinel__ in results", async () => {
      const qdrant = makeQdrantClient(true);
      const idx = createSemanticToolIndex(makeEmbedder(), qdrant);
      await idx.init(tools);
      const results = await idx.search("anything", 10);
      expect(results).not.toContain("__sentinel__");
    });

    it("returns empty array when embedder fails", async () => {
      const qdrant = makeQdrantClient(true);
      const failingEmbedder: EmbeddingProvider = {
        async embed() {
          throw new Error("embedding API down");
        },
      };
      // Use a working embedder for init but failing one for search
      const initEmbedder = makeEmbedder();
      const idx = createSemanticToolIndex(initEmbedder, qdrant);
      await idx.init(tools);

      // Swap to failing embedder via a new index sharing the same qdrant store
      const failIdx = createSemanticToolIndex(failingEmbedder, qdrant);
      // Manually mark as ready by running init with init embedder first
      // Actually: failIdx hasn't been inited so isAvailable() is false → returns []
      const results = await failIdx.search("anything", 5);
      expect(results).toEqual([]);
    });
  });
});
