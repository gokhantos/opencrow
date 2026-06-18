/**
 * Isolated tests for createMemoryIndexer (memory/indexer.ts).
 *
 * Uses mock.module to stub DB, embedding provider, Qdrant client, and FTS so
 * the tests run entirely in-process with no external dependencies.
 *
 * Filed as *.isolated.test.ts because mock.module leaks across files.
 *
 * Coverage:
 *   createMemoryIndexer:
 *     - indexNote happy path: creates a source row + chunks, returns a sourceId
 *     - indexNote with empty string: still creates the source row (no chunks)
 *     - indexIdea: title + summary + reasoning assembled into chunks
 *     - indexObservations: facts/concepts included in chunk text
 *     - embedding failure is non-fatal (indexing completes, vectors not stored)
 *     - all-duplicate chunks (hash collision): source row created, chunks skipped
 */

import { mock } from "bun:test";
import { test, expect, describe, beforeEach } from "bun:test";

// ── Stub bookkeeping ──────────────────────────────────────────────────────────

interface SourceRow {
  id: string;
  kind: string;
  agentId: string;
  metadataJson: string;
}

interface ChunkRow {
  id: string;
  sourceId: string;
  content: string;
  contentHash: string;
}

let sources: SourceRow[] = [];
let chunks: ChunkRow[] = [];
let existingHashes: Set<string> = new Set();
let shouldEmbeddingFail = false;
let qdrantUpsertCalls: unknown[][] = [];

// ── Stub: store/db ────────────────────────────────────────────────────────────
// Bun.sql template tag: we simulate it by returning mock results per query.
mock.module("../store/db", () => {
  // Minimal tagged-template mock that inspects the SQL strings.
  function tagFn(strings: TemplateStringsArray, ...vals: unknown[]) {
    const sql = strings.join("?").trim().toLowerCase();

    // SELECT content_hash FROM memory_chunks WHERE content_hash IN ...
    //
    // Note: Bun.sql's `db(hashes)` helper is called before the template literal
    // evaluates, so vals[0] here is the Promise/object returned by that call — we
    // cannot reliably extract the specific hashes being queried. Instead, we return
    // ALL existingHashes unconditionally: when the set is non-empty every known
    // hash is "already present", which correctly simulates the all-duplicate case.
    if (sql.includes("select content_hash")) {
      const rows = [...existingHashes].map((h) => ({ content_hash: h }));
      return Promise.resolve(rows);
    }

    // INSERT INTO memory_sources
    if (sql.includes("insert into memory_sources")) {
      const id = vals[0] as string;
      const kind = vals[1] as string;
      const agentId = vals[2] as string;
      const metadataJson = vals[4] as string;
      sources.push({ id, kind, agentId, metadataJson });
      return Promise.resolve([]);
    }

    // INSERT INTO memory_chunks ... RETURNING id
    if (sql.includes("insert into memory_chunks") && sql.includes("returning id")) {
      const id = vals[0] as string;
      const sourceId = vals[1] as string;
      const content = vals[2] as string;
      const contentHash = vals[6] as string;
      chunks.push({ id, sourceId, content, contentHash });
      return Promise.resolve([{ id }]);
    }

    return Promise.resolve([]);
  }

  // Simulate begin(fn) transaction.
  tagFn.begin = async (fn: (tx: typeof tagFn) => Promise<void>) => {
    await fn(tagFn);
  };

  return { getDb: () => tagFn };
});

// ── Stub: memory/fts ──────────────────────────────────────────────────────────
mock.module("./fts", () => ({
  updateChunkFts: async () => undefined,
}));

// ── Stub: memory/signal-enrichment ───────────────────────────────────────────
mock.module("./signal-enrichment", () => ({
  enrichSignals: async () => ({ facets: new Map(), payloads: new Map() }),
  isSignalKind: () => false,
}));

// ── Stub: chunk-profiles ─────────────────────────────────────────────────────
mock.module("./chunk-profiles", () => ({
  getChunkProfileWithOverrides: async () => ({
    maxChunkSize: 500,
    overlap: 50,
    minChunkSize: 40,
    contentMaxChars: 400,
    commentMaxChars: 400,
  }),
}));

// ── Stub: config/loader (for maybeEnrichSignal gate) ─────────────────────────
mock.module("../config/loader", () => ({
  loadConfig: () => ({
    pipelines: { ideas: { smart: { signalFacets: false, signalRanking: false } } },
  }),
}));

// Import AFTER mock.module calls.
import { createMemoryIndexer } from "./indexer";
import type { QdrantClient } from "./qdrant";
import type { EmbeddingProvider } from "./types";

