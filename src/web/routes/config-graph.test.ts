/**
 * Unit tests for the graph-reasoning config PUT-body validation schema.
 *
 * Lane: *.test.ts — run with `bun run test:unit` (no DB).
 */
import { describe, it, expect } from "bun:test";
import { graphReasoningOverrideSchema, NAMESPACE, KEY } from "./config-graph";

describe("graphReasoningOverrideSchema", () => {
  it("accepts a full valid object", () => {
    const parsed = graphReasoningOverrideSchema.safeParse({
      enabled: true,
      maxHops: 3,
      maxPaths: 10,
      searchLimit: 25,
      minDegree: 3,
      maxDegree: 200,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a partial object (single field)", () => {
    const parsed = graphReasoningOverrideSchema.safeParse({ enabled: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ enabled: false });
  });

  it("rejects an empty object (no fields)", () => {
    const parsed = graphReasoningOverrideSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const parsed = graphReasoningOverrideSchema.safeParse({
      enabled: true,
      bogus: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects maxHops below min (2)", () => {
    expect(graphReasoningOverrideSchema.safeParse({ maxHops: 1 }).success).toBe(false);
  });

  it("rejects maxHops above max (6)", () => {
    expect(graphReasoningOverrideSchema.safeParse({ maxHops: 7 }).success).toBe(false);
  });

  it("rejects non-integer numbers", () => {
    expect(graphReasoningOverrideSchema.safeParse({ maxPaths: 2.5 }).success).toBe(false);
  });

  it("rejects wrong type (enabled as string)", () => {
    expect(graphReasoningOverrideSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });

  it("rejects maxPaths out of bounds", () => {
    expect(graphReasoningOverrideSchema.safeParse({ maxPaths: 0 }).success).toBe(false);
    expect(graphReasoningOverrideSchema.safeParse({ maxPaths: 21 }).success).toBe(false);
  });

  it("rejects minDegree greater than maxDegree", () => {
    const parsed = graphReasoningOverrideSchema.safeParse({
      minDegree: 500,
      maxDegree: 100,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts minDegree equal to maxDegree", () => {
    const parsed = graphReasoningOverrideSchema.safeParse({
      minDegree: 50,
      maxDegree: 50,
    });
    expect(parsed.success).toBe(true);
  });

  it("does not cross-validate when only one degree bound is provided", () => {
    expect(graphReasoningOverrideSchema.safeParse({ minDegree: 900 }).success).toBe(true);
    expect(graphReasoningOverrideSchema.safeParse({ maxDegree: 10 }).success).toBe(true);
  });

  it("exposes the expected config_overrides namespace + key", () => {
    expect(NAMESPACE).toBe("config");
    expect(KEY).toBe("smart.graphReasoning");
  });
});
