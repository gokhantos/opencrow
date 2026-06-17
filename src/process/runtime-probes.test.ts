import { describe, expect, it } from "bun:test";
import { isAncestorOf, isPidAlive, parsePpidFromStat } from "./runtime-probes";

describe("parsePpidFromStat", () => {
  it("parses a normal stat line", () => {
    // pid (comm) state ppid pgrp ...
    expect(parsePpidFromStat("8 (bun) S 11 8 8 0 -1 ...")).toBe(11);
  });

  it("handles a comm containing spaces and parentheses", () => {
    expect(parsePpidFromStat("8 (my (weird) proc) R 42 8 8 ...")).toBe(42);
  });

  it("returns null for unparseable input", () => {
    expect(parsePpidFromStat("garbage with no parens")).toBeNull();
    expect(parsePpidFromStat("")).toBeNull();
  });
});

describe("isPidAlive", () => {
  it("reports the current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("rejects invalid PIDs without throwing", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

describe("isAncestorOf", () => {
  it("is false when candidate equals self", () => {
    expect(isAncestorOf(process.pid, process.pid)).toBe(false);
  });
});
