/**
 * Isolated tests for the PATCH /pipeline-ideas/:id/stage human-verdict
 * outcome-memory write-back gating AND deferred reprobe enqueue.
 *
 * Verifies the default-OFF correctness bar and the on-path behavior without a DB
 * or a live mem0 sidecar:
 *   - writeBack OFF (default): NO Mem0Client is constructed and NO write happens.
 *   - writeBack ON: the route runs the REAL writeHumanOutcomeMemory against a
 *     recording mem0 client — exactly one addMemories write to the ideas userId,
 *     carrying the updated idea id/title and verdictSource:"human".
 *   - A mem0 failure does NOT affect the stage-update HTTP response (still 200).
 *   - When updateIdeaStage returns null (idea not found), no write is attempted.
 *   - Reprobe enqueue: when reprobe.enabled and the idea's demand_json clears the
 *     absence floor, enqueueValidatedIdea is called with baselineDemand set.
 *   - When demand_json is null or below the floor, no enqueue is attempted.
 *   - When reprobe is disabled, no enqueue is attempted regardless of demand_json.
 *
 * Mocks ONLY the store, config loader, Mem0Client transport, and deferred-outcome-
 * store — the outcome-memory module is the REAL one (mock.module leaks across the
 * shared isolated process, so we must not replace a module other isolated suites
 * import). Lane: *.isolated.test.ts.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { DemandArtifact } from "../../pipelines/ideas/demand";

// ── Mutable test state captured by the mocks ──────────────────────────────────

let writeBackEnabled = false;
let updateReturnsNull = false;
let mem0Constructed = 0;
let addMemoriesCalls: Array<{
  items: Array<{ content: string; metadata?: Record<string, unknown> }>;
  userId: string;
  enableGraph?: boolean;
}> = [];
let addMemoriesThrows = false;

/** demand_json that the mock updateIdeaStage will embed in the returned idea. */
let mockDemandJson: DemandArtifact | null = null;
/** whether reprobe is enabled in the mocked config */
let reprobeEnabled = false;
/** captured calls to enqueueValidatedIdea */
let enqueueCalls: Array<Record<string, unknown>> = [];

// ── Module mocks BEFORE importing the route ──────────────────────────────────

mock.module("../../pipelines/store", () => ({
  getPipelineIdeas: mock(async () => []),
  getPipelineIdeasCount: mock(async () => 0),
  getPipelineRuns: mock(async () => []),
  getPipelineRun: mock(async () => null),
  getStepsForRun: mock(async () => []),
  getIdeasForRun: mock(async () => []),
  getLatestRun: mock(async () => null),
  acquirePipelineLock: mock(async () => ({ acquired: true, runId: "mock-run-id" })),
  getPipelineRunsList: mock(async () => []),
}));

mock.module("../../sources/ideas/store", () => ({
  updateIdeaStage: mock(async (id: string, stage: string) =>
    updateReturnsNull
      ? null
      : {
          id,
          title: "A grounded idea",
          quality_score: 4,
          pipeline_stage: stage,
          competability_json: null,
          demand_json: mockDemandJson,
          demand_score: mockDemandJson?.score ?? null,
          // GIANT composite / segment / archetype now live on the row + domain
          // type (migration 014/015). The route must thread the REAL values into
          // the human outcome-memory write-back, not hard-pass null.
          giant_composite: 3.7,
          segment: "b2b-saas",
          archetype: "hard-fact",
        },
  ),
  // parseDemandJson: pass through — the route reads demand_json directly off
  // the returned idea object (already parsed by rowToGeneratedIdea in prod);
  // we surface it as-is from the mock so no real parse is needed here.
  parseDemandJson: (v: unknown) => v as DemandArtifact | null,
}));

mock.module("../../config/loader", () => ({
  loadConfig: () => ({
    pipelines: {
      ideas: {
        smart: {
          sigeAuto: { enabled: false },
          outcomeMemory: {
            writeBack: writeBackEnabled,
            reprobe: {
              enabled: reprobeEnabled,
              delayDays: 30,
            },
          },
        },
      },
    },
    sige: {
      mem0: {
        baseUrl: "http://127.0.0.1:8050",
        userId: "sige-global",
        ideasUserId: "sige-ideas",
      },
    },
  }),
}));

