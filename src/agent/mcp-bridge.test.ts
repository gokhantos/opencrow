import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  jsonSchemaPropertyToZod,
  inputSchemaToZodShape,
  opencrowToolToSdkTool,
} from "./mcp-bridge";
import { computeToolResultBudget } from "./tool-result-budget";
import type { ToolDefinition } from "../tools/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal ToolDefinition whose execute() returns a fixed output. */
function makeToolDef(
  output: string,
  isError = false,
): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    categories: ["system"],
    execute: async (_input) => ({ output, isError }),
  };
}

// ─── jsonSchemaPropertyToZod — basic types ────────────────────────────────────

describe("jsonSchemaPropertyToZod — string basics", () => {
  test("accepts a valid string", () => {
    const schema = jsonSchemaPropertyToZod({ type: "string" });
    expect(schema.parse("hello")).toBe("hello");
  });

  test("rejects a non-string", () => {
    const schema = jsonSchemaPropertyToZod({ type: "string" });
    expect(() => schema.parse(123)).toThrow();
  });

  test("attaches description to schema", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      description: "A user name",
    });
    expect(schema.description).toBe("A user name");
  });
});

// ─── jsonSchemaPropertyToZod — string constraints (new, previously untested) ──

describe("jsonSchemaPropertyToZod — string minLength / maxLength", () => {
  test("minLength: accepts string at or above minimum", () => {
    const schema = jsonSchemaPropertyToZod({ type: "string", minLength: 3 });
    expect(schema.parse("abc")).toBe("abc");
    expect(schema.parse("abcd")).toBe("abcd");
  });

  test("minLength: rejects string below minimum", () => {
    const schema = jsonSchemaPropertyToZod({ type: "string", minLength: 3 });
    expect(() => schema.parse("ab")).toThrow();
  });

  test("maxLength: accepts string at or below maximum", () => {
    const schema = jsonSchemaPropertyToZod({ type: "string", maxLength: 5 });
    expect(schema.parse("hi")).toBe("hi");
    expect(schema.parse("abcde")).toBe("abcde");
  });

  test("maxLength: rejects string above maximum", () => {
    const schema = jsonSchemaPropertyToZod({ type: "string", maxLength: 5 });
    expect(() => schema.parse("toolong")).toThrow();
  });

  test("minLength and maxLength together", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      minLength: 2,
      maxLength: 4,
    });
    expect(schema.parse("ab")).toBe("ab");
    expect(schema.parse("abcd")).toBe("abcd");
    expect(() => schema.parse("a")).toThrow();
    expect(() => schema.parse("abcde")).toThrow();
  });
});

describe("jsonSchemaPropertyToZod — string pattern", () => {
  test("accepts a string matching the pattern", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      pattern: "^[a-z]+$",
    });
    expect(schema.parse("abc")).toBe("abc");
  });

  test("rejects a string not matching the pattern", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      pattern: "^[a-z]+$",
    });
    expect(() => schema.parse("ABC")).toThrow();
    expect(() => schema.parse("abc123")).toThrow();
  });
});

describe("jsonSchemaPropertyToZod — string format", () => {
  test("format=email: accepts a valid e-mail address", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "email",
    });
    expect(schema.parse("user@example.com")).toBe("user@example.com");
  });

  test("format=email: rejects a non-email string", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "email",
    });
    expect(() => schema.parse("not-an-email")).toThrow();
  });

  test("format=uri: accepts a valid URL", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "uri",
    });
    expect(schema.parse("https://example.com")).toBe("https://example.com");
  });

  test("format=uri: rejects a plain string", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "uri",
    });
    expect(() => schema.parse("not a url")).toThrow();
  });

  test("format=url: aliases uri — rejects non-URL", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "url",
    });
    expect(schema.parse("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(() => schema.parse("just text")).toThrow();
  });

  test("format=uuid: accepts a valid UUID", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "uuid",
    });
    expect(schema.parse("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("format=uuid: rejects a non-UUID string", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "uuid",
    });
    expect(() => schema.parse("not-a-uuid")).toThrow();
  });

  test("format=date-time: accepts a valid ISO-8601 date-time", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "date-time",
    });
    expect(schema.parse("2024-01-15T10:30:00.000Z")).toBe(
      "2024-01-15T10:30:00.000Z",
    );
  });

  test("format=date-time: rejects a plain date string without time", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "date-time",
    });
    expect(() => schema.parse("2024-01-15")).toThrow();
  });

  test("unknown format is passed through as plain string", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      format: "hostname",
    });
    // No Zod validator for 'hostname' — falls back to z.string()
    expect(schema.parse("any-string")).toBe("any-string");
  });
});

// ─── jsonSchemaPropertyToZod — enum ──────────────────────────────────────────

describe("jsonSchemaPropertyToZod — enum", () => {
  test("accepts a value in the enum", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      enum: ["a", "b", "c"],
    });
    expect(schema.parse("a")).toBe("a");
    expect(schema.parse("c")).toBe("c");
  });

  test("rejects a value not in the enum", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "string",
      enum: ["a", "b", "c"],
    });
    expect(() => schema.parse("d")).toThrow();
    expect(() => schema.parse("A")).toThrow();
  });
});

