/**
 * Integration tests for the outcome-memory write-back path.
 *
 * Requires Postgres (`docker compose up -d postgres` first).
 * Uses a real DB (insertIdea / insertIdeaFeedback) and a stub mem0 implementation
 * (NOT a real Mem0 HTTP server) to:
 *
 *   1. Verify that idea_feedback + generated_ideas rows are unchanged after the
 *      write-back logic runs (no regression to existing rows).
 *   2. Verify that the stub mem0 received addMemories payloads whose verdict /
 *      verdictSource match the proxy label kind / reason.
 *   3. Verify that flag OFF => stub mem0 receives NOTHING.
 *
 * We exercise writeOutcomeMemories + toOutcomeMemory + renderOutcomeSentence
 * through the public API (not the private pipeline internals), seeding the
 * relevant DB state directly and running the write-back logic ourselves. This
 * keeps the test hermetic while verifying the end-to-end write path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { insertIdea, insertIdeaFeedback, getIdeaFeedback } from "../../sources/ideas/store";
import {
  writeOutcomeMemories,
  toOutcomeMemory,
  renderOutcomeSentence,
  type OutcomeMemoryItem,
  type OutcomeMemory,
} from "./outcome-memory";
import { deriveProxyLabels, DEFAULT_PROXY_OPTIONS } from "./feedback-bootstrap";
import type { Mem0Client, Mem0AddResult, Mem0SearchResult } from "../../sige/knowledge/mem0-client";
import type { ScoredIdeaForProxy } from "./feedback-bootstrap";

// ── Stub Mem0Client ────────────────────────────────────────────────────────────

interface RecordedAddMemoriesCall {
  readonly items: Array<{ content: string; metadata?: Record<string, unknown> }>;
  readonly userId: string;
  readonly enableGraph?: boolean;
}

function makeRecordingMem0(): {
  client: Mem0Client;
  addMemoriesCalls: RecordedAddMemoriesCall[];
} {
  const addMemoriesCalls: RecordedAddMemoriesCall[] = [];
  const client: Mem0Client = {
    isUnavailable: () => false,
    addMemory: async () => ({ memories: [], relations: [] } as Mem0AddResult),
    addMemories: async (params: {
      readonly items: readonly { readonly content: string; readonly metadata?: Record<string, unknown> }[];
      readonly userId: string;
      readonly enableGraph?: boolean;
      readonly maxConcurrent?: number;
    }) => {
      addMemoriesCalls.push({
        items: params.items as Array<{ content: string; metadata?: Record<string, unknown> }>,
        userId: params.userId,
        enableGraph: params.enableGraph,
      });
    },
    search: async (): Promise<Mem0SearchResult> => ({ memories: [], relations: [] }),
    getAll: async () => [],
    deleteMemory: async () => undefined,
  } as unknown as Mem0Client;
  return { client, addMemoriesCalls };
}

// ── Cleanup helpers ────────────────────────────────────────────────────────────

const testIdeaIds: string[] = [];

async function cleanupTestData(): Promise<void> {
  if (testIdeaIds.length === 0) return;
  const db = getDb();
  const placeholders = testIdeaIds.map((_, i) => `$${i + 1}`).join(", ");
  await db.unsafe(
    `DELETE FROM idea_feedback WHERE idea_id IN (${placeholders})`,
    testIdeaIds,
  );
  await db.unsafe(
    `DELETE FROM generated_ideas WHERE id IN (${placeholders})`,
    testIdeaIds,
  );
  testIdeaIds.length = 0;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

async function seedIdea(title = "Test outcome idea"): Promise<string> {
  const idea = await insertIdea({
    agent_id: "test-agent",
    title,
    summary: "A test idea summary",
    reasoning: "Test reasoning",
    sources_used: "[]",
    category: "test-category",
    quality_score: null,
  });
  testIdeaIds.push(idea.id);
  return idea.id;
}

const baseContext = {
  runId: "test-run-001",
  promptVersion: "v1.0",
  model: "test-model",
  createdAtSec: 1_000_000,
} as const;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pipeline-outcome-memory integration: DB rows unaffected by write-back", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
    await closeDb();
  });

  it("existing generated_ideas row is unchanged after writeOutcomeMemories", async () => {
    const ideaId = await seedIdea("Unchanged idea title");
    const { client } = makeRecordingMem0();

    const item: OutcomeMemoryItem = {
      sentence: "Idea was STORED pending validation.",
      metadata: toOutcomeMemory(
        { ideaId, segment: "b2b", archetype: "hair-on-fire", giantComposite: 3.0 },
        { verdict: "stored-pending", verdictSource: "none" },
        {},
        baseContext,
      ),
    };

    await writeOutcomeMemories(client, [item], "sige-ideas");

    // The generated_ideas row must be unchanged
    const db = getDb();
    const rows = await db`SELECT * FROM generated_ideas WHERE id = ${ideaId}` as Array<{ title: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.title).toBe("Unchanged idea title");
  });

  it("existing idea_feedback rows are unchanged after writeOutcomeMemories", async () => {
    const ideaId = await seedIdea("Feedback idea");

    // Insert a pre-existing feedback row
    const existing = await insertIdeaFeedback({
      idea_id: ideaId,
      kind: "saved",
      actor: "user",
      run_id: "pre-existing-run",
    });
    expect(existing).not.toBeNull();

    const { client } = makeRecordingMem0();

    const item: OutcomeMemoryItem = {
      sentence: "Outcome sentence",
      metadata: toOutcomeMemory(
        { ideaId, segment: "b2b", archetype: "hard-fact", giantComposite: 2.8 },
        { verdict: "archived", verdictSource: "proxy:very-low-giant" },
        {},
        baseContext,
      ),
    };

    await writeOutcomeMemories(client, [item], "sige-ideas");

    // The pre-existing feedback row must still be there and unchanged
    const events = await getIdeaFeedback(ideaId);
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("saved");
    expect(events[0]?.actor).toBe("user");
  });
});

describe("pipeline-outcome-memory integration: write-back flag ON", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
    await closeDb();
  });

  it("sends addMemories payload with correct verdict and verdictSource matching proxy label", async () => {
    const ideaId = await seedIdea("High-scoring validated idea");
    const { client, addMemoriesCalls } = makeRecordingMem0();

    // Simulate a proxy-labeled "validated" idea
    const proxyVerdict = "validated";
    const proxySource = "proxy:high-giant";

    const memory = toOutcomeMemory(
      { ideaId, segment: "enterprise", archetype: "hair-on-fire", giantComposite: 4.2 },
      { verdict: proxyVerdict, verdictSource: proxySource },
      {},
      baseContext,
    );
    const sentence = renderOutcomeSentence(memory, "High-scoring validated idea");

    await writeOutcomeMemories(client, [{ sentence, metadata: memory }], "sige-ideas");

    expect(addMemoriesCalls.length).toBe(1);
    const call = addMemoriesCalls[0]!;
    expect(call.userId).toBe("sige-ideas");
    expect(call.enableGraph).toBe(false);
    expect(call.items.length).toBe(1);

    const sentMetadata = call.items[0]?.metadata as OutcomeMemory | undefined;
    expect(sentMetadata?.verdict).toBe(proxyVerdict);
    expect(sentMetadata?.verdictSource).toBe(proxySource);
    expect(sentMetadata?.ideaId).toBe(ideaId);
  });

  it("sends addMemories payload for archived idea with verdictSource matching proxy reason", async () => {
    const ideaId = await seedIdea("Very low quality idea");
    const { client, addMemoriesCalls } = makeRecordingMem0();

    const memory = toOutcomeMemory(
      { ideaId, segment: "consumer", archetype: "future-vision", giantComposite: 1.1 },
      { verdict: "archived", verdictSource: "proxy:very-low-giant" },
      {
        gate: {
          composite: 1.1,
          gated: true,
          gateReasons: ["hard-gate:acuteProblem score 0 <= 1"],
        },
      },
      baseContext,
    );
    const sentence = renderOutcomeSentence(memory, "Very low quality idea");

    await writeOutcomeMemories(client, [{ sentence, metadata: memory }], "sige-ideas");

    expect(addMemoriesCalls.length).toBe(1);
    const sentMetadata = addMemoriesCalls[0]?.items[0]?.metadata as OutcomeMemory | undefined;
    expect(sentMetadata?.verdict).toBe("archived");
    expect(sentMetadata?.verdictSource).toBe("proxy:very-low-giant");
    expect(sentMetadata?.failingAxes).toContain("acuteProblem");
  });

  it("sends one addMemories batch for a mix of stored + dedup-rejected items", async () => {
    const storedId = await seedIdea("A stored idea");
    const { client, addMemoriesCalls } = makeRecordingMem0();

    const storedMemory = toOutcomeMemory(
      { ideaId: storedId, segment: "smb", archetype: "hair-on-fire", giantComposite: 2.5 },
      { verdict: "stored-pending", verdictSource: "none" },
      {},
      baseContext,
    );
    const dedupMemory = toOutcomeMemory(
      { ideaId: null, segment: null, archetype: null, giantComposite: null },
      { verdict: "dedup-rejected", verdictSource: "dedup" },
      {},
      baseContext,
    );

    const items: OutcomeMemoryItem[] = [
      { sentence: renderOutcomeSentence(storedMemory, "A stored idea"), metadata: storedMemory },
      { sentence: renderOutcomeSentence(dedupMemory, "Duplicate theme"), metadata: dedupMemory },
    ];

    await writeOutcomeMemories(client, items, "sige-ideas");

    // One batch call
    expect(addMemoriesCalls.length).toBe(1);
    expect(addMemoriesCalls[0]?.items.length).toBe(2);

    const payloads = addMemoriesCalls[0]!.items;
    const storedItem = payloads.find(
      (p) => (p.metadata as OutcomeMemory | undefined)?.verdict === "stored-pending",
    );
    const dedupItem = payloads.find(
      (p) => (p.metadata as OutcomeMemory | undefined)?.verdict === "dedup-rejected",
    );

    expect(storedItem?.metadata).toBeDefined();
    expect((storedItem?.metadata as OutcomeMemory | undefined)?.verdictSource).toBe("none");
    expect(dedupItem?.metadata).toBeDefined();
    expect((dedupItem?.metadata as OutcomeMemory | undefined)?.verdictSource).toBe("dedup");
  });
});

describe("pipeline-outcome-memory integration: write-back flag OFF", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
    await closeDb();
  });

  it("flag OFF (empty items array) => stub mem0 receives NOTHING", async () => {
    const { client, addMemoriesCalls } = makeRecordingMem0();

    // Simulate flag OFF: writeBack is false, so pipeline passes empty items
    await writeOutcomeMemories(client, [], "sige-ideas");

    expect(addMemoriesCalls.length).toBe(0);
  });

  it("flag OFF: existing DB rows are still queryable and unaffected", async () => {
    const ideaId = await seedIdea("Stable idea");
    const { client, addMemoriesCalls } = makeRecordingMem0();

    // No write-back at all
    await writeOutcomeMemories(client, [], "sige-ideas");

    expect(addMemoriesCalls.length).toBe(0);

    // DB row is still intact
    const db = getDb();
    const rows = await db`SELECT * FROM generated_ideas WHERE id = ${ideaId}` as Array<{ title: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.title).toBe("Stable idea");
  });
});

describe("pipeline-outcome-memory integration: proxy label → outcome memory mapping", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
    await closeDb();
  });

  it("proxy label kind and reason map to verdict and verdictSource correctly", async () => {
    // A scored idea that would trigger the "very-low-giant" proxy archive label
    const ideaId = await seedIdea("Very weak idea");

    const scored: ScoredIdeaForProxy = {
      id: ideaId,
      giantComposite: 1.2,
      humanLabel: null,
      grounded: false,
      distinctSegments: 0,
    };

    const [label] = deriveProxyLabels([scored], DEFAULT_PROXY_OPTIONS, baseContext.runId);
    expect(label).toBeDefined();
    expect(label?.event.kind).toBe("archived");
    // reason is the token after proxy:
    expect(label?.reason).toBeTruthy();

    const { client, addMemoriesCalls } = makeRecordingMem0();

    // label.event.kind is FeedbackKind (broader); proxy labels only emit "archived"/"validated"
    const proxyKind = label!.event.kind as OutcomeMemory["verdict"];
    const memory = toOutcomeMemory(
      { ideaId, segment: null, archetype: null, giantComposite: 1.2 },
      { verdict: proxyKind, verdictSource: `proxy:${label!.reason}` },
      {},
      baseContext,
    );
    const sentence = renderOutcomeSentence(memory, "Very weak idea");

    await writeOutcomeMemories(client, [{ sentence, metadata: memory }], "sige-ideas");

    expect(addMemoriesCalls.length).toBe(1);
    const meta = addMemoriesCalls[0]?.items[0]?.metadata as OutcomeMemory | undefined;
    expect(meta?.verdict).toBe("archived");
    expect(meta?.verdictSource).toBe(`proxy:${label!.reason}`);
    expect(meta?.ideaId).toBe(ideaId);
  });
});
