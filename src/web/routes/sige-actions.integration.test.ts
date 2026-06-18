/**
 * Integration tests for GET /api/sige/sessions/:id/actions.
 *
 * Scenarios:
 *   1. Seed a session + agent actions; assert { success, data: { rounds: [...] } } shape.
 *   2. Bearer auth is fail-closed — 401 without a valid token.
 *   3. Round filtering (?round=N) scopes to a single round.
 *   4. Empty-round: a session with no actions returns { rounds: [] }.
 *   5. 404 for an unknown session id.
 *   6. 400 for a non-UUID session id.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createSession, saveAgentAction } from "../../sige/store";
import { createWebApp } from "../app";
import type { WebAppDeps } from "../app";
import { createAgentRegistry } from "../../agents/registry";

// ─── Constants ─────────────────────────────────────────────────────────────────

const TEST_TOKEN = "sige-actions-integration-test-token";
const SECRET_KEY = "OPENCROW_WEB_TOKEN";
const BASE = "http://localhost";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeMinimalDeps(): WebAppDeps {
  const agentRegistry = createAgentRegistry([], {
    model: "claude-haiku-4-5",
    systemPrompt: "test",
    retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30_000, jitter: 0.15 },
    compaction: {
      maxContextTokens: 180_000,
      targetHistoryTokens: 60_000,
      summaryMaxTokens: 2048,
      stripToolResultsAfterTurns: 3,
    },
    failover: undefined,
  });

  return {
    config: {
      agent: {
        model: "claude-haiku-4-5",
        systemPrompt: "test",
        retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30_000, jitter: 0.15 },
        compaction: {
          maxContextTokens: 180_000,
          targetHistoryTokens: 60_000,
          summaryMaxTokens: 2048,
          stripToolResultsAfterTurns: 3,
        },
      },
      channels: {
        telegram: { botToken: "" },
        whatsapp: { enabled: false },
      },
      web: { port: 48081, host: "127.0.0.1" },
    } as unknown as WebAppDeps["config"],
    channels: new Map(),
    agentRegistry,
    getDefaultAgentOptions: async () => ({}) as never,
  } as unknown as WebAppDeps;
}

const DEFAULT_CONFIG = {
  expertRounds: 2,
  socialAgentCount: 5,
  socialRounds: 1,
  maxConcurrentAgents: 1,
  alpha: 0.5,
  incentiveWeights: {
    diversity: 0.25,
    building: 0.2,
    surprise: 0.15,
    accuracyPenalty: 0.1,
    socialViability: 0.3,
  },
  provider: "anthropic",
  model: "claude-haiku-4-5",
  agentModel: "claude-haiku-4-5",
};

const testSessionIds: string[] = [];
const testActionIds: string[] = [];

async function createTestSession(opts: {
  id?: string;
  seedInput?: string;
}): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await createSession({
    id,
    seedInput: opts.seedInput ?? "test seed",
    origin: "human",
    status: "expert_game",
    configJson: JSON.stringify(DEFAULT_CONFIG),
  });
  testSessionIds.push(id);
  return id;
}

async function insertAction(opts: {
  sessionId: string;
  round: number;
  agentRole?: string;
  agentId?: string;
  actionType?: string;
  content?: string;
  confidence?: number;
  score?: number;
  targetIdeasJson?: string;
  reasoning?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await saveAgentAction({
    id,
    sessionId: opts.sessionId,
    round: opts.round,
    agentRole: opts.agentRole ?? "challenger",
    agentId: opts.agentId ?? `agent-${opts.round}`,
    actionType: opts.actionType ?? "propose",
    content: opts.content ?? '{"ideas":[]}',
    confidence: opts.confidence,
    targetIdeasJson: opts.targetIdeasJson,
    reasoning: opts.reasoning,
    score: opts.score,
  });
  testActionIds.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  if (testActionIds.length > 0) {
    const ph = testActionIds.map((_, i) => `$${i + 1}`).join(",");
    await db.unsafe(`DELETE FROM sige_agent_actions WHERE id IN (${ph})`, testActionIds);
    testActionIds.length = 0;
  }
  if (testSessionIds.length > 0) {
    const ph = testSessionIds.map((_, i) => `$${i + 1}`).join(",");
    await db.unsafe(`DELETE FROM sige_sessions WHERE id IN (${ph})`, testSessionIds);
    testSessionIds.length = 0;
  }
}

function authedGet(app: ReturnType<typeof createWebApp>, path: string, token = TEST_TOKEN): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ),
  );
}

function unauthGet(app: ReturnType<typeof createWebApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

// ─── DB lifecycle ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  process.env[SECRET_KEY] = TEST_TOKEN;
  await cleanup();
});

afterEach(async () => {
  await cleanup();
  delete process.env[SECRET_KEY];
  await closeDb();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/sige/sessions/:id/actions — response shape", () => {
  it("returns { success: true, data: { sessionId, rounds } } for a session with actions", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({ seedInput: "agent ledger test" });

    await insertAction({ sessionId, round: 1, agentRole: "challenger", content: '{"ideas":[{"title":"Idea A"}]}' });
    await insertAction({ sessionId, round: 1, agentRole: "defender", content: '{"ideas":[{"title":"Idea B"}]}' });

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: { sessionId: string; rounds: Array<{ round: number; actions: unknown[]; artifacts: unknown }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.sessionId).toBe(sessionId);
    expect(Array.isArray(body.data.rounds)).toBe(true);
    expect(body.data.rounds.length).toBeGreaterThanOrEqual(1);
  });

  it("each round entry has round number, actions array, and artifacts field", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    await insertAction({
      sessionId,
      round: 1,
      agentRole: "challenger",
      actionType: "propose",
      confidence: 0.75,
      reasoning: "test reasoning",
    });

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    const body = await res.json() as {
      data: { rounds: Array<{ round: number; actions: Array<Record<string, unknown>>; artifacts: unknown }> };
    };

    const r1 = body.data.rounds.find((r) => r.round === 1);
    expect(r1).toBeDefined();
    expect(r1!.round).toBe(1);
    expect(Array.isArray(r1!.actions)).toBe(true);
    // artifacts is null when no sige_simulation_results row exists
    expect(r1!.artifacts === null || typeof r1!.artifacts === "object").toBe(true);
  });

  it("each action record has required ledger fields", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    await insertAction({
      sessionId,
      round: 2,
      agentRole: "skeptic",
      agentId: "agent-skeptic-1",
      actionType: "challenge",
      content: '{"ideas":[{"title":"Test Idea","description":"desc"}]}',
      confidence: 0.55,
      score: 0.82,
      reasoning: "I challenge this idea",
      targetIdeasJson: '["idea-uuid-1"]',
    });

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    const body = await res.json() as {
      data: { rounds: Array<{ round: number; actions: Array<Record<string, unknown>> }> };
    };

    const r2 = body.data.rounds.find((r) => r.round === 2);
    expect(r2).toBeDefined();
    const action = r2!.actions[0] as Record<string, unknown>;
    expect(typeof action["agentId"]).toBe("string");
    expect(typeof action["role"]).toBe("string");
    expect(action["role"]).toBe("skeptic");
    expect(typeof action["actionType"]).toBe("string");
    expect(typeof action["content"]).toBe("string");
    expect(typeof action["confidence"]).toBe("number");
    expect(typeof action["createdAt"]).toBe("number");
    // score present when set
    expect(action["score"]).toBeCloseTo(0.82, 3);
    // targetIdeas is parsed array
    expect(Array.isArray(action["targetIdeas"])).toBe(true);
    expect((action["targetIdeas"] as string[])[0]).toBe("idea-uuid-1");
  });

  it("score is null in response when action has no score", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    await insertAction({ sessionId, round: 1 }); // no score

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    const body = await res.json() as {
      data: { rounds: Array<{ actions: Array<Record<string, unknown>> }> };
    };

    const action = body.data.rounds[0]?.actions[0] as Record<string, unknown>;
    expect(action["score"]).toBeNull();
  });
});

// ─── Bearer auth fail-closed ────────────────────────────────────────────────────

describe("GET /api/sige/sessions/:id/actions — auth", () => {
  it("401 when no Authorization header is sent (token configured in env)", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    const res = await unauthGet(app, `/api/sige/sessions/${sessionId}/actions`);
    expect(res.status).toBe(401);
  });

  it("401 when wrong bearer token is sent", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("200 when correct bearer token is sent", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    expect(res.status).toBe(200);
  });
});

// ─── Round filtering ───────────────────────────────────────────────────────────

describe("GET /api/sige/sessions/:id/actions?round=N — round filter", () => {
  it("returns only the requested round when ?round=1 is passed", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    await insertAction({ sessionId, round: 1, agentRole: "challenger" });
    await insertAction({ sessionId, round: 2, agentRole: "defender" });
    await insertAction({ sessionId, round: 3, agentRole: "synthesizer" });

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions?round=1`);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { rounds: Array<{ round: number }> } };
    const roundNumbers = body.data.rounds.map((r) => r.round);
    expect(roundNumbers).toContain(1);
    expect(roundNumbers).not.toContain(2);
    expect(roundNumbers).not.toContain(3);
  });

  it("returns all rounds when no round filter is applied", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    await insertAction({ sessionId, round: 1 });
    await insertAction({ sessionId, round: 2 });

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    const body = await res.json() as { data: { rounds: Array<{ round: number }> } };
    const rounds = body.data.rounds.map((r) => r.round);
    expect(rounds).toContain(1);
    expect(rounds).toContain(2);
  });

  it("400 when round param is not a positive integer", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions?round=notanumber`);
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("400 for round=0 (must be positive)", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions?round=0`);
    expect(res.status).toBe(400);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────────

describe("GET /api/sige/sessions/:id/actions — edge cases", () => {
  it("returns rounds=[] for a session with no agent actions", async () => {
    const app = createWebApp(makeMinimalDeps());
    const sessionId = await createTestSession({});

    const res = await authedGet(app, `/api/sige/sessions/${sessionId}/actions`);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { rounds: unknown[] } };
    expect(body.data.rounds).toEqual([]);
  });

  it("404 for an unknown session id (valid UUID but no row)", async () => {
    const app = createWebApp(makeMinimalDeps());
    const unknownId = crypto.randomUUID();

    const res = await authedGet(app, `/api/sige/sessions/${unknownId}/actions`);
    expect(res.status).toBe(404);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("400 for a non-UUID session id", async () => {
    const app = createWebApp(makeMinimalDeps());

    const res = await authedGet(app, "/api/sige/sessions/not-a-uuid/actions");
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });
});