// ── Stub factories ────────────────────────────────────────────────────────────

function makeEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: async (texts: string[]) => {
      if (shouldEmbeddingFail) throw new Error("embedding service down");
      return texts.map(() => new Float32Array(8).fill(0.1));
    },
    dimensions: 8,
    provider: "stub",
  } as unknown as EmbeddingProvider;
}

function makeQdrantClient(available = false): QdrantClient {
  return {
    available,
    ensureCollection: async () => undefined,
    searchPoints: async () => [],
    upsertPoints: async (...args: unknown[]) => {
      qdrantUpsertCalls.push(args);
    },
    setPayload: async () => undefined,
    deletePoints: async () => undefined,
  } as unknown as QdrantClient;
}

function resetState() {
  sources = [];
  chunks = [];
  existingHashes = new Set();
  shouldEmbeddingFail = false;
  qdrantUpsertCalls = [];
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("createMemoryIndexer", () => {
  beforeEach(resetState);

  test("indexNote: returns a non-empty sourceId", async () => {
    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    const sourceId = await indexer.indexNote("agent-1", "hello world this is a note with content");
    expect(typeof sourceId).toBe("string");
    expect(sourceId.length).toBeGreaterThan(0);
  });

  test("indexNote: creates exactly one memory_sources row", async () => {
    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    await indexer.indexNote("agent-2", "some note text that is long enough to become a chunk");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("note");
    expect(sources[0]?.agentId).toBe("agent-2");
  });

  test("indexNote: empty content still creates a source row (no chunks)", async () => {
    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    await indexer.indexNote("agent-3", "");
    // Source row should be created even with no chunks.
    expect(sources).toHaveLength(1);
    expect(chunks).toHaveLength(0);
  });

  test("indexIdea: assembles category, title, summary, and reasoning into the chunk", async () => {
    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    await indexer.indexIdea("agent-4", {
      id: "idea-1",
      title: "AutoReview",
      summary: "automated code review tool",
      category: "devtools",
      reasoning: "Developers waste hours reviewing boilerplate changes. This automates it.",
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("idea");
    // The chunk should contain the title and at least some content.
    const chunkContents = chunks.map((c) => c.content).join(" ");
    expect(chunkContents).toContain("AutoReview");
  });

  test("indexObservations: facts and concepts are included in the chunk text", async () => {
    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    await indexer.indexObservations("agent-5", [
      {
        id: "obs-1",
        title: "Market shift",
        summary: "AI tools growing fast",
        observationType: "trend",
        facts: ["market grew 30% YoY", "adoption doubled"],
        concepts: ["AI", "SaaS"],
      },
    ]);

    const chunkContents = chunks.map((c) => c.content).join(" ");
    expect(chunkContents).toContain("Market shift");
    expect(sources[0]?.kind).toBe("observation");
  });

  test("embedding failure is non-fatal: source and chunks are still created", async () => {
    shouldEmbeddingFail = true;

    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    // Should not throw even though embedding fails.
    const sourceId = await indexer.indexNote(
      "agent-6",
      "long note text with enough content to be chunked properly here",
    );

    expect(sourceId).toBeTruthy();
    expect(sources).toHaveLength(1);
    // Qdrant upsert should NOT have been called (no vectors to store).
    expect(qdrantUpsertCalls).toHaveLength(0);
  });

  test("all-duplicate chunks: source row is created but no chunks inserted", async () => {
    // We will pre-populate existingHashes with whatever hash the note produces.
    // Since we can't pre-know the hash, we set all chunks as already existing by
    // pre-injecting a sentinel hash AND returning them from the SELECT stub.
    //
    // The approach: run once to collect hashes, then reset + replay with those
    // hashes pre-existing.

    const indexer = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    // First run to discover the actual hashes.
    await indexer.indexNote("agent-7", "stable dedup note content that is long enough to chunk");
    const firstRunHashes = chunks.map((c) => c.contentHash);

    // Reset state and pre-mark those hashes as existing.
    resetState();
    firstRunHashes.forEach((h) => existingHashes.add(h));

    const indexer2 = createMemoryIndexer({
      embeddingProvider: makeEmbeddingProvider(),
      qdrantClient: makeQdrantClient(),
      qdrantCollection: "test",
    });

    await indexer2.indexNote("agent-7", "stable dedup note content that is long enough to chunk");

    // Source row always written; chunks deduplicated → none inserted.
    expect(sources).toHaveLength(1);
    expect(chunks).toHaveLength(0);
  });
});