// ─── jsonSchemaPropertyToZod — integer ───────────────────────────────────────

describe("jsonSchemaPropertyToZod — integer", () => {
  test("accepts an integer value", () => {
    const schema = jsonSchemaPropertyToZod({ type: "integer" });
    expect(schema.parse(42)).toBe(42);
    expect(schema.parse(0)).toBe(0);
    expect(schema.parse(-7)).toBe(-7);
  });

  test("rejects a float (non-integer number)", () => {
    const schema = jsonSchemaPropertyToZod({ type: "integer" });
    // The live code calls .int(), so 3.14 must be rejected
    expect(() => schema.parse(3.14)).toThrow();
  });

  test("rejects a string that looks like an integer", () => {
    const schema = jsonSchemaPropertyToZod({ type: "integer" });
    expect(() => schema.parse("42")).toThrow();
  });
});

// ─── jsonSchemaPropertyToZod — number minimum/maximum ────────────────────────

describe("jsonSchemaPropertyToZod — number minimum / maximum", () => {
  test("minimum: accepts value at or above bound", () => {
    const schema = jsonSchemaPropertyToZod({ type: "number", minimum: 0 });
    expect(schema.parse(0)).toBe(0);
    expect(schema.parse(100)).toBe(100);
  });

  test("minimum: rejects value below bound", () => {
    const schema = jsonSchemaPropertyToZod({ type: "number", minimum: 0 });
    expect(() => schema.parse(-1)).toThrow();
  });

  test("maximum: accepts value at or below bound", () => {
    const schema = jsonSchemaPropertyToZod({ type: "number", maximum: 10 });
    expect(schema.parse(10)).toBe(10);
    expect(schema.parse(0)).toBe(0);
  });

  test("maximum: rejects value above bound", () => {
    const schema = jsonSchemaPropertyToZod({ type: "number", maximum: 10 });
    expect(() => schema.parse(11)).toThrow();
  });

  test("minimum + maximum together", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "number",
      minimum: 1,
      maximum: 5,
    });
    expect(schema.parse(1)).toBe(1);
    expect(schema.parse(5)).toBe(5);
    expect(() => schema.parse(0)).toThrow();
    expect(() => schema.parse(6)).toThrow();
  });

  test("integer with minimum/maximum applies .int() constraint too", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });
    expect(schema.parse(5)).toBe(5);
    expect(() => schema.parse(0)).toThrow();
    expect(() => schema.parse(11)).toThrow();
    expect(() => schema.parse(5.5)).toThrow();
  });
});

// ─── jsonSchemaPropertyToZod — array minItems/maxItems ───────────────────────

describe("jsonSchemaPropertyToZod — array minItems / maxItems", () => {
  test("minItems: accepts array at or above minimum length", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "array",
      items: { type: "string" },
      minItems: 2,
    });
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(schema.parse(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("minItems: rejects array below minimum length", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "array",
      items: { type: "string" },
      minItems: 2,
    });
    expect(() => schema.parse(["a"])).toThrow();
    expect(() => schema.parse([])).toThrow();
  });

  test("maxItems: accepts array at or below maximum length", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "array",
      items: { type: "number" },
      maxItems: 3,
    });
    expect(schema.parse([1, 2, 3])).toEqual([1, 2, 3]);
    expect(schema.parse([])).toEqual([]);
  });

  test("maxItems: rejects array above maximum length", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "array",
      items: { type: "number" },
      maxItems: 3,
    });
    expect(() => schema.parse([1, 2, 3, 4])).toThrow();
  });

  test("minItems + maxItems together", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    });
    expect(schema.parse(["x"])).toEqual(["x"]);
    expect(schema.parse(["x", "y", "z"])).toEqual(["x", "y", "z"]);
    expect(() => schema.parse([])).toThrow();
    expect(() => schema.parse(["a", "b", "c", "d"])).toThrow();
  });
});

// ─── jsonSchemaPropertyToZod — object & fallback ─────────────────────────────

describe("jsonSchemaPropertyToZod — object", () => {
  test("required and optional fields", () => {
    const schema = jsonSchemaPropertyToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(schema.parse({ name: "Alice", age: 30 })).toEqual({
      name: "Alice",
      age: 30,
    });
    expect(schema.parse({ name: "Bob" })).toEqual({ name: "Bob" });
    // name is required — missing it must throw
    expect(() => schema.parse({ age: 30 })).toThrow();
  });

  test("object without properties falls back to record", () => {
    const schema = jsonSchemaPropertyToZod({ type: "object" });
    expect(schema).toBeDefined();
  });
});

describe("jsonSchemaPropertyToZod — unknown/missing type", () => {
  test("unknown type returns z.unknown()", () => {
    const schema = jsonSchemaPropertyToZod({ type: "foobar" });
    expect(schema.parse("anything")).toBe("anything");
    expect(schema.parse(42)).toBe(42);
  });

  test("missing type returns z.unknown()", () => {
    const schema = jsonSchemaPropertyToZod({});
    expect(schema.parse("anything")).toBe("anything");
  });
});

