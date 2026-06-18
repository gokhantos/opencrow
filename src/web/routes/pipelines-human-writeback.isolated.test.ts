/**
 * Isolated tests for the PATCH /pipeline-ideas/:id/stage human-verdict
 * outcome-memory write-back gating.
 *
 * Verifies the default-OFF correctness bar and the on-path behavior without a DB
 * or a live mem0 sidecar:
 *   - writeBack OFF (default): NO Mem0Client is constructed and NO write happens.
 *   - writeBack ON: the route runs the REAL writeHumanOutcomeMemory against a
 *     recording mem0 client — exactly one addMemories write to the ideas userId,
 *     carrying the updated idea id/title and verdictSource:"human".
 *   - A mem0 failure does NOT affect the stage-update HTTP response (still 200).
 *   - When updateIdeaStage returns null (idea not found), no write is attempted.
 *
 * Mocks ONLY the store, config loader, and the Mem0Client transport — the
 * outcome-memory module is the REAL one (mock.module leaks across the shared
 * isolated process, so we must not replace a module other isolated suites
 * import). Lane: *.isolated.test.ts.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

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
      : { id, title: "A grounded idea", quality_score: 4, pipeline_stage: stage },
  ),
}));

mock.module("../../config/loader", () => ({
  loadConfig: () => ({
    pipelines: {
      ideas: {
        smart: {
          sigeAuto: { enabled: false },
          outcomeMemory: { writeBack: writeBackEnabled },
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
