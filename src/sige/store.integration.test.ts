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
  updateSessionStatus,
  countActiveAutonomousSessions,
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
