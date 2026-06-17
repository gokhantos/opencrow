import { test, expect, describe } from "bun:test";
import { parseJsonArrayLenient } from "./synthesizer";

describe("parseJsonArrayLenient", () => {
  test("parses a complete fenced JSON array", () => {
    const text = '```json\n[{"a":1},{"a":2}]\n```';
    expect(parseJsonArrayLenient(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("recovers complete elements from a TRUNCATED array (the bug)", () => {
    // Array cut off at the output-token cap mid-third-object.
    const text =
      '[{"title":"VaultMind","probability":0.82},{"title":"FlowForge","probability":0.6},{"title":"Inc';
    const got = parseJsonArrayLenient(text) as Array<{ title: string }>;
    expect(got).toHaveLength(2);
    expect(got.map((x) => x.title)).toEqual(["VaultMind", "FlowForge"]);
  });

  test("handles braces/brackets inside strings", () => {
    const text = '[{"summary":"uses [tags] and {braces}"},{"summary":"ok"}]';
    expect(parseJsonArrayLenient(text)).toHaveLength(2);
  });

  test("handles nested objects/arrays per element", () => {
    const text =
      '[{"idea":{"title":"X","keyFeatures":["a","b"]},"probability":0.5}]';
    const got = parseJsonArrayLenient(text) as Array<{ idea: { title: string } }>;
    expect(got).toHaveLength(1);
    expect(got[0]!.idea.title).toBe("X");
  });

  test("returns [] when no array present", () => {
    expect(parseJsonArrayLenient("no json here")).toEqual([]);
  });

  test("skips a malformed element but keeps the rest", () => {
    const text = '[{"a":1},{bad},{"a":3}]';
    const got = parseJsonArrayLenient(text) as Array<{ a: number }>;
    expect(got.map((x) => x.a)).toEqual([1, 3]);
  });
});
