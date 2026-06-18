/**
 * Isolated tests for the GET /pipeline-ideas route handler — sort param normalisation.
 *
 * Key contracts verified:
 * - ?sort=newest, oldest, score pass through to the store as-is.
 * - ?sort=<unknown> (e.g. "x; DROP TABLE") is normalised to "newest" before
 *   reaching getPipelineIdeas — the raw string never touches the store.
 * - Absent ?sort defaults to "newest".
 *
 * Uses mock.module to replace the store layer (DB-free) so we can capture which
 * filter.sort value the route handler forwards.
 *
 * Lane: *.isolated.test.ts → bun run test:isolated
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks BEFORE any imports that transitively load them ───────────────

let capturedFilter: Record<string, unknown> = {};

mock.module("../../pipelines/store", () => ({
  getPipelineIdeas: mock(async (filter: Record<string, unknown>) => {
    capturedFilter = { ...filter };
    return [];
  }),
  getPipelineIdeasCount: mock(async (_filter: unknown) => 0),
  // Other store exports used by pipeline routes (not needed for this test)
  getPipelineRuns: mock(async () => []),
  getPipelineRun: mock(async () => null),
  getStepsForRun: mock(async () => []),
  getIdeasForRun: mock(async () => []),
  getLatestRun: mock(async () => null),
  acquirePipelineLock: mock(async () => ({ acquired: true, runId: "mock-run-id" })),
  getPipelineRunsList: mock(async () => []),
  findResumableRuns: mock(async () => []),
  incrementResumeAttempts: mock(async () => 0),
  markRunFailed: mock(async () => {}),
  failIncompleteStepsForRun: mock(async () => 0),
  createPipelineStep: mock(async () => ({})),
  updatePipelineStep: mock(async () => ({})),
  touchPipelineStep: mock(async () => {}),
  updatePipelineRun: mock(async () => ({})),
  findCompletedStep: mock(async () => ({ found: false, hasOutput: false })),
}));

mock.module("../../sources/ideas/store", () => ({
  updateIdeaStage: mock(async () => null),
}));

mock.module("../../config/loader", () => ({
  loadConfig: () => ({
    pipelines: {
      ideas: {
        smart: {
          sigeAuto: { enabled: false },
        },
      },
    },
  }),
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
  DEFAULT_PIPELINE_CONFIG: {
    category: "mobile_app",
    maxIdeas: 5,
    minQualityScore: 3,
    sourcesToInclude: [],
  },
}));

mock.module("../../logger", () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

import { createPipelineRoutes } from "./pipelines";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp() {
  return createPipelineRoutes();
}

async function getIdeas(
  app: ReturnType<typeof makeApp>,
  params: Record<string, string> = {},
): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  const url = qs
    ? `http://localhost/pipeline-ideas?${qs}`
    : "http://localhost/pipeline-ideas";
  return app.fetch(new Request(url));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /pipeline-ideas — sort param normalisation", () => {
  beforeEach(() => {
    capturedFilter = {};
  });

  test("?sort=newest is forwarded to store as 'newest'", async () => {
    const app = makeApp();
    await getIdeas(app, { sort: "newest" });
    expect(capturedFilter["sort"]).toBe("newest");
  });

  test("?sort=oldest is forwarded to store as 'oldest'", async () => {
    const app = makeApp();
    await getIdeas(app, { sort: "oldest" });
    expect(capturedFilter["sort"]).toBe("oldest");
  });

  test("?sort=score is forwarded to store as 'score'", async () => {
    const app = makeApp();
    await getIdeas(app, { sort: "score" });
    expect(capturedFilter["sort"]).toBe("score");
  });

  test("absent ?sort defaults to 'newest'", async () => {
    const app = makeApp();
    await getIdeas(app, {});
    expect(capturedFilter["sort"]).toBe("newest");
  });

  test("unknown ?sort value is normalised to 'newest' before reaching the store", async () => {
    const app = makeApp();
    await getIdeas(app, { sort: "unknown_value" });
    expect(capturedFilter["sort"]).toBe("newest");
  });

  test("injection-like ?sort value is normalised to 'newest' (never forwarded raw)", async () => {
    const app = makeApp();
    await getIdeas(app, { sort: "newest; DROP TABLE generated_ideas;--" });
    // Must be normalised — the raw injection string must NOT reach the store
    expect(capturedFilter["sort"]).toBe("newest");
    expect(capturedFilter["sort"]).not.toContain("DROP");
  });

  test("?sort= (empty string) is normalised to 'newest'", async () => {
    const app = makeApp();
    await getIdeas(app, { sort: "" });
    expect(capturedFilter["sort"]).toBe("newest");
  });

  test("route returns 200 for valid request regardless of sort normalisation", async () => {
    const app = makeApp();
    const res = await getIdeas(app, { sort: "injected_value" });
    expect(res.status).toBe(200);
  });

  test("response includes success=true and data array on valid request", async () => {
    const app = makeApp();
    const res = await getIdeas(app, { sort: "newest" });
    const body = (await res.json()) as {
      success: boolean;
      data: unknown[];
      meta: { total: number };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe("number");
  });
});
