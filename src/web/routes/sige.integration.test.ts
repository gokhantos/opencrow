/**
 * Integration tests for the SIGE HTTP routes.
 *
 * Covers:
 * - DELETE /sige/sessions/:id — cancel endpoint
 * - GET /sige/ideas — cross-run aggregated ideas endpoint
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

async function get(
  app: ReturnType<typeof makeApp>,
  path: string,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
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

// ---------------------------------------------------------------------------
// GET /sige/ideas — cross-run aggregated ideas
// ---------------------------------------------------------------------------

/** Minimal zero breakdown for fixtures. */
const ZERO_BREAKDOWN = {
  diversityBonus: 0,
  buildingBonus: 0,
  surpriseBonus: 0,
  accuracyPenalty: 0,
  memoryReward: 0,
  coalitionStability: 0,
  signalCredibility: 0,
  socialViability: 0,
};

function makeExpertResultJson(
  rounds: Array<{
    roundNumber: number;
    ideas: Array<{ id: string; expertScore: number; proposedBy?: string }>;
  }>,
): string {
  return JSON.stringify({
    rounds: rounds.map((r) => ({
      roundNumber: r.roundNumber,
      roundType: "divergent_generation",
      agentActions: [],
      outcomes: {
        selectedIdeas: r.ideas.map((idea) => ({
          id: idea.id,
          title: `Title ${idea.id}`,
          description: `Desc ${idea.id}`,
          proposedBy: idea.proposedBy ?? "agent-1",
          round: r.roundNumber,
          expertScore: idea.expertScore,
          incentiveBreakdown: ZERO_BREAKDOWN,
          strategicMetadata: {
            paretoOptimal: false,
            dominantStrategy: false,
            evolutionarilyStable: false,
            nashEquilibrium: false,
          },
        })),
        eliminatedIdeas: [],
      },
    })),
    equilibria: [],
    rankedIdeas: [],
    metaGameHealth: {
      agentBalanceScores: {},
      diversityIndex: 0,
      convergenceRate: 0,
      noveltyScore: 0,
    },
  });
}

function makeFusedScoresJson(
  scores: Array<{ ideaId: string; socialScore: number; fusedScore: number }>,
): string {
  return JSON.stringify(
    scores.map((s) => ({
      ideaId: s.ideaId,
      expertScore: 0.5,
      socialScore: s.socialScore,
      fusedScore: s.fusedScore,
      alpha: 0.5,
      breakdown: ZERO_BREAKDOWN,
    })),
  );
}

/** Seed a sige_sessions row with expert_result_json and optional fused_scores_json. */
async function createSessionWithIdeas(opts: {
  id: string;
  expertResultJson: string;
  fusedScoresJson?: string;
  status?: string;
  origin?: string;
  seedInput?: string | null;
}) {
  const { id, expertResultJson, fusedScoresJson, status = "completed", origin = "human", seedInput = "test seed" } = opts;
  await createSession({
    id,
    seedInput: seedInput ?? undefined,
    origin: origin as "human" | "auto",
    status: status as never,
    configJson: MINIMAL_CONFIG_JSON,
  });
  const db = getDb();
  // Write the JSON columns directly via SQL since createSession doesn't accept them.
  if (fusedScoresJson !== undefined) {
    await db`
      UPDATE sige_sessions
      SET expert_result_json = ${expertResultJson},
          fused_scores_json  = ${fusedScoresJson}
      WHERE id = ${id}
    `;
  } else {
    await db`
      UPDATE sige_sessions
      SET expert_result_json = ${expertResultJson}
      WHERE id = ${id}
    `;
  }
}