mock.module("../../pipelines/ideas/deferred-outcome-store", () => ({
  enqueueValidatedIdea: mock(async (input: Record<string, unknown>) => {
    enqueueCalls.push(input);
    return true;
  }),
}));

// Recording Mem0Client: the REAL writeHumanOutcomeMemory calls getAll →
// deleteMemory → addMemories on this instance. We assert on the recorded write.
mock.module("../../sige/knowledge/mem0-client", () => ({
  Mem0Client: class {
    constructor() {
      mem0Constructed += 1;
    }
    isUnavailable() {
      return false;
    }
    async getAll() {
      return [];
    }
    async deleteMemory() {
      return undefined;
    }
    async addMemories(params: {
      items: Array<{ content: string; metadata?: Record<string, unknown> }>;
      userId: string;
      enableGraph?: boolean;
    }) {
      if (addMemoriesThrows) throw new Error("mem0 down");
      addMemoriesCalls.push(params);
    }
  },
}));

mock.module("../../pipelines/ideas/pipeline", () => ({
  runIdeasPipeline: mock(async () => {}),
}));

mock.module("../../pipelines/ideas/pipeline-autonomous", () => ({
  AUTONOMOUS_SIGE_PIPELINE_ID: "autonomous-sige",
  runAutonomousSige: mock(async () => {}),
}));

mock.module("../../pipelines/resume", () => ({
  resumeRunById: mock(async () => ({ ok: false, reason: "not_found" })),
  resumeAllInterrupted: mock(async () => 0),
}));

mock.module("../../pipelines/types", () => ({
  PIPELINE_DEFINITIONS: [],
  DEFAULT_PIPELINE_CONFIG: { category: "mobile_app", maxIdeas: 5, minQualityScore: 3, sourcesToInclude: [] },
}));

mock.module("../../logger", () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) }),
}));

