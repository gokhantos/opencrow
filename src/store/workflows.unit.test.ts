import { test, expect, describe } from "bun:test";
import { parseJsonColumn } from "./workflows";

describe("parseJsonColumn", () => {
  test("null returns fallback", () => {
    expect(parseJsonColumn(null, "default")).toBe("default");
  });

  test("undefined returns fallback", () => {
    expect(parseJsonColumn(undefined, 42)).toBe(42);
  });

  test("valid JSON string returns parsed value", () => {
    expect(parseJsonColumn<Record<string, unknown>>('{"key":"value"}', {})).toEqual({ key: "value" });
  });

  test("invalid JSON string returns fallback", () => {
    expect(parseJsonColumn<unknown[]>("not-json{{{", [])).toEqual([]);
  });

  test("object value returned as-is", () => {
    const obj = { a: 1, b: 2 };
    expect(parseJsonColumn<Record<string, unknown>>(obj, {})).toBe(obj);
  });

  test("array value returned as-is", () => {
    const arr = [1, 2, 3];
    expect(parseJsonColumn<number[]>(arr, [])).toBe(arr);
  });

  test("number value returned as-is", () => {
    expect(parseJsonColumn(99, 0)).toBe(99);
  });

  test("empty string returns fallback (invalid JSON)", () => {
    expect(parseJsonColumn("", { x: 0 })).toEqual({ x: 0 });
  });

  test("nested JSON string parsed correctly", () => {
    const nested = JSON.stringify({ outer: { inner: [1, 2, 3] } });
    expect(parseJsonColumn<Record<string, unknown>>(nested, {})).toEqual({ outer: { inner: [1, 2, 3] } });
  });
});
