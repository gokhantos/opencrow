/**
 * Unit tests for the pure validation/transform logic in config-signals.
 *
 * Lane: *.test.ts — run with `bun run test:unit` (no DB).
 */
import { describe, it, expect } from "bun:test";
import {
  signalsUpdateSchema,
  normalizeImportanceFloor,
  buildSignalsEffective,
} from "./config-signals";

describe("signalsUpdateSchema", () => {
  it("accepts a full valid body", () => {
    const parsed = signalsUpdateSchema.safeParse({
      facets: true,
      ranking: false,
      importanceFloor: "medium",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a partial body (single field)", () => {
    expect(signalsUpdateSchema.safeParse({ facets: true }).success).toBe(true);
    expect(signalsUpdateSchema.safeParse({ ranking: false }).success).toBe(true);
    expect(
      signalsUpdateSchema.safeParse({ importanceFloor: "high" }).success,
    ).toBe(true);
  });

  it("rejects an empty body (no fields)", () => {
    expect(signalsUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      signalsUpdateSchema.safeParse({ facets: true, bogus: 1 }).success,
    ).toBe(false);
  });

  it("rejects wrong types", () => {
    expect(signalsUpdateSchema.safeParse({ facets: "yes" }).success).toBe(false);
    expect(signalsUpdateSchema.safeParse({ ranking: 1 }).success).toBe(false);
  });

  it("rejects an importanceFloor outside low|medium|high (e.g. noise)", () => {
    expect(
      signalsUpdateSchema.safeParse({ importanceFloor: "noise" }).success,
    ).toBe(false);
    expect(
      signalsUpdateSchema.safeParse({ importanceFloor: "extreme" }).success,
    ).toBe(false);
  });
});

describe("normalizeImportanceFloor", () => {
  it("passes through exposed buckets", () => {
    expect(normalizeImportanceFloor("low")).toBe("low");
    expect(normalizeImportanceFloor("medium")).toBe("medium");
    expect(normalizeImportanceFloor("high")).toBe("high");
  });

  it("clamps the schema-only 'noise' bucket up to 'low'", () => {
    expect(normalizeImportanceFloor("noise")).toBe("low");
  });

  it("defaults unknown/undefined to 'low'", () => {
    expect(normalizeImportanceFloor(undefined)).toBe("low");
    expect(normalizeImportanceFloor(null)).toBe("low");
    expect(normalizeImportanceFloor("garbage")).toBe("low");
  });
});

describe("buildSignalsEffective", () => {
  it("maps flat smart fields to the domain view", () => {
    const eff = buildSignalsEffective({
      signalFacets: true,
      signalRanking: false,
      signalImportanceFloor: "high",
    });
    expect(eff).toEqual({ facets: true, ranking: false, importanceFloor: "high" });
  });

  it("treats non-true booleans as false and missing floor as low", () => {
    const eff = buildSignalsEffective({});
    expect(eff).toEqual({ facets: false, ranking: false, importanceFloor: "low" });
  });

  it("does not coerce truthy non-boolean values to true", () => {
    const eff = buildSignalsEffective({ signalFacets: 1, signalRanking: "x" });
    expect(eff.facets).toBe(false);
    expect(eff.ranking).toBe(false);
  });
});
