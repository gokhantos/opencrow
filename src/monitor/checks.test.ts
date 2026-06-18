/**
 * Unit tests for pure helper exported from checks.ts.
 *
 * Lane: unit (no DB, no mock.module).
 *
 * parseDfCapacityPercent — exercises the POSIX `df -P` parser across Linux,
 * macOS, empty output, and malformed output. Tests are deterministic and do not
 * spawn any process.
 */
import { describe, test, expect } from "bun:test";
import { parseDfCapacityPercent } from "./checks";

// Representative output from `df -P /` on GNU/Linux (ext4, procps 3.x)
const LINUX_DF_OUTPUT = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/vda1        51473908  12345678  36561618      26% /`;

// Representative output from `df -P /` on macOS 14 (APFS)
const MACOS_DF_OUTPUT = `Filesystem   512-blocks      Used Available Capacity iused               ifree %iused  Mounted on
/dev/disk3s3s1 1942700136 648040888 717449408    48% 3516498 7174494080    0%   /`;

// macOS with high disk usage (should trigger warning threshold)
const MACOS_HIGH_USAGE_OUTPUT = `Filesystem   512-blocks      Used Available Capacity iused               ifree %iused  Mounted on
/dev/disk3s3s1 1942700136 1800000000 142700136    93% 3516498 7174494080    0%   /`;

// Linux at 100%
const LINUX_FULL_OUTPUT = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        51473908  51473908         0     100% /`;

describe("parseDfCapacityPercent", () => {
  test("parses Linux df -P output correctly", () => {
    expect(parseDfCapacityPercent(LINUX_DF_OUTPUT)).toBe(26);
  });

  test("parses macOS df -P output correctly", () => {
    expect(parseDfCapacityPercent(MACOS_DF_OUTPUT)).toBe(48);
  });

  test("parses high usage (93%) on macOS", () => {
    expect(parseDfCapacityPercent(MACOS_HIGH_USAGE_OUTPUT)).toBe(93);
  });

  test("parses 100% on Linux", () => {
    expect(parseDfCapacityPercent(LINUX_FULL_OUTPUT)).toBe(100);
  });

  test("returns null for empty output", () => {
    expect(parseDfCapacityPercent("")).toBeNull();
  });

  test("returns null for whitespace-only output", () => {
    expect(parseDfCapacityPercent("   \n  ")).toBeNull();
  });

  test("returns null when no field ends with %", () => {
    // Header only — no data line with a % field
    const noPercent = `Filesystem     1024-blocks      Used Available Capacity Mounted on`;
    expect(parseDfCapacityPercent(noPercent)).toBeNull();
  });

  test("returns null when percent field is not a finite number", () => {
    const malformed = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        51473908  51473908         0     NaN% /`;
    expect(parseDfCapacityPercent(malformed)).toBeNull();
  });

  test("returns null for completely malformed output", () => {
    expect(parseDfCapacityPercent("not a df output at all")).toBeNull();
  });

  test("uses the last line — handles extra trailing newlines", () => {
    // df sometimes appends a trailing newline; trim() should handle it
    const withTrailingNewline = `${LINUX_DF_OUTPUT}\n`;
    expect(parseDfCapacityPercent(withTrailingNewline)).toBe(26);
  });

  test("handles single-line output (no header)", () => {
    // Edge case: some minimal df implementations emit only the data line
    const oneLiner = `/dev/sda1  51473908  12000000  39473908  24% /`;
    expect(parseDfCapacityPercent(oneLiner)).toBe(24);
  });

  test("returns the last line's percent, not earlier lines", () => {
    // Multi-filesystem df output — the last line for / should win
    const multi = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda2        10000000   5000000   5000000      50% /boot
/dev/sda1        51473908  12345678  36561618      26% /`;
    expect(parseDfCapacityPercent(multi)).toBe(26);
  });
});
