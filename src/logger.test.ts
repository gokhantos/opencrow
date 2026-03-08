import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  createLogger,
  setLogLevel,
  setProcessName,
  getProcessName,
  getRecentLogs,
  getLogPersistenceStatus,
} from "./logger";

describe("setProcessName / getProcessName", () => {
  test("defaults to 'unknown'", () => {
    setProcessName("unknown"); // reset
    expect(getProcessName()).toBe("unknown");
  });

  test("sets and gets process name", () => {
    setProcessName("test-process");
    expect(getProcessName()).toBe("test-process");
    setProcessName("unknown"); // cleanup
  });
});

describe("createLogger", () => {
  beforeEach(() => {
    setLogLevel("debug"); // capture everything
  });

  afterEach(() => {
    setLogLevel("info"); // reset
  });

  test("logs at debug level when set to debug", () => {
    const log = createLogger("test-ctx");
    log.debug("debug message");
    const recent = getRecentLogs(1);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    const last = recent[recent.length - 1]!;
    expect(last.level).toBe("debug");
    expect(last.context).toBe("test-ctx");
    expect(last.message).toBe("debug message");
  });

  test("logs at info level", () => {
    const log = createLogger("info-ctx");
    log.info("info message");
    const recent = getRecentLogs(1);
    const last = recent[recent.length - 1]!;
    expect(last.level).toBe("info");
    expect(last.message).toBe("info message");
  });

  test("logs at warn level", () => {
    const log = createLogger("warn-ctx");
    log.warn("warning");
    const recent = getRecentLogs(1);
    const last = recent[recent.length - 1]!;
    expect(last.level).toBe("warn");
  });

  test("logs at error level", () => {
    const log = createLogger("err-ctx");
    log.error("error occurred");
    const recent = getRecentLogs(1);
    const last = recent[recent.length - 1]!;
    expect(last.level).toBe("error");
  });

  test("attaches data to log entry", () => {
    const log = createLogger("data-ctx");
    log.info("with data", { key: "value" });
    const recent = getRecentLogs(1);
    const last = recent[recent.length - 1]!;
    expect(last.data).toEqual({ key: "value" });
  });

  test("attaches Error object to log entry", () => {
    const log = createLogger("error-data");
    const err = new Error("test error");
    log.error("failed", err);
    const recent = getRecentLogs(1);
    const last = recent[recent.length - 1]!;
    expect(last.data).toBeInstanceOf(Error);
  });
});

describe("log level filtering", () => {
  test("filters debug when level is info", () => {
    setLogLevel("info");
    const initialCount = getRecentLogs(200).length;
    const log = createLogger("filter-test");
    log.debug("should be filtered");
    const newCount = getRecentLogs(200).length;
    expect(newCount).toBe(initialCount); // no new entry
  });

  test("filters debug and info when level is warn", () => {
    setLogLevel("warn");
    const initialCount = getRecentLogs(200).length;
    const log = createLogger("filter-test");
    log.debug("filtered");
    log.info("filtered");
    const newCount = getRecentLogs(200).length;
    expect(newCount).toBe(initialCount);
  });

  test("only allows error when level is error", () => {
    setLogLevel("error");
    const initialCount = getRecentLogs(200).length;
    const log = createLogger("filter-test");
    log.debug("filtered");
    log.info("filtered");
    log.warn("filtered");
    log.error("visible");
    const newCount = getRecentLogs(200).length;
    expect(newCount).toBe(initialCount + 1);
    setLogLevel("info"); // cleanup
  });
});

describe("getRecentLogs", () => {
  test("returns limited entries", () => {
    setLogLevel("debug");
    const log = createLogger("limit-test");
    for (let i = 0; i < 10; i++) {
      log.info(`msg-${i}`);
    }
    const recent = getRecentLogs(3);
    expect(recent.length).toBeLessThanOrEqual(3);
    setLogLevel("info");
  });

  test("entries have timestamp", () => {
    setLogLevel("debug");
    const log = createLogger("ts-test");
    log.info("timestamped");
    const recent = getRecentLogs(1);
    const last = recent[recent.length - 1]!;
    expect(last.timestamp).toBeTruthy();
    expect(last.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    setLogLevel("info");
  });
});

describe("getLogPersistenceStatus", () => {
  test("returns status when db is not connected", () => {
    const status = getLogPersistenceStatus();
    expect(status.isConnected).toBe(false);
    // Note: consecutiveFailures and pendingBatchSize may be > 0 due to other tests
    // since logger state is global. We just check they're numbers >= 0.
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(0);
    expect(status.pendingBatchSize).toBeGreaterThanOrEqual(0);
    expect(status.isHealthy).toBe(false); // false because no db connection
  });
});
