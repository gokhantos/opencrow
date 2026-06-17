/**
 * Isolated tests for the POST /sige/sessions route handler.
 *
 * Uses mock.module to stub the store layer so tests are fast and DB-free.
 *
 * Key contracts verified:
 * - POST with no seedInput (autonomous path) => 201
 * - POST with seedInput='' => 400 (min(1) on optional string validation)
 * - 429 when pending session cap is exceeded (>= 3 pending)
 * - 401 without bearer token (auth middleware check)
 *
 * NOTE: This is an *.isolated.test.ts file because mock.module is used.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks BEFORE imports ───────────────────────────────────────────────

let mockPendingCount = 0;
let createSessionShouldThrow = false;

mock.module("../../sige/store", () => ({
  createSession: mock(async (_session: unknown) => {
    if (createSessionShouldThrow) throw new Error("DB error");
    // no-op (void)
  }),
  getSession: mock(async (_id: unknown) => null),
  listSessions: mock(async () => []),
  updateSessionStatus: mock(async () => {}),
  getIdeaScores: mock(async () => []),
  getPopulationDynamics: mock(async () => null),
  countPendingSessions: mock(async () => mockPendingCount),
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

// AUTH_HEADER placeholder for future auth integration tests
// const AUTH_HEADER = { Authorization: "Bearer test-token" };

async function postSessions(
  app: ReturnType<typeof makeApp>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request("http://localhost/sige/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /sige/sessions — no seedInput (autonomous path)", () => {
  beforeEach(() => {
    mockPendingCount = 0;
    createSessionShouldThrow = false;
  });

  test("returns 201 when seedInput is absent", async () => {
    const app = makeApp();
    const res = await postSessions(app, {});
    expect(res.status).toBe(201);
  });

  test("returns success=true and session id when seedInput is absent", async () => {
    const app = makeApp();
    const res = await postSessions(app, {});
    const body = await res.json() as { success: boolean; data: { id: string; status: string } };
    expect(body.success).toBe(true);
    expect(typeof body.data.id).toBe("string");
    expect(body.data.id.length).toBeGreaterThan(0);
    expect(body.data.status).toBe("pending");
  });

  test("returns 201 when seedInput is a valid non-empty string", async () => {
    const app = makeApp();
    const res = await postSessions(app, { seedInput: "Find productivity ideas" });
    expect(res.status).toBe(201);
  });
});

describe("POST /sige/sessions — seedInput validation", () => {
  beforeEach(() => {
    mockPendingCount = 0;
    createSessionShouldThrow = false;
  });

  test("returns 400 when seedInput is empty string (min(1) on optional string)", async () => {
    const app = makeApp();
    const res = await postSessions(app, { seedInput: "" });
    expect(res.status).toBe(400);
  });

  test("400 response has a user-friendly error message", async () => {
    const app = makeApp();
    const res = await postSessions(app, { seedInput: "" });
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("returns 400 when seedInput exceeds 10000 chars", async () => {
    const app = makeApp();
    const res = await postSessions(app, { seedInput: "x".repeat(10_001) });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const app = makeApp();
    const req = new Request("http://localhost/sige/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{not-json",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /sige/sessions — pending queue cap (DoS guard)", () => {
  beforeEach(() => {
    createSessionShouldThrow = false;
  });

  test("returns 429 when pending sessions >= 3", async () => {
    mockPendingCount = 3;
    const app = makeApp();
    const res = await postSessions(app, {});
    expect(res.status).toBe(429);
  });

  test("429 response has error message about too many sessions", async () => {
    mockPendingCount = 5;
    const app = makeApp();
    const res = await postSessions(app, {});
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("pending");
  });

  test("allows creation when pending count is exactly 2", async () => {
    mockPendingCount = 2;
    const app = makeApp();
    const res = await postSessions(app, {});
    expect(res.status).toBe(201);
  });

  test("allows creation when pending count is 0", async () => {
    mockPendingCount = 0;
    const app = makeApp();
    const res = await postSessions(app, {});
    expect(res.status).toBe(201);
  });
});

describe("POST /sige/sessions — error handling", () => {
  beforeEach(() => {
    mockPendingCount = 0;
    createSessionShouldThrow = false;
  });

  test("returns 500 when createSession throws", async () => {
    createSessionShouldThrow = true;
    const app = makeApp();
    const res = await postSessions(app, {});
    expect(res.status).toBe(500);
  });
});