// ─── inputSchemaToZodShape ────────────────────────────────────────────────────

describe("inputSchemaToZodShape", () => {
  test("returns empty shape for schema without properties", () => {
    const shape = inputSchemaToZodShape({});
    expect(Object.keys(shape)).toHaveLength(0);
  });

  test("marks required fields as required, optional fields as optional", () => {
    const shape = inputSchemaToZodShape({
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    const schema = z.object(shape);
    expect(schema.parse({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(() => schema.parse({ age: 30 })).toThrow();
  });

  test("all fields optional when no required array supplied", () => {
    const shape = inputSchemaToZodShape({
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    });
    const schema = z.object(shape);
    expect(schema.parse({})).toEqual({});
  });

  test("string constraints are propagated through inputSchemaToZodShape", () => {
    const shape = inputSchemaToZodShape({
      properties: {
        email: { type: "string", format: "email" },
        code: { type: "string", minLength: 4, maxLength: 4, pattern: "^[0-9]+$" },
      },
      required: ["email", "code"],
    });
    const schema = z.object(shape);
    expect(schema.parse({ email: "a@b.com", code: "1234" })).toEqual({
      email: "a@b.com",
      code: "1234",
    });
    expect(() => schema.parse({ email: "not-email", code: "1234" })).toThrow();
    expect(() => schema.parse({ email: "a@b.com", code: "123" })).toThrow();
    expect(() => schema.parse({ email: "a@b.com", code: "12ab" })).toThrow();
  });

  test("integer fields reject floats via the shape", () => {
    const shape = inputSchemaToZodShape({
      properties: {
        count: { type: "integer" },
      },
      required: ["count"],
    });
    const schema = z.object(shape);
    expect(schema.parse({ count: 5 })).toEqual({ count: 5 });
    expect(() => schema.parse({ count: 5.5 })).toThrow();
  });
});

// ─── opencrowToolToSdkTool — tool-result truncation ──────────────────────────

describe("opencrowToolToSdkTool — tool result truncation", () => {
  /**
   * The MCP_TOOL_RESULT_BUDGET inside mcp-bridge.ts is derived from
   * computeToolResultBudget(180_000).maxSingleResultChars which equals 20_000
   * (capped by HARD_CAP_CHARS).  We compute it the same way so the test
   * remains correct if constants ever change.
   */
  const BUDGET = computeToolResultBudget(180_000).maxSingleResultChars;

  test("output under budget is returned unchanged", async () => {
    const shortOutput = "x".repeat(100);
    const sdkTool = opencrowToolToSdkTool(makeToolDef(shortOutput));
    const result = await sdkTool.handler({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe(shortOutput);
    expect(result.isError).toBe(false);
  });

  test("output exactly at budget boundary is returned unchanged", async () => {
    const exactOutput = "y".repeat(BUDGET);
    const sdkTool = opencrowToolToSdkTool(makeToolDef(exactOutput));
    const result = await sdkTool.handler({});

    expect(result.content[0]?.text).toBe(exactOutput);
  });

  test("oversized output is truncated before being returned", async () => {
    const oversizedOutput = "A".repeat(BUDGET + 5_000);
    const sdkTool = opencrowToolToSdkTool(makeToolDef(oversizedOutput));
    const result = await sdkTool.handler({});

    const text = result.content[0]?.text ?? "";
    // Must be shorter than the original
    expect(text.length).toBeLessThan(oversizedOutput.length);
    // Must indicate truncation
    expect(text).toContain("truncated");
    // Must stay within budget
    expect(text.length).toBeLessThanOrEqual(BUDGET);
  });

  test("head content is preserved in truncated output", async () => {
    const header = "IMPORTANT_HEADER ";
    const body = "B".repeat(BUDGET + 10_000);
    const sdkTool = opencrowToolToSdkTool(makeToolDef(header + body));
    const result = await sdkTool.handler({});

    expect(result.content[0]?.text).toContain("IMPORTANT_HEADER");
  });

  test("tail content is NOT included in truncated output (security)", async () => {
    const body = "C".repeat(BUDGET + 10_000);
    const secret = "SECRET_AT_END";
    const sdkTool = opencrowToolToSdkTool(makeToolDef(body + secret));
    const result = await sdkTool.handler({});

    expect(result.content[0]?.text).not.toContain("SECRET_AT_END");
  });

  test("isError flag is propagated when tool reports an error", async () => {
    const sdkTool = opencrowToolToSdkTool(makeToolDef("error output", true));
    const result = await sdkTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("error output");
  });

  test("execute() exception is caught and returned as isError=true", async () => {
    const throwingTool: ToolDefinition = {
      name: "boom",
      description: "always throws",
      inputSchema: { type: "object", properties: {} },
      categories: ["system"],
      execute: async () => {
        throw new Error("something went wrong");
      },
    };

    const sdkTool = opencrowToolToSdkTool(throwingTool);
    const result = await sdkTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("something went wrong");
  });
});
