/**
 * Isolated tests for GET /api/sige/sessions/:id/progress.
 *
 * Uses mock.module to stub store + progress derivation.
 * Key contracts verified:
 * - 200 with progress payload when session exists
 * - 404 when session does not exist (getSessionProgressRaw returns null)
 * - 400 for non-UUID session id
 * - 500 on unexpected store error
 *
 * NOTE: *.isolated.test.ts — uses mock.module, must run in isolated lane.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks BEFORE imports ───────────────────────────────────────────────

type MockProgressRaw = {
  session: {
    id: string;
    status: string;
    origin: string;
    createdAt: number;
    finishedAt: number | null;
    lastActivityAt: number | null;
    error: string | null;
  };
  expertRounds: Map<number, unknown>;
  expertResultRounds: Map<number, unknown>;
  tasteFilterAt: number | null;
  socialResultAt: number | null;
  expertActionCount: Map<number, number>;
};

let mockRawResult: MockProgressRaw | null = null;
let mockRawShouldThrow = false;

mock.module("../../sige/store", () => ({
  createSession: mock(async () => {}),
  getSession: mock(async () => null),
  listSessions: mock(async () => []),
  updateSessionStatus: mock(async () => {}),
  getIdeaScores: mock(async () => []),
  getPopulationDynamics: mock(async () => null),
  countPendingSessions: mock(async () => 0),
  getSessionProgressRaw: mock(async (_id: string) => {
    if (mockRawShouldThrow) throw new Error("DB error");
    return mockRawResult;
  }),
}));

mock.module("../../sige/progress", () => ({
  deriveSessionProgress: mock((_raw: MockProgressRaw, _nowSec: number) => ({
    sessionId: _raw.session.id,
    status: _raw.session.status,
    origin: _raw.session.origin,
    createdAt: _raw.session.createdAt,
    finishedAt: _raw.session.finishedAt,
    lastActivityAt: _raw.session.lastActivityAt,
    totalElapsedSec: 60,
    stalled: false,
    stalledForSec: null,
    stalledReason: null,
    currentStep: null,
    currentSubstep: null,
    error: _raw.session.error,
    steps: [],
  })),
}));

mock.module("../../logger", () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

import { createSigeRoutes } from "./sige";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeApp() {
  return createSigeRoutes();
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function getProgress(
  app: ReturnType<typeof makeApp>,
  id: string,
): Promise<Response> {
  const req = new Request(`http://localhost/sige/sessions/${id}/progress`, {
    method: "GET",
  });
  return app.fetch(req);
}

function makeMockRaw(overrides: Partial<MockProgressRaw> = {}): MockProgressRaw {
  return {
    session: {
      id: VALID_UUID,
      status: "expert_game",
      origin: "human",
      createdAt: 1_700_000_000,
      finishedAt: null,
      lastActivityAt: 1_700_000_050,
      error: null,
    },
    expertRounds: new Map(),
    expertResultRounds: new Map(),
    tasteFilterAt: null,
    socialResultAt: null,
    expertActionCount: new Map(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /sige/sessions/:id/progress — happy path", () => {
  beforeEach(() => {
    mockRawResult = makeMockRaw();
    mockRawShouldThrow = false;
  });

  test("returns 200 when session exists", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    expect(res.status).toBe(200);
  });

  test("returns success=true with data", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    const body = await res.json() as { success: boolean; data: { sessionId: string; status: string } };
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  test("data.sessionId matches the requested id", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    const body = await res.json() as { success: boolean; data: { sessionId: string } };
    expect(body.data.sessionId).toBe(VALID_UUID);
  });

  test("data.status is the session status", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    const body = await res.json() as { success: boolean; data: { status: string } };
    expect(body.data.status).toBe("expert_game");
  });
});

describe("GET /sige/sessions/:id/progress — not found", () => {
  beforeEach(() => {
    mockRawResult = null;
    mockRawShouldThrow = false;
  });

  test("returns 404 when session does not exist", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    expect(res.status).toBe(404);
  });

  test("404 body has success=false and error message", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe("GET /sige/sessions/:id/progress — invalid id", () => {
  beforeEach(() => {
    mockRawResult = null;
    mockRawShouldThrow = false;
  });

  test("returns 400 for non-UUID id", async () => {
    const app = makeApp();
    const res = await getProgress(app, "not-a-uuid");
    expect(res.status).toBe(400);
  });

  test("400 body has success=false", async () => {
    const app = makeApp();
    const res = await getProgress(app, "not-a-uuid");
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });
});

describe("GET /sige/sessions/:id/progress — error handling", () => {
  beforeEach(() => {
    mockRawResult = null;
    mockRawShouldThrow = true;
  });

  test("returns 500 when store throws", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    expect(res.status).toBe(500);
  });

  test("500 body has success=false", async () => {
    const app = makeApp();
    const res = await getProgress(app, VALID_UUID);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });
});
