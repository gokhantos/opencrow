import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMonitorRunner } from "./runner";
import type { DeliveryStore } from "../cron/delivery-store";
import type { AlertStore } from "./alert-store";
import type { MonitorConfig } from "./types";

// Mock the checks module
const mockCheckResults = { value: [] as any[] };
mock.module("./checks", () => ({
  runAllChecks: async () => mockCheckResults.value,
}));

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

describe("createMonitorRunner", () => {
  beforeEach(() => {
    mockCheckResults.value = [];
  });

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
  });

  test("does not enqueue when no alerts", async () => {
    mockCheckResults.value = [];
    const deliveryStore = createMockDeliveryStore();
    const alertStore = createMockAlertStore();
    const runner = createMonitorRunner({
      config: { ...defaultConfig, checkIntervalMs: 100_000 },
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    // Wait for initial check to complete
    await new Promise((r) => setTimeout(r, 100));
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
      config: { ...defaultConfig, checkIntervalMs: 100_000 },
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await new Promise((r) => setTimeout(r, 100));
    runner.stop();

    expect(deliveryStore.enqueued).toHaveLength(1);
    expect(deliveryStore.enqueued[0].chatId).toBe("12345");
    expect(deliveryStore.enqueued[0].text).toContain("Process agent is dead");
    expect(deliveryStore.enqueued[0].preformatted).toBe(true);
    expect(alertStore.recorded).toHaveLength(1);
    expect(alertStore.recorded[0].level).toBe("critical");
  });

  test("deduplicates repeated alerts", async () => {
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
    // Use short interval for test
    const runner = createMonitorRunner({
      config: {
        ...defaultConfig,
        checkIntervalMs: 50,
        alertCooldownMs: 60_000,
      },
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    // Wait for 2 check cycles
    await new Promise((r) => setTimeout(r, 200));
    runner.stop();

    // Should only fire once due to cooldown
    expect(deliveryStore.enqueued).toHaveLength(1);
    expect(alertStore.recorded).toHaveLength(1);
  });

  test("sends resolved message when condition clears", async () => {
    // First cycle: alert fires
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
      config: { ...defaultConfig, checkIntervalMs: 50 },
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await new Promise((r) => setTimeout(r, 80));

    // Second cycle: condition cleared
    mockCheckResults.value = [];
    await new Promise((r) => setTimeout(r, 100));
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
      config: { ...defaultConfig, checkIntervalMs: 100_000 },
      deliveryStore,
      alertStore,
      telegramChatId: "12345",
    });

    runner.start();
    await new Promise((r) => setTimeout(r, 100));
    runner.stop();

    // One message containing both alerts
    expect(deliveryStore.enqueued).toHaveLength(1);
    expect(deliveryStore.enqueued[0].text).toContain("[MONITOR] 2 issues");
    // But two DB records
    expect(alertStore.recorded).toHaveLength(2);
  });
});
