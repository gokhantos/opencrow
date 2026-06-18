import { test, expect } from "bun:test";
import { C, formatBytes, rgba } from "./types";

/* ---------- C (design tokens) ---------- */

test("C.teal is a valid hex color", () => {
  expect(C.teal).toMatch(/^#[0-9a-f]{6}$/i);
});

test("C.purple is a valid hex color", () => {
  expect(C.purple).toMatch(/^#[0-9a-f]{6}$/i);
});

test("C.red is a valid hex color", () => {
  expect(C.red).toMatch(/^#[0-9a-f]{6}$/i);
});

test("C.amber is a valid hex color", () => {
  expect(C.amber).toMatch(/^#[0-9a-f]{6}$/i);
});

test("C.blue is a valid hex color", () => {
  expect(C.blue).toMatch(/^#[0-9a-f]{6}$/i);
});

test("C.deepPurple is a valid hex color", () => {
  expect(C.deepPurple).toMatch(/^#[0-9a-f]{6}$/i);
});

/* ---------- formatBytes ---------- */

test("formatBytes: 0 bytes", () => {
  expect(formatBytes(0)).toBe("0 B");
});

test("formatBytes: kilobytes", () => {
  expect(formatBytes(1024)).toBe("1.0 KB");
});

test("formatBytes: megabytes", () => {
  expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
});

test("formatBytes: gigabytes", () => {
  expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
});

test("formatBytes: terabytes", () => {
  expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TB");
});

test("formatBytes: fractional GB", () => {
  expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
});

test("formatBytes: 512 bytes", () => {
  expect(formatBytes(512)).toBe("512.0 B");
});

test("formatBytes: 1.5 KB", () => {
  expect(formatBytes(1536)).toBe("1.5 KB");
});

/* ---------- rgba ---------- */

test("rgba: fully opaque teal", () => {
  // C.teal = #2dd4bf => r=45, g=212, b=191
  expect(rgba("#2dd4bf", 1)).toBe("rgba(45,212,191,1)");
});

test("rgba: semi-transparent", () => {
  expect(rgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
});

test("rgba: zero alpha", () => {
  expect(rgba("#000000", 0)).toBe("rgba(0,0,0,0)");
});

test("rgba: white fully opaque", () => {
  expect(rgba("#ffffff", 1)).toBe("rgba(255,255,255,1)");
});

test("rgba: output starts with rgba(", () => {
  const result = rgba(C.purple, 0.3);
  expect(result).toMatch(/^rgba\(/);
});

test("rgba: output ends with )", () => {
  const result = rgba(C.blue, 0.1);
  expect(result).toMatch(/\)$/);
});

test("rgba: alpha value is preserved in output", () => {
  const result = rgba("#aabbcc", 0.25);
  expect(result).toContain("0.25");
});
