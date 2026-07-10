import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyLogFreshness,
  coreLogPath,
  extractNewestLogTimestampMs,
  FRESH_MAX_AGE_MS,
  formatAge,
  readLogTail,
  STALE_MAX_AGE_MS,
} from "./log-freshness.ts";

describe("extractNewestLogTimestampMs", () => {
  it("returns the newest timestamp regardless of line order", () => {
    const text = [
      "2026-07-10T12:53:11.255Z [INFO] [reddit-feed] a",
      "2026-07-10T12:55:00.511Z [INFO] [appstore] b",
      "2026-07-10T12:54:00.000Z [INFO] [ingestion] c",
    ].join("\n");
    expect(extractNewestLogTimestampMs(text)).toBe(
      Date.parse("2026-07-10T12:55:00.511Z"),
    );
  });

  it("parses timestamps without milliseconds", () => {
    expect(extractNewestLogTimestampMs("2026-07-10T12:55:00Z x")).toBe(
      Date.parse("2026-07-10T12:55:00Z"),
    );
  });

  it("ignores non-timestamp noise like guardian markers", () => {
    expect(extractNewestLogTimestampMs("GUARDIAN: Starting OpenCrow via bun")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractNewestLogTimestampMs("")).toBeNull();
  });
});

describe("formatAge", () => {
  it("formats sub-minute as seconds", () => {
    expect(formatAge(4_000)).toBe("4s");
  });
  it("formats minutes", () => {
    expect(formatAge(3 * 60_000)).toBe("3m");
  });
  it("formats hours and minutes", () => {
    expect(formatAge(2 * 60 * 60_000 + 14 * 60_000)).toBe("2h14m");
  });
  it("formats whole hours without trailing 0m", () => {
    expect(formatAge(3 * 60 * 60_000)).toBe("3h");
  });
  it("clamps negatives to 0s", () => {
    expect(formatAge(-5_000)).toBe("0s");
  });
});

describe("classifyLogFreshness", () => {
  // 15:56 local; the freshest UTC line is earlier-hour but same instant.
  const now = Date.parse("2026-07-10T12:56:00Z");

  it("passes and labels a live log (the timezone-illusion case)", () => {
    const newest = Date.parse("2026-07-10T12:55:56Z"); // 4s ago
    const v = classifyLogFreshness(newest, now);
    expect(v.status).toBe("pass");
    expect(v.message).toContain("Live");
    expect(v.message).toContain("4s ago");
    expect(v.message).toContain("12:55:56.000Z");
    expect(v.message.toLowerCase()).toContain("local");
    expect(v.message).toContain("UTC");
  });

  it("passes right at the fresh boundary", () => {
    expect(classifyLogFreshness(now - FRESH_MAX_AGE_MS, now).status).toBe("pass");
  });

  it("warns when older than fresh but within stale window", () => {
    const v = classifyLogFreshness(now - (FRESH_MAX_AGE_MS + 60_000), now);
    expect(v.status).toBe("warn");
    expect(v.repair).toBeDefined();
  });

  it("fails when older than the stale window", () => {
    const v = classifyLogFreshness(now - (STALE_MAX_AGE_MS + 60_000), now);
    expect(v.status).toBe("fail");
    expect(v.message).toContain("wedged");
    expect(v.repair).toContain("restart");
  });

  it("warns on a future-dated timestamp (clock skew)", () => {
    const v = classifyLogFreshness(now + 5 * 60_000, now);
    expect(v.status).toBe("warn");
    expect(v.message).toContain("future");
  });

  it("tolerates sub-minute future skew as fresh", () => {
    const v = classifyLogFreshness(now + 10_000, now);
    expect(v.status).toBe("pass");
  });

  it("warns when there is no parseable timestamp", () => {
    expect(classifyLogFreshness(null, now).status).toBe("warn");
  });
});

describe("readLogTail", () => {
  const tmpFiles: string[] = [];
  function tmp(name: string): string {
    const f = path.join(os.tmpdir(), `oc-logfresh-${Date.now()}-${name}`);
    tmpFiles.push(f);
    return f;
  }
  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // best effort
      }
    }
  });

  it("returns only the last maxBytes of a large file", () => {
    const f = tmp("big.log");
    const head = "X".repeat(1000);
    const tailMarker = "\n2026-07-10T12:55:00Z TAIL\n";
    fs.writeFileSync(f, head + tailMarker);
    const out = readLogTail(f, 64);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(64);
    expect(out).toContain("TAIL");
    expect(out).not.toContain("X".repeat(1000));
  });

  it("returns the whole file when smaller than maxBytes", () => {
    const f = tmp("small.log");
    fs.writeFileSync(f, "2026-07-10T12:55:00Z hi");
    expect(readLogTail(f, 64 * 1024)).toBe("2026-07-10T12:55:00Z hi");
  });

  it("returns null for an empty file", () => {
    const f = tmp("empty.log");
    fs.writeFileSync(f, "");
    expect(readLogTail(f)).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readLogTail(path.join(os.tmpdir(), "does-not-exist-oc.log"))).toBeNull();
  });
});

describe("coreLogPath", () => {
  it("resolves under ~/.opencrow/logs", () => {
    expect(coreLogPath("/home/x")).toBe("/home/x/.opencrow/logs/opencrow.err.log");
  });
});