import { createPipelineRoutes } from "./pipelines";
import type { OutcomeMemory } from "../../pipelines/ideas/outcome-memory";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function patchStage(stage: string, id = "idea-1"): Promise<Response> {
  const app = createPipelineRoutes();
  return await app.fetch(
    new Request(`http://localhost/pipeline-ideas/${id}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    }),
  );
}

beforeEach(() => {
  writeBackEnabled = false;
  updateReturnsNull = false;
  mem0Constructed = 0;
  addMemoriesCalls = [];
  addMemoriesThrows = false;
  mockDemandJson = null;
  reprobeEnabled = false;
  enqueueCalls = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /pipeline-ideas/:id/stage — writeBack OFF (default)", () => {
  test("does NOT construct a Mem0Client and does NOT write back", async () => {
    const res = await patchStage("validated");
    expect(res.status).toBe(200);
    expect(mem0Constructed).toBe(0);
    expect(addMemoriesCalls.length).toBe(0);
  });

  test("response shape is unchanged (success + data)", async () => {
    const res = await patchStage("archived");
    const body = (await res.json()) as { success: boolean; data: { id: string } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe("idea-1");
  });
});

describe("PATCH /pipeline-ideas/:id/stage — writeBack ON", () => {
  test("constructs a Mem0Client and writes exactly one human verdict", async () => {
    writeBackEnabled = true;
    const res = await patchStage("validated", "idea-42");
    expect(res.status).toBe(200);
    expect(mem0Constructed).toBe(1);
    expect(addMemoriesCalls.length).toBe(1);

    const call = addMemoriesCalls[0]!;
    expect(call.userId).toBe("sige-ideas");
    expect(call.enableGraph).toBe(false);
    expect(call.items.length).toBe(1);
    const meta = call.items[0]?.metadata as OutcomeMemory;
    expect(meta.verdict).toBe("validated");
    expect(meta.verdictSource).toBe("human");
    expect(meta.ideaId).toBe("idea-42");
    // The real giant_composite / segment / archetype from the idea row are
    // threaded into the memory — NOT hard-passed null (the degenerate-lesson fix).
    expect(meta.giantComposite).toBe(3.7);
    expect(meta.segment).toBe("b2b-saas");
    expect(meta.archetype).toBe("hard-fact");
  });

  test("an archived verdict maps to verdict 'archived'", async () => {
    writeBackEnabled = true;
    await patchStage("archived");
    const meta = addMemoriesCalls[0]?.items[0]?.metadata as OutcomeMemory;
    expect(meta.verdict).toBe("archived");
    expect(meta.verdictSource).toBe("human");
  });

  test("a restore (stage 'idea') retracts prior memory and writes NOTHING (200)", async () => {
    writeBackEnabled = true;
    const res = await patchStage("idea");
    // "idea" IS a valid stage (the un-archive / restore). It reaches the write
    // path, but humanStageToVerdict("idea") === null, so the prior memory is
    // retracted (delete-prior) and no new verdict is written.
    expect(res.status).toBe(200);
    expect(addMemoriesCalls.length).toBe(0);
  });

  test("a mem0 write failure does NOT break the stage-update response (still 200)", async () => {
    writeBackEnabled = true;
    addMemoriesThrows = true;
    const res = await patchStage("validated");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test("no write is attempted when the idea is not found (updateIdeaStage null → 404)", async () => {
    writeBackEnabled = true;
    updateReturnsNull = true;
    const res = await patchStage("validated");
    expect(res.status).toBe(404);
    expect(addMemoriesCalls.length).toBe(0);
    expect(mem0Constructed).toBe(0);
  });
});

// ─── A demand artifact that clears the absence floor (confidence > 0.2) ───────
const DEMAND_ABOVE_FLOOR: DemandArtifact = {
  score: 3.0,
  confidence: 0.55,
  whitespace: 0.4,
  evidence: [{ kind: "reddit_intent", query: "async tasks", count: 3 }],
};

describe("PATCH /pipeline-ideas/:id/stage — deferred reprobe enqueue (prereq #3)", () => {
  test("enqueues with real baselineDemand when reprobe.enabled and demand_json clears the floor", async () => {
    reprobeEnabled = true;
    mockDemandJson = DEMAND_ABOVE_FLOOR;
    const res = await patchStage("validated", "idea-reprobe-1");
    expect(res.status).toBe(200);
    expect(enqueueCalls.length).toBe(1);
    const call = enqueueCalls[0]!;
    expect(call.ideaId).toBe("idea-reprobe-1");
    expect(call.validationSource).toBe("human");
    expect(call.baselineDemand).toEqual(DEMAND_ABOVE_FLOOR);
    // dueAt must be in the future (validatedAt + 30 * 86400 seconds)
    expect(typeof call.dueAt).toBe("number");
    expect((call.dueAt as number)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("does NOT enqueue when demand_json is null (no real baseline)", async () => {
    reprobeEnabled = true;
    mockDemandJson = null;
    const res = await patchStage("validated");
    expect(res.status).toBe(200);
    expect(enqueueCalls.length).toBe(0);
  });

  test("does NOT enqueue when demand_json confidence is at the absence floor (0.2 is NOT > 0.2)", async () => {
    reprobeEnabled = true;
    mockDemandJson = { score: 1, confidence: 0.2, whitespace: 0, evidence: [] };
    const res = await patchStage("validated");
    expect(res.status).toBe(200);
    expect(enqueueCalls.length).toBe(0);
  });

  test("does NOT enqueue when reprobe is disabled", async () => {
    reprobeEnabled = false;
    mockDemandJson = DEMAND_ABOVE_FLOOR;
    const res = await patchStage("validated");
    expect(res.status).toBe(200);
    expect(enqueueCalls.length).toBe(0);
  });

  test("does NOT enqueue for archived stage (only validated triggers reprobe)", async () => {
    reprobeEnabled = true;
    mockDemandJson = DEMAND_ABOVE_FLOOR;
    const res = await patchStage("archived");
    expect(res.status).toBe(200);
    expect(enqueueCalls.length).toBe(0);
  });

  test("does NOT enqueue for restore stage (idea)", async () => {
    reprobeEnabled = true;
    mockDemandJson = DEMAND_ABOVE_FLOOR;
    const res = await patchStage("idea");
    expect(res.status).toBe(200);
    expect(enqueueCalls.length).toBe(0);
  });

  test("HTTP response is still 200 regardless of reprobe path taken", async () => {
    reprobeEnabled = true;
    mockDemandJson = DEMAND_ABOVE_FLOOR;
    const res = await patchStage("validated");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
