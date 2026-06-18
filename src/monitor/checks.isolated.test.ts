/**
 * Isolated tests for checkCrashLoops() in checks.ts.
 *
 * Lane: isolated (own process) — required because mock.module is used to
 * replace ../process/registry so the real listProcesses() (which calls getDb()
 * / hits Postgres) is never invoked. Running in the unit lane would leak the
 * mock into other test files.
 *
 * Strategy: wire a fake listProcesses() that returns controlled ProcessRecord
 * values, call checkCrashLoops(), and assert the shape and content of the
 * returned CheckResult array. The mock is deterministic — no network, no DB,
 * no wall-clock (the function computes ageSec from Date.now() internally, but
 * we only assert the label/level/category, not the exact age string).
 */
import { describe, test, expect, mock } from "bun:test";
import type { ProcessRecord } from "../process/types";

// CRASH_LOOP_KEY = "crashLoopAt" — keep in sync with registry.ts
const CRASH_LOOP_KEY = "crashLoopAt";

// ── Registry mock ──────────────────────────────────────────────────────────────
// Must be declared before the import of the module under test so mock.module
// intercepts the require at module-evaluation time.

const mockProcesses: { value: ProcessRecord[] } = { value: [] };

mock.module("../process/registry", () => ({
  CRASH_LOOP_KEY,
  listProcesses: async () => mockProcesses.value,
  // Provide stubs for other named exports so TS doesn't complain if checks.ts
  // tries to import them at the top level (it only uses the two above).
  registerProcess: async () => {},
  heartbeat: async () => {},
  unregisterProcess: async () => {},
  markProcessCrashLoop: async () => {},
  clearProcessCrashLoop: async () => {},
  getProcess: async () => null,
}));

// Import AFTER mock.module is registered
const { checkCrashLoops } = await import("./checks");

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRecord(
  name: ProcessRecord["name"],
  metadata: Record<string, unknown> = {},
): ProcessRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    name,
    pid: 1234,
    startedAt: now - 300,
    lastHeartbeat: now - 120,
    metadata,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("checkCrashLoops", () => {
  test("returns empty array when no processes are registered", async () => {
    mockProcesses.value = [];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(0);
  });

  test("returns empty array when no process has crashLoopAt metadata", async () => {
    mockProcesses.value = [
      makeRecord("agent:worker", {}),
      makeRecord("cron", { someOtherKey: 123 }),
    ];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(0);
  });

  test("returns a critical alert for a process with crashLoopAt set", async () => {
    const crashedAt = Math.floor(Date.now() / 1000) - 300;
    mockProcesses.value = [
      makeRecord("agent:worker", { [CRASH_LOOP_KEY]: crashedAt }),
    ];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(1);

    const alert = results[0]!;
    expect(alert.category).toBe("process");
    expect(alert.level).toBe("critical");
    expect(alert.title).toContain("agent:worker");
    expect(alert.title).toContain("crash-loop");
    expect(alert.detail).toContain("agent:worker");
    expect(alert.detail).toContain("restart budget");
  });

  test("ignores crashLoopAt that is not a number (string value)", async () => {
    mockProcesses.value = [
      makeRecord("agent:worker", { [CRASH_LOOP_KEY]: "not-a-number" }),
    ];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(0);
  });

  test("ignores crashLoopAt when set to null", async () => {
    mockProcesses.value = [
      makeRecord("agent:worker", { [CRASH_LOOP_KEY]: null }),
    ];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(0);
  });

  test("ignores crashLoopAt when set to undefined", async () => {
    mockProcesses.value = [
      makeRecord("agent:worker", { [CRASH_LOOP_KEY]: undefined }),
    ];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(0);
  });

  test("produces one critical alert per crash-looped process", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockProcesses.value = [
      makeRecord("agent:alpha", { [CRASH_LOOP_KEY]: now - 60 }),
      makeRecord("agent:beta", {}),
      makeRecord("agent:gamma", { [CRASH_LOOP_KEY]: now - 600 }),
    ];
    const results = await checkCrashLoops();
    expect(results).toHaveLength(2);

    const names = results.map((r) => r.title);
    expect(names.some((t) => t.includes("agent:alpha"))).toBe(true);
    expect(names.some((t) => t.includes("agent:gamma"))).toBe(true);
  });

  test("crash alert title matches expected pattern", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockProcesses.value = [
      makeRecord("scraper:reddit", { [CRASH_LOOP_KEY]: now - 10 }),
    ];
    const results = await checkCrashLoops();
    // Title must say "Process <name> is in crash-loop"
    expect(results[0]!.title).toBe("Process scraper:reddit is in crash-loop");
  });

  test("detail mentions the process name", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockProcesses.value = [
      makeRecord("core", { [CRASH_LOOP_KEY]: now - 45 }),
    ];
    const results = await checkCrashLoops();
    expect(results[0]!.detail).toContain("core");
  });

  test("result has no metric or threshold fields (crash-loop has no numeric threshold)", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockProcesses.value = [
      makeRecord("cron", { [CRASH_LOOP_KEY]: now - 20 }),
    ];
    const results = await checkCrashLoops();
    const alert = results[0]!;
    expect(alert.metric).toBeUndefined();
    expect(alert.threshold).toBeUndefined();
  });
});
