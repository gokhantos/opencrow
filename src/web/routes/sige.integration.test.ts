/**
 * Integration tests for the SIGE HTTP routes.
 *
 * Covers the cancel endpoint (DELETE /sige/sessions/:id) which is the primary
 * focus of the caller-context logging change:
 * - 404 on unknown session id
 * - 400 when the session is already in a terminal status
 * - 200 + { success: true } on a valid cancellation
 * - finished_at is stamped on the cancelled row
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "crypto";
import { initDb, closeDb, getDb } from "../../store/db";
import { createSession, getSession } from "../../sige/store";
import { createSigeRoutes } from "./sige";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  return createSigeRoutes();
}

/** Minimal valid config JSON required by the sessions table. */
const MINIMAL_CONFIG_JSON = JSON.stringify({
  ideaText: "test idea",
  numAgents: 2,
  rounds: 1,
  enableMem0: false,
});

async function createTestSession(id: string, status = "pending") {
  await createSession({
    id,
    seedInput: "test seed",
    origin: "human",
    status: status as never,
    configJson: MINIMAL_CONFIG_JSON,
  });
}

async function del(
  app: ReturnType<typeof makeApp>,
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "DELETE",
        headers: headers ?? {},
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
});

afterEach(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// DELETE /sige/sessions/:id
// ---------------------------------------------------------------------------

describe("DELETE /sige/sessions/:id", () => {
  it("404 when session does not exist", async () => {
    const app = makeApp();
    const res = await del(app, `/sige/sessions/${randomUUID()}`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("not found");
  });

  it("400 when session is already in a terminal status", async () => {
    const id = randomUUID();
    await createTestSession(id, "completed");

    const app = makeApp();
    const res = await del(app, `/sige/sessions/${id}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("cannot be cancelled");

    // Clean up
    const db = getDb();
    await db`DELETE FROM sige_sessions WHERE id = ${id}`;
  });

  it("200 + { success: true } on a valid in-progress session", async () => {
    const id = randomUUID();
    await createTestSession(id, "running");

    const app = makeApp();
    const res = await del(app, `/sige/sessions/${id}`, {
      "x-forwarded-for": "203.0.113.42",
      "user-agent": "test-client/1.0",
      origin: "https://example.com",
      referer: "https://example.com/dashboard",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Verify the row is now cancelled
    const session = await getSession(id);
    expect(session?.status).toBe("cancelled");

    // Verify finished_at was stamped
    expect(session?.finishedAt).toBeDefined();

    // Clean up
    const db = getDb();
    await db`DELETE FROM sige_sessions WHERE id = ${id}`;
  });

  it("200 on a pending session — any non-terminal status is cancellable", async () => {
    const id = randomUUID();
    await createTestSession(id, "pending");

    const app = makeApp();
    const res = await del(app, `/sige/sessions/${id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const session = await getSession(id);
    expect(session?.status).toBe("cancelled");
    expect(session?.finishedAt).toBeDefined();

    // Clean up
    const db = getDb();
    await db`DELETE FROM sige_sessions WHERE id = ${id}`;
  });

  it("cancelled is sticky — second cancel attempt returns 400", async () => {
    const id = randomUUID();
    await createTestSession(id, "cancelled");

    const app = makeApp();
    const res = await del(app, `/sige/sessions/${id}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);

    // Clean up
    const db = getDb();
    await db`DELETE FROM sige_sessions WHERE id = ${id}`;
  });
});
