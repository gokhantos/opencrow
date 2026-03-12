import { test, expect } from "bun:test";
import { providerLabel, getInitials, shortModel } from "./types";

/* ---------- providerLabel ---------- */

test("providerLabel returns 'Agent SDK' for agent-sdk", () => {
  expect(providerLabel("agent-sdk")).toBe("Agent SDK");
});

test("providerLabel returns 'Alibaba' for alibaba", () => {
  expect(providerLabel("alibaba")).toBe("Alibaba");
});

test("providerLabel returns 'OpenRouter' for openrouter", () => {
  expect(providerLabel("openrouter")).toBe("OpenRouter");
});

/* ---------- getInitials ---------- */

test("getInitials returns first letters of each word uppercased", () => {
  expect(getInitials("OpenCrow Bot")).toBe("OB");
});

test("getInitials limits to 2 characters", () => {
  expect(getInitials("My Great Bot Name")).toBe("MG");
});

test("getInitials handles single word", () => {
  expect(getInitials("opencrow")).toBe("O");
});

test("getInitials handles empty string", () => {
  expect(getInitials("")).toBe("");
});

test("getInitials handles lowercase", () => {
  expect(getInitials("crypto analyzer")).toBe("CA");
});

/* ---------- shortModel ---------- */

test("shortModel returns 'Default' for empty string", () => {
  expect(shortModel("")).toBe("Default");
});

test("shortModel returns last segment of slash-separated model", () => {
  expect(shortModel("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
});

test("shortModel returns full name for non-slashed model", () => {
  expect(shortModel("gpt-4o")).toBe("gpt-4o");
});

test("shortModel truncates names longer than 28 chars", () => {
  const longName = "anthropic/claude-opus-4-20250514-super-extended-v2";
  const result = shortModel(longName);
  expect(result.length).toBeLessThanOrEqual(28);
  expect(result).toEndWith("...");
});

test("shortModel does not truncate names at 28 chars or shorter", () => {
  const model = "anthropic/claude-sonnet-4-6";
  const result = shortModel(model);
  expect(result).not.toContain("...");
});
