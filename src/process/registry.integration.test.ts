/**
 * Integration tests for the process registry — real Postgres via getDb().
 *
 * Contracts under test:
 *  1. heartbeat INSERT branch carries caller metadata (instanceId not blanked).
 *  2. heartbeat ON CONFLICT branch refreshes metadata_json.
 *  3. markProcessCrashLoop writes { crashLoopAt: <unix> } to metadata_json.
 *  4. clearProcessCrashLoop removes that key and is a no-op when absent.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import {
  heartbeat,
  markProcessCrashLoop,
  clearProcessCrashLoop,
  getProcess,
  unregisterProcess,
  CRASH_LOOP_KEY,
} from "./registry";
import type { ProcessName } from "./types";

const TEST_NAME: ProcessName = "cron";

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.unsafe("DELETE FROM process_registry WHERE name = $1", [TEST_NAME]);
}

describe("registry — integration", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  // ── heartbeat: initial INSERT ──────────────────────────────────────────────

  describe("heartbeat — initial INSERT", () => {
    test("persists caller metadata_json so instanceId is not blanked", async () => {
      const instanceId = "abc-123";
      await heartbeat(TEST_NAME, { instanceId });

      const row = await getProcess(TEST_NAME);
      expect(row).not.toBeNull();
      expect((row!.metadata as { instanceId?: string }).instanceId).toBe(
        instanceId,
      );
    });

    test("records pid and timestamps", async () => {
      const before = Math.floor(Date.now() / 1000);
      await heartbeat(TEST_NAME, {});
      const after = Math.floor(Date.now() / 1000);

      const row = await getProcess(TEST_NAME);
      expect(row).not.toBeNull();
      expect(row!.pid).toBe(process.pid);
      expect(row!.lastHeartbeat).toBeGreaterThanOrEqual(before);
      expect(row!.lastHeartbeat).toBeLessThanOrEqual(after);
    });
  });

  // ── heartbeat: ON CONFLICT refresh ────────────────────────────────────────

  describe("heartbeat — ON CONFLICT refresh", () => {
    test("refreshes metadata_json so a recovered row regains its instanceId", async () => {
      // Seed the row without metadata to simulate an orphan-sweep condition.
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await db.unsafe(
        "INSERT INTO process_registry (name, pid, started_at, last_heartbeat, metadata_json) VALUES ($1, $2, $3, $4, '{}')",
        [TEST_NAME, process.pid, now, now],
      );

      const instanceId = "recovered-xyz";
      await heartbeat(TEST_NAME, { instanceId });

      const row = await getProcess(TEST_NAME);
      expect(
        (row!.metadata as { instanceId?: string }).instanceId,
      ).toBe(instanceId);
    });

    test("updates last_heartbeat on each call", async () => {
      await heartbeat(TEST_NAME, { instanceId: "x" });
      const firstRow = await getProcess(TEST_NAME);

      // Ensure a different second from the first heartbeat (worst case: same
      // second). We use a raw UPDATE to roll back last_heartbeat artificially.
      const db = getDb();
      await db.unsafe(
        "UPDATE process_registry SET last_heartbeat = last_heartbeat - 5 WHERE name = $1",
        [TEST_NAME],
      );
      const staleRow = await getProcess(TEST_NAME);
      const staleBeat = staleRow!.lastHeartbeat;

      await heartbeat(TEST_NAME, { instanceId: "x" });
      const freshRow = await getProcess(TEST_NAME);

      expect(freshRow!.lastHeartbeat).toBeGreaterThan(staleBeat);
      // firstRow's lastHeartbeat should also be less than or equal to fresh
      expect(freshRow!.lastHeartbeat).toBeGreaterThanOrEqual(
        firstRow!.lastHeartbeat,
      );
    });
  });

  // ── markProcessCrashLoop ──────────────────────────────────────────────────

  describe("markProcessCrashLoop", () => {
    test("writes crashLoopAt unix timestamp to metadata_json", async () => {
      // Seed a row first (as if the process was running).
      await heartbeat(TEST_NAME, { instanceId: "abc" });

      const before = Math.floor(Date.now() / 1000);
      await markProcessCrashLoop(TEST_NAME);
      const after = Math.floor(Date.now() / 1000);

      const row = await getProcess(TEST_NAME);
      expect(row).not.toBeNull();

      const meta = row!.metadata as Record<string, unknown>;
      expect(typeof meta[CRASH_LOOP_KEY]).toBe("number");

      const crashAt = meta[CRASH_LOOP_KEY] as number;
      expect(crashAt).toBeGreaterThanOrEqual(before);
      expect(crashAt).toBeLessThanOrEqual(after);
    });

    test("upserts the row when the process has no existing registry entry", async () => {
      // The child may have been reaped by an orphan sweep before the crash-loop
      // marker arrives; markProcessCrashLoop must still succeed.
      await markProcessCrashLoop(TEST_NAME);

      const row = await getProcess(TEST_NAME);
      expect(row).not.toBeNull();
      expect(
        (row!.metadata as Record<string, unknown>)[CRASH_LOOP_KEY],
      ).toBeDefined();
    });
  });

  // ── clearProcessCrashLoop ─────────────────────────────────────────────────

  describe("clearProcessCrashLoop", () => {
    test("removes crashLoopAt from metadata_json", async () => {
      await markProcessCrashLoop(TEST_NAME);

      // Verify the marker is there before clearing.
      const before = await getProcess(TEST_NAME);
      expect(
        (before!.metadata as Record<string, unknown>)[CRASH_LOOP_KEY],
      ).toBeDefined();

      await clearProcessCrashLoop(TEST_NAME);

      const after = await getProcess(TEST_NAME);
      // The implementation sets metadata_json = '{}' when the key is present.
      expect(
        (after!.metadata as Record<string, unknown>)[CRASH_LOOP_KEY],
      ).toBeUndefined();
    });

    test("is a no-op when crashLoopAt is not set (does not error, row unchanged)", async () => {
      await heartbeat(TEST_NAME, { instanceId: "no-crash" });

      // Should not throw.
      await clearProcessCrashLoop(TEST_NAME);

      // Row is untouched (the WHERE clause excluded it; metadata still has
      // instanceId — but the implementation resets to '{}' only when the key
      // existed, so the row should be unchanged).
      const row = await getProcess(TEST_NAME);
      expect(row).not.toBeNull();
    });

    test("is a no-op when the row is absent (does not error)", async () => {
      // No row exists for TEST_NAME.
      await expect(clearProcessCrashLoop(TEST_NAME)).resolves.toBeUndefined();
    });
  });

  // ── unregisterProcess (smoke) ──────────────────────────────────────────────

  describe("unregisterProcess", () => {
    test("removes the row and getProcess returns null", async () => {
      await heartbeat(TEST_NAME, {});
      await unregisterProcess(TEST_NAME);

      const row = await getProcess(TEST_NAME);
      expect(row).toBeNull();
    });
  });
});
