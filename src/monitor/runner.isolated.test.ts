/**
 * Isolated tests for createMonitorRunner.
 *
 * All timing is deterministic: we replace the global setInterval/clearInterval
 * with a capturing fake (same pattern as src/process/child-lifecycle.test.ts)
 * so no real wall-clock delay is needed anywhere. The "immediate runChecks()"
 * that fires in start() is settled by awaiting a microtask flush helper.
 *
 * Lane: isolated (own process) because mock.module is used.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMonitorRunner } from "./runner";
import type { DeliveryStore } from "../cron/delivery-store";
import type { AlertStore } from "./alert-store";
import type { MonitorConfig } from "./types";

// ── Mock the checks module ─────────────────────────────────────────────────────

const mockCheckResults = { value: [] as any[] };
mock.module("./checks", () => ({
  runAllChecks: async () => mockCheckResults.value,
}));

// ── Fake timer harness ────────────────────────────────────────────────────────
// Captures the setInterval callback so tests can fire it manually.
// clearInterval marks the captured slot as cleared (mirrors runner.stop()).

interface CapturedInterval {
  fn: () => void;
  delay: number;
  cleared: boolean;
}

let capturedIntervals: CapturedInterval[];
let realSetInterval: typeof globalThis.setInterval;
let realClearInterval: typeof globalThis.clearInterval;

beforeEach(() => {
  capturedIntervals = [];
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;

  globalThis.setInterval = ((fn: () => void, delay: number) => {
    const slot: CapturedInterval = { fn, delay, cleared: false };
    capturedIntervals.push(slot);
    // Return the slot object itself as the handle so that:
    // (a) clearInterval can find the exact slot by reference, and
    // (b) the handle is always truthy (avoids the `if (timer)` check in
    //     runner.stop() treating a numeric 0 as falsy and skipping the call).
    return slot as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;

  globalThis.clearInterval = ((handle: unknown) => {
    const slot = handle as CapturedInterval | undefined;
    if (slot && "cleared" in slot) slot.cleared = true;
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  mockCheckResults.value = [];
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flush all pending microtasks so the immediate runChecks() in start() settles. */
async function flushMicrotasks(): Promise<void> {
  // Six awaits covers the typical async-chain depth in runChecks():
  // runAllChecks → handleResolved → handleNewAlerts → enqueueMessage → alertStore
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

/** Manually fire the captured interval callback and wait for it to settle. */
async function tickInterval(idx = 0): Promise<void> {
  const slot = capturedIntervals[idx];
  if (!slot) throw new Error(`No captured interval at index ${idx}`);
  slot.fn();
  await flushMicrotasks();
}

function createMockDeliveryStore(): DeliveryStore & { enqueued: any[] } {
  const enqueued: any[] = [];
  return {
    enqueued,
    async enqueue(delivery) {
      enqueued.push(delivery);
      return crypto.randomUUID();
    },
    async getPending() {
      return [];
    },
    async markDelivered() {},
  };
}

function createMockAlertStore(): AlertStore & {
  recorded: any[];
  resolved: any[];
} {
  const recorded: any[] = [];
  const resolved: any[] = [];
  return {
    recorded,
    resolved,
    async recordAlert(alert) {
      recorded.push(alert);
      return crypto.randomUUID();
    },
    async resolveAlert(category, title) {
      resolved.push({ category, title });
    },
    async getRecentAlerts() {
      return [];
    },
    async getActiveAlerts() {
      return [];
    },
  };
}

const defaultConfig: MonitorConfig = {
  checkIntervalMs: 60_000,
  alertCooldownMs: 1_800_000,
  thresholds: {
    processHeartbeatStaleSec: 60,
    errorCountWindow: 20,
    errorRatePercent: 10,
    errorWindowMinutes: 5,
    diskUsagePercent: 90,
    memoryUsagePercent: 90,
    cronConsecutiveFailures: 3,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createMonitorRunner", () => {
  test("start and stop work without errors", () => {
    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: defaultConfig,
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    runner.stop();
    // setInterval was called once, clearInterval marks it cleared
    expect(capturedIntervals).toHaveLength(1);
    expect(capturedIntervals[0]!.cleared).toBe(true);
  });

  test("does not enqueue when no alerts", async () => {
    mockCheckResults.value = [];
    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: defaultConfig,
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await flushMicrotasks();
    runner.stop();

    expect(deliveryStore.enqueued).toHaveLength(0);
    expect(alertStore.recorded).toHaveLength(0);
  });

  test("enqueues alert when check finds issues", async () => {
    mockCheckResults.value = [
      {
        category: "process",
        level: "critical",
        title: "Process agent is dead",
        detail: "No heartbeat for 185s",
        metric: 185,
        threshold: 60,
      },
    ];

    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: defaultConfig,
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await flushMicrotasks();
    runner.stop();

    expect(deliveryStore.enqueued).toHaveLength(1);
    expect(deliveryStore.enqueued[0].chatId).toBe("12345");
    expect(deliveryStore.enqueued[0].text).toContain("Process agent is dead");
    expect(deliveryStore.enqueued[0].preformatted).toBe(true);
    expect(alertStore.recorded).toHaveLength(1);
    expect(alertStore.recorded[0].level).toBe("critical");
  });

  test("deduplicates repeated alerts — fires only once across two cycles", async () => {
    mockCheckResults.value = [
      {
        category: "disk",
        level: "warning",
        title: "Disk usage at 92%",
        detail: "Root partition is 92% full",
      },
    ];

    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: { ...defaultConfig, alertCooldownMs: 60_000 },
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    // Cycle 1 (immediate on start)
    runner.start();
    await flushMicrotasks();

    // Cycle 2 (manual tick) — same alert, still within cooldown
    await tickInterval();

    runner.stop();

    // Should only fire once due to cooldown
    expect(deliveryStore.enqueued).toHaveLength(1);
    expect(alertStore.recorded).toHaveLength(1);
  });

  test("sends resolved message when condition clears after second cycle", async () => {
    // Cycle 1: alert fires
    mockCheckResults.value = [
      {
        category: "process",
        level: "warning",
        title: "Process cron is stale",
        detail: "No heartbeat for 75s",
      },
    ];

    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: defaultConfig,
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await flushMicrotasks();

    // Cycle 2: condition cleared
    mockCheckResults.value = [];
    await tickInterval();

    runner.stop();

    // Should have: 1 alert + 1 resolved
    expect(deliveryStore.enqueued.length).toBeGreaterThanOrEqual(2);
    const resolvedMsg = deliveryStore.enqueued.find((e: any) =>
      e.text.includes("[RESOLVED]"),
    );
    expect(resolvedMsg).toBeDefined();
    expect(resolvedMsg.text).toContain("Process cron is stale");
    expect(alertStore.resolved).toHaveLength(1);
    expect(alertStore.resolved[0].category).toBe("process");
  });

  test("batches multiple alerts in one message", async () => {
    mockCheckResults.value = [
      {
        category: "process",
        level: "critical",
        title: "Process agent is dead",
        detail: "No heartbeat",
      },
      {
        category: "disk",
        level: "warning",
        title: "Disk usage at 92%",
        detail: "Root partition full",
      },
    ];

    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: defaultConfig,
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await flushMicrotasks();
    runner.stop();

    // One message containing both alerts
    expect(deliveryStore.enqueued).toHaveLength(1);
    expect(deliveryStore.enqueued[0].text).toContain("[MONITOR] 2 issues");
    // But two DB records
    expect(alertStore.recorded).toHaveLength(2);
  });
});