describe("GET /sige/ideas — cross-run aggregated ideas", () => {
  // Track created session ids for cleanup.
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdIds) {
      await db`DELETE FROM sige_sessions WHERE id = ${id}`;
    }
    createdIds.length = 0;
  });

  it("200 with success+data shape for basic request", async () => {
    const id = randomUUID();
    createdIds.push(id);
    await createSessionWithIdeas({
      id,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [{ id: "idea-a", expertScore: 0.7 }] },
      ]),
    });

    const app = makeApp();
    const res = await get(app, "/sige/ideas");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { ideas: unknown[]; runs: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.ideas)).toBe(true);
    expect(Array.isArray(body.data.runs)).toBe(true);
  });

  it("returns the seeded idea in ideas[] with correct fields", async () => {
    const id = randomUUID();
    createdIds.push(id);
    await createSessionWithIdeas({
      id,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 2, ideas: [{ id: "idea-x", expertScore: 0.75 }] },
      ]),
    });

    const app = makeApp();
    const res = await get(app, `/sige/ideas?runId=${id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: {
        ideas: Array<{
          ideaId: string;
          expertScore: number;
          isFinal: boolean;
          runId: string;
          round: number;
        }>;
        runs: unknown[];
      };
    };

    const ideas = body.data.ideas;
    expect(ideas.length).toBeGreaterThanOrEqual(1);
    const idea = ideas.find((i) => i.ideaId === "idea-x");
    expect(idea).toBeDefined();
    expect(idea?.expertScore).toBe(0.75);
    expect(idea?.isFinal).toBe(false);
    expect(idea?.runId).toBe(id);
    expect(idea?.round).toBe(2);
  });

  it("finalOnly=true returns only ideas that have a fused score", async () => {
    const id = randomUUID();
    createdIds.push(id);
    await createSessionWithIdeas({
      id,
      expertResultJson: makeExpertResultJson([
        {
          roundNumber: 1,
          ideas: [
            { id: "idea-nonfinal", expertScore: 0.6 },
            { id: "idea-final", expertScore: 0.8 },
          ],
        },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-final", socialScore: 0.7, fusedScore: 0.75 },
      ]),
    });

    const app = makeApp();
    const res = await get(app, `/sige/ideas?finalOnly=true&runId=${id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: { ideas: Array<{ ideaId: string; isFinal: boolean }>; runs: unknown[] };
    };

    const ideas = body.data.ideas;
    // All returned ideas must be final
    expect(ideas.every((i) => i.isFinal === true)).toBe(true);
    // Only idea-final should be here
    expect(ideas.find((i) => i.ideaId === "idea-final")).toBeDefined();
    expect(ideas.find((i) => i.ideaId === "idea-nonfinal")).toBeUndefined();
  });

  it("runId filter restricts to the specified session", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    createdIds.push(id1, id2);

    await createSessionWithIdeas({
      id: id1,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [{ id: "idea-run1", expertScore: 0.6 }] },
      ]),
    });
    await createSessionWithIdeas({
      id: id2,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [{ id: "idea-run2", expertScore: 0.7 }] },
      ]),
    });

    const app = makeApp();
    const res = await get(app, `/sige/ideas?runId=${id1}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: { ideas: Array<{ runId: string }>; runs: unknown[] };
    };

    // Every returned idea belongs to id1
    expect(body.data.ideas.every((i) => i.runId === id1)).toBe(true);
  });

  it("minScore filters out ideas below the threshold", async () => {
    const id = randomUUID();
    createdIds.push(id);
    await createSessionWithIdeas({
      id,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [{ id: "idea-low", expertScore: 0.2 }] },
        { roundNumber: 1, ideas: [{ id: "idea-high", expertScore: 0.9 }] },
      ]),
    });

    const app = makeApp();
    const res = await get(app, `/sige/ideas?runId=${id}&minScore=0.5`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: { ideas: Array<{ ideaId: string }>; runs: unknown[] };
    };

    const ids = body.data.ideas.map((i) => i.ideaId);
    expect(ids).not.toContain("idea-low");
    expect(ids).toContain("idea-high");
  });

  it("runs[] summary contains only runs with matching ideas", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    createdIds.push(id1, id2);

    await createSessionWithIdeas({
      id: id1,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [{ id: "idea-a", expertScore: 0.8 }] },
      ]),
    });
    // id2 row has no expert_result_json → contributes no ideas
    await createSession({
      id: id2,
      seedInput: "seed-2",
      origin: "human",
      status: "pending" as never,
      configJson: MINIMAL_CONFIG_JSON,
    });

    const app = makeApp();
    const res = await get(app, "/sige/ideas?limit=50");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: {
        ideas: Array<{ runId: string }>;
        runs: Array<{ runId: string }>;
      };
    };

    const runIds = body.data.runs.map((r) => r.runId);
    expect(runIds).toContain(id1);
    expect(runIds).not.toContain(id2);
  });

  it("400 when limit exceeds 50", async () => {
    const app = makeApp();
    const res = await get(app, "/sige/ideas?limit=999");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("400 when limit is below 1", async () => {
    const app = makeApp();
    const res = await get(app, "/sige/ideas?limit=0");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("400 when minScore is above 1", async () => {
    const app = makeApp();
    const res = await get(app, "/sige/ideas?minScore=5");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("default limit=25 applies when limit is not specified", async () => {
    const app = makeApp();
    const res = await get(app, "/sige/ideas");
    // Should not error — just checking it succeeds with the default
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("ideas with fused scores are marked isFinal=true and have socialScore/fusedScore set", async () => {
    const id = randomUUID();
    createdIds.push(id);
    await createSessionWithIdeas({
      id,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 4, ideas: [{ id: "idea-fused", expertScore: 0.8 }] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-fused", socialScore: 0.65, fusedScore: 0.73 },
      ]),
    });

    const app = makeApp();
    const res = await get(app, `/sige/ideas?runId=${id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: {
        ideas: Array<{
          ideaId: string;
          isFinal: boolean;
          socialScore: number | null;
          fusedScore: number | null;
          breakdown: unknown;
        }>;
        runs: unknown[];
      };
    };

    const idea = body.data.ideas.find((i) => i.ideaId === "idea-fused");
    expect(idea).toBeDefined();
    expect(idea?.isFinal).toBe(true);
    expect(idea?.socialScore).toBe(0.65);
    expect(idea?.fusedScore).toBe(0.73);
    expect(idea?.breakdown).not.toBeNull();
  });
});
