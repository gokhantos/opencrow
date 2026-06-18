/**
 * Integration tests for process commands — real Postgres via getDb().
 *
 * Key invariant under test: consumePendingCommands uses a single
 * UPDATE … WHERE acknowledged_at IS NULL RETURNING … (atomic claim) so that
 * two concurrent callers cannot both receive the same command.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import {
  sendCommand,
  consumePendingCommands,
} from "./commands";

const TEST_TARGET = "cron" as const;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.unsafe("DELETE FROM process_commands WHERE target = $1", [
    TEST_TARGET,
  ]);
}

describe("consumePendingCommands — integration", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  test("atomic claim: two concurrent consumers share pending commands without double-claim", async () => {
    // Insert two pending commands for the same target.
    await sendCommand(TEST_TARGET, "restart");
    await sendCommand(TEST_TARGET, "stop");

    // Run both consumers concurrently — they race on the UPDATE.
    const [resultA, resultB] = await Promise.all([
      consumePendingCommands(TEST_TARGET),
      consumePendingCommands(TEST_TARGET),
    ]);

    // Together they must have claimed exactly 2 distinct commands (no duplicates).
    const allIds = [
      ...resultA.map((c) => c.id),
      ...resultB.map((c) => c.id),
    ];
    expect(allIds.length).toBe(2);

    // Every id must appear exactly once across both results.
    const unique = new Set(allIds);
    expect(unique.size).toBe(2);

    // Each command was returned to exactly one caller.
    const idsA = new Set(resultA.map((c) => c.id));
    const idsB = new Set(resultB.map((c) => c.id));
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  test("already-acknowledged rows are excluded from a subsequent call", async () => {
    // Insert one command and consume it.
    await sendCommand(TEST_TARGET, "restart");
    const firstClaim = await consumePendingCommands(TEST_TARGET);
    expect(firstClaim).toHaveLength(1);

    // A second call sees an empty set — the row is already acknowledged.
    const secondClaim = await consumePendingCommands(TEST_TARGET);
    expect(secondClaim).toHaveLength(0);
  });

  test("returns all pending commands in created_at order, action and payload intact", async () => {
    await sendCommand(TEST_TARGET, "restart", { reason: "test" });
    await sendCommand(TEST_TARGET, "stop", { force: true });

    const claimed = await consumePendingCommands(TEST_TARGET);

    expect(claimed).toHaveLength(2);
    // The store sorts ascending by createdAt.
    expect(claimed[0]!.createdAt).toBeLessThanOrEqual(claimed[1]!.createdAt);

    const actions = claimed.map((c) => c.action);
    expect(actions).toContain("restart");
    expect(actions).toContain("stop");

    const restartCmd = claimed.find((c) => c.action === "restart");
    expect(restartCmd?.payload).toEqual({ reason: "test" });

    const stopCmd = claimed.find((c) => c.action === "stop");
    expect(stopCmd?.payload).toEqual({ force: true });
  });

  test("returns empty array when there are no pending commands", async () => {
    const result = await consumePendingCommands(TEST_TARGET);
    expect(result).toHaveLength(0);
  });

  test("commands for other targets are not claimed", async () => {
    await sendCommand("web", "restart");
    await sendCommand(TEST_TARGET, "stop");

    const claimed = await consumePendingCommands(TEST_TARGET);

    // Only the cron command is claimed.
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.action).toBe("stop");
    expect(claimed[0]!.target).toBe(TEST_TARGET);
  });
});
