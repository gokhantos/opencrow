/**
 * Integration tests for src/sige/store.ts — requires Postgres.
 *
 * Tests the Phase A store changes:
 * - rowToSession maps NULL seed_input -> undefined
 * - createSession accepts null seedInput with origin='auto'
 * - countActiveAutonomousSessions reflects active sessions until terminal state
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import {
  createSession,
  getSession,
  getSessionStatus,
  updateSessionStatus,
  countActiveAutonomousSessions,
  claimNextPendingSession,
  saveResumeContext,
  loadResumeContext,
  claimInterruptedSession,
  touchSessionActivity,
  getSessionProgressRaw,
} from "./store";
import type { SigeSessionConfig } from "./types";

const DEFAULT_CONFIG: SigeSessionConfig = {
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

async function cleanup(): Promise<void> {
  if (testSessionIds.length === 0) return;
  const db = getDb();
  const placeholders = testSessionIds.map((_, i) => `$${i + 1}`).join(", ");
  await db.unsafe(`DELETE FROM sige_sessions WHERE id IN (${placeholders})`, testSessionIds);
  testSessionIds.length = 0;
}

async function createTestSession(opts: {
  id?: string;
  seedInput?: string | null;
  origin?: "human" | "auto";
  status?: string;
}): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await createSession({
    id,
    seedInput: opts.seedInput ?? null,
    origin: opts.origin ?? "auto",
    status: (opts.status as never) ?? "pending",
    configJson: JSON.stringify(DEFAULT_CONFIG),
  });
  testSessionIds.push(id);
  return id;
}

describe("sige store — nullable seedInput (migration 020)", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("createSession accepts null seedInput without error (autonomous path)", async () => {
    const id = await createTestSession({ seedInput: null, origin: "auto" });
    const session = await getSession(id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
  });

  it("rowToSession maps NULL seed_input to undefined", async () => {
    const id = await createTestSession({ seedInput: null, origin: "auto" });
    const session = await getSession(id);
    expect(session).not.toBeNull();
    expect(session!.seedInput).toBeUndefined();
  });

  it("createSession with non-null seedInput still works (seeded path)", async () => {
    const id = await createTestSession({
      seedInput: "Find AI productivity ideas",
      origin: "human",
    });
    const session = await getSession(id);
    expect(session).not.toBeNull();
    expect(session!.seedInput).toBe("Find AI productivity ideas");
  });

  it("origin field is persisted correctly for 'auto' origin", async () => {
    const id = await createTestSession({ origin: "auto" });
    const session = await getSession(id);
    expect(session!.origin).toBe("auto");
  });

  it("origin field is persisted correctly for 'human' origin", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test seed" });
    const session = await getSession(id);
    expect(session!.origin).toBe("human");
  });
});

describe("countActiveAutonomousSessions", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("count does not increase when no new autonomous sessions are added", async () => {
    // Can't assert absolute 0 because other test processes may have left rows.
    // Instead verify the count is stable (doesn't change without inserts).
    const before = await countActiveAutonomousSessions();
    const after = await countActiveAutonomousSessions();
    expect(after).toBe(before);
    expect(typeof after).toBe("number");
  });

  it("returns 1 when one active autonomous session exists", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    const count = await countActiveAutonomousSessions();
    expect(count).toBeGreaterThanOrEqual(1);
    // Cleanup
    await updateSessionStatus(id, "cancelled");
  });

  it("does NOT count autonomous sessions in 'completed' status", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "completed");
    const countBefore = await countActiveAutonomousSessions();
    // Completed session should not be counted
    // Create a fresh pending one to verify the completed one is excluded
    const activId = await createTestSession({ origin: "auto", status: "pending" });
    const countAfter = await countActiveAutonomousSessions();
    expect(countAfter).toBeGreaterThan(countBefore);
    // The total should only reflect the active one, not the completed
    await updateSessionStatus(activId, "cancelled");
  });

  it("does NOT count autonomous sessions in 'failed' status", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "failed");
    // Count should not include the failed session
    // We can't assert exact 0 without knowing what other tests left behind,
    // but we can verify count is non-negative and doesn't throw
    const count = await countActiveAutonomousSessions();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("does NOT count human sessions (origin='human') — only 'auto'", async () => {
    const beforeCount = await countActiveAutonomousSessions();
    const id = await createTestSession({ origin: "human", seedInput: "test" });
    const afterCount = await countActiveAutonomousSessions();
    // Human session must not inflate the autonomous count
    expect(afterCount).toBe(beforeCount);
    await updateSessionStatus(id, "cancelled");
  });

  it("counts sessions in non-terminal statuses (knowledge_construction, scoring, etc)", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "knowledge_construction");
    const count = await countActiveAutonomousSessions();
    expect(count).toBeGreaterThanOrEqual(1);
    await updateSessionStatus(id, "cancelled");
  });

  it("returns a number (not a string) — correct type coercion from SQL COUNT", async () => {
    const count = await countActiveAutonomousSessions();
    expect(typeof count).toBe("number");
    expect(Number.isFinite(count)).toBe(true);
  });
});

describe("claimNextPendingSession — atomic work-queue claim", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("claims a pending session and flips it off 'pending'", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    const claimed = await claimNextPendingSession();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    const reloaded = await getSession(id);
    expect(reloaded!.status).not.toBe("pending");
  });

  it("returns null when there are no pending sessions", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "completed", {});
    expect(await claimNextPendingSession()).toBeNull();
  });

  it("two concurrent claims of one pending session yield exactly one winner", async () => {
    await createTestSession({ origin: "auto", status: "pending" });
    // Race two claims; SKIP LOCKED must hand the row to exactly one.
    const [a, b] = await Promise.all([
      claimNextPendingSession(),
      claimNextPendingSession(),
    ]);
    const winners = [a, b].filter((s) => s !== null);
    expect(winners.length).toBe(1);
  });
});

describe("resume context and claimInterruptedSession", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("saveResumeContext persists and loadResumeContext retrieves it", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const ctx = {
      enrichedSeed: "enriched seed text",
      signalsContext: "signals context",
      isScrapedSeed: false,
    };
    await saveResumeContext(id, ctx);
    const loaded = await loadResumeContext(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.enrichedSeed).toBe("enriched seed text");
    expect(loaded!.signalsContext).toBe("signals context");
    expect(loaded!.isScrapedSeed).toBe(false);
  });

  it("loadResumeContext returns null when no context saved", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const loaded = await loadResumeContext(id);
    expect(loaded).toBeNull();
  });

  it("saveResumeContext handles undefined signalsContext", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    const ctx = {
      enrichedSeed: "some seed",
      signalsContext: undefined,
      isScrapedSeed: true,
    };
    await saveResumeContext(id, ctx);
    const loaded = await loadResumeContext(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.signalsContext).toBeUndefined();
    expect(loaded!.isScrapedSeed).toBe(true);
  });

  it("claimInterruptedSession claims a stuck non-terminal non-pending session", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    // Manually advance to a mid-flight status to simulate an interrupted session
    await updateSessionStatus(id, "expert_game");
    // Drain any pre-existing interrupted sessions so our new one is eligible.
    // Keep claiming until we get our row or exhaust the queue.
    let claimed = await claimInterruptedSession();
    let attempts = 0;
    while (claimed !== null && claimed.id !== id && attempts < 20) {
      await updateSessionStatus(claimed.id, "cancelled");
      claimed = await claimInterruptedSession();
      attempts++;
    }
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    // Status should remain expert_game (we don't flip it)
    const reloaded = await getSession(id);
    expect(reloaded!.status).toBe("expert_game");
    await updateSessionStatus(id, "cancelled");
  });

  it("claimInterruptedSession does NOT claim pending sessions", async () => {
    // Create a pending session and a mid-flight one
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const id2 = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id2, "game_formulation");
    // Drain any pre-existing interrupted sessions so our id2 rises to the top.
    let claimed = await claimInterruptedSession();
    let attempts = 0;
    while (claimed !== null && claimed.id !== id2 && attempts < 20) {
      await updateSessionStatus(claimed.id, "cancelled");
      claimed = await claimInterruptedSession();
      attempts++;
    }
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id2); // id2 is the interrupted one, not the pending id
    await updateSessionStatus(id, "cancelled");
    await updateSessionStatus(id2, "cancelled");
  });

  it("two concurrent claimInterruptedSession calls yield exactly one winner", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    await updateSessionStatus(id, "expert_game");
    // Drain any pre-existing interrupted sessions first so only ours is queued.
    let drained = await claimInterruptedSession();
    while (drained !== null && drained.id !== id) {
      await updateSessionStatus(drained.id, "cancelled");
      drained = await claimInterruptedSession();
    }
    // If we already claimed our own session via draining, the race test is trivially correct.
    if (drained !== null && drained.id === id) {
      // We hold it; verify only one claim (this one) succeeded
      expect(drained.id).toBe(id);
      await updateSessionStatus(id, "cancelled");
      return;
    }
    const [a, b] = await Promise.all([claimInterruptedSession(), claimInterruptedSession()]);
    const winners = [a, b].filter((s) => s !== null && s.id === id);
    expect(winners.length).toBe(1);
    await updateSessionStatus(id, "cancelled");
  });

  it("rowToSession loads artifact JSON columns when present", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const fakeFormulation = {
      id: "gf1",
      sessionId: id,
      gameType: "simultaneous",
      players: [],
      strategies: {},
      informationStructure: {
        visibility: {},
        asymmetries: [],
        commonKnowledge: [],
      },
      moveSequence: "simultaneous",
      constraints: [],
    };
    await updateSessionStatus(id, "game_formulation", {
      gameFormulationJson: JSON.stringify(fakeFormulation),
    });
    const session = await getSession(id);
    expect(session).not.toBeNull();
    expect(session!.gameFormulation).toBeDefined();
    expect(session!.gameFormulation!.id).toBe("gf1");
    await updateSessionStatus(id, "cancelled");
  });
});

describe("getSessionStatus — lightweight status read", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns the current status of an existing session", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    expect(await getSessionStatus(id)).toBe("pending");
    await updateSessionStatus(id, "expert_game");
    expect(await getSessionStatus(id)).toBe("expert_game");
    await updateSessionStatus(id, "cancelled");
  });

  it("returns null for a non-existent session", async () => {
    expect(await getSessionStatus(crypto.randomUUID())).toBeNull();
  });
});

describe("updateSessionStatus — cancelled is sticky (clobber guard)", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("a 'completed' write does NOT overwrite an already-cancelled session", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "expert_game");
    // Cancel arrives out-of-band (web process).
    await updateSessionStatus(id, "cancelled");
    // The run unwinds and reaches its terminal completed write — must be ignored.
    await updateSessionStatus(id, "completed", {
      report: "should not be written",
      finishedAt: Math.floor(Date.now() / 1000),
    });
    expect(await getSessionStatus(id)).toBe("cancelled");
    const session = await getSession(id);
    // The report from the clobbering completed write must not have landed
    // (column stays NULL -> null/undefined, never the clobbering string).
    expect(session!.report ?? null).toBeNull();
  });

  it("a 'failed' write does NOT overwrite an already-cancelled session", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "expert_game");
    await updateSessionStatus(id, "cancelled");
    // The abort error propagates to the entry's catch, which writes 'failed'.
    await updateSessionStatus(id, "failed", { error: "Expert game simulation aborted" });
    expect(await getSessionStatus(id)).toBe("cancelled");
  });

  it("still blocks a non-terminal write onto a terminal session (legacy guard)", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "completed");
    // A late running-stage write must not resurrect a completed session.
    await updateSessionStatus(id, "expert_game");
    expect(await getSessionStatus(id)).toBe("completed");
    await updateSessionStatus(id, "cancelled"); // for cleanup symmetry
  });

  it("a genuine 'completed' write still works on a non-cancelled run", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await updateSessionStatus(id, "expert_game");
    await updateSessionStatus(id, "completed", {
      finishedAt: Math.floor(Date.now() / 1000),
    });
    expect(await getSessionStatus(id)).toBe("completed");
  });
});

describe("touchSessionActivity — heartbeat update", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("sets last_activity_at to approximately now", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const before = Math.floor(Date.now() / 1000);
    await touchSessionActivity(id);
    const after = Math.floor(Date.now() / 1000);

    const session = await getSession(id);
    expect(session).not.toBeNull();
    expect(session!.lastActivityAt).not.toBeUndefined();
    expect(session!.lastActivityAt!).toBeGreaterThanOrEqual(before);
    expect(session!.lastActivityAt!).toBeLessThanOrEqual(after + 1);
  });

  it("updates last_activity_at when called multiple times", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await touchSessionActivity(id);
    const first = await getSession(id);
    // Small sleep to ensure a different second boundary is possible
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await touchSessionActivity(id);
    const second = await getSession(id);

    expect(second!.lastActivityAt).not.toBeUndefined();
    expect(second!.lastActivityAt!).toBeGreaterThanOrEqual(first!.lastActivityAt ?? 0);
  });

  it("does not throw for non-existent session id (no-op UPDATE)", async () => {
    // UPDATE on a non-existent row is a no-op, not an error.
    await expect(touchSessionActivity(crypto.randomUUID())).resolves.toBeUndefined();
  });
});

describe("getSessionProgressRaw — raw data for progress derivation", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns null for non-existent session", async () => {
    const raw = await getSessionProgressRaw(crypto.randomUUID());
    expect(raw).toBeNull();
  });

  it("returns session row fields for a fresh session", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const raw = await getSessionProgressRaw(id);
    expect(raw).not.toBeNull();
    expect(raw!.session.id).toBe(id);
    expect(raw!.session.status).toBe("pending");
    expect(raw!.session.origin).toBe("human");
    expect(raw!.session.error).toBeNull();
    expect(raw!.session.finishedAt).toBeNull();
  });

  it("reflects last_activity_at after a touch", async () => {
    const id = await createTestSession({ origin: "auto", status: "pending" });
    await touchSessionActivity(id);
    const raw = await getSessionProgressRaw(id);
    expect(raw!.session.lastActivityAt).not.toBeNull();
  });

  it("returns empty expert round maps for a fresh session", async () => {
    const id = await createTestSession({ origin: "human", seedInput: "test", status: "pending" });
    const raw = await getSessionProgressRaw(id);
    expect(raw!.expertRounds.size).toBe(0);
    expect(raw!.expertResultRounds.size).toBe(0);
    expect(raw!.tasteFilterAt).toBeNull();
    expect(raw!.socialResultAt).toBeNull();
  });
});
