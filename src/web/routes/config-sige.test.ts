/**
 * Unit tests for the pure validation/transform logic of the SIGE config route.
 *
 * Lane: *.test.ts — run with `bun run test:unit` (no DB).
 */
import { describe, it, expect } from "bun:test";
import {
  mergeSigeCorePatch,
  sigeAutoOverrideSchema,
  sigeCoreOverrideSchema,
} from "./config-sige";

describe("mergeSigeCorePatch", () => {
  it("overwrites top-level enabled without touching nested blocks", () => {
    const existing = {
      enabled: false,
      mem0: { baseUrl: "http://a" },
      neo4j: { enabled: true, boltUrl: "bolt://b", user: "u" },
    };
    const next = mergeSigeCorePatch(existing, { enabled: true });
    expect(next.enabled).toBe(true);
    expect(next.mem0).toEqual({ baseUrl: "http://a" });
    expect(next.neo4j).toEqual({ enabled: true, boltUrl: "bolt://b", user: "u" });
  });

  it("deep-merges a partial neo4j patch onto the stored neo4j block", () => {
    const existing = {
      neo4j: { enabled: false, boltUrl: "bolt://old", user: "neo4j" },
    };
    const next = mergeSigeCorePatch(existing, { neo4j: { enabled: true } });
    expect(next.neo4j).toEqual({
      enabled: true,
      boltUrl: "bolt://old",
      user: "neo4j",
    });
  });

  it("merges mem0.baseUrl while keeping unrelated keys", () => {
    const existing = { mem0: { baseUrl: "http://old" }, enabled: true };
    const next = mergeSigeCorePatch(existing, {
      mem0: { baseUrl: "http://new" },
    });
    expect(next.mem0).toEqual({ baseUrl: "http://new" });
    expect(next.enabled).toBe(true);
  });

  it("does not mutate its inputs (immutability)", () => {
    const existing = { mem0: { baseUrl: "http://a" } };
    const patch = { mem0: { baseUrl: "http://b" } } as const;
    mergeSigeCorePatch(existing, patch);
    expect(existing.mem0.baseUrl).toBe("http://a");
  });

  it("merges onto an empty existing row", () => {
    const next = mergeSigeCorePatch({}, { enabled: true });
    expect(next).toEqual({ enabled: true });
  });
});

describe("sigeCoreOverrideSchema", () => {
  it("accepts a partial patch with only enabled", () => {
    const r = sigeCoreOverrideSchema.safeParse({ enabled: true });
    expect(r.success).toBe(true);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const r = sigeCoreOverrideSchema.safeParse({ bogus: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects a non-url mem0.baseUrl", () => {
    const r = sigeCoreOverrideSchema.safeParse({ mem0: { baseUrl: "not a url" } });
    expect(r.success).toBe(false);
  });

  it("rejects unknown nested neo4j keys", () => {
    const r = sigeCoreOverrideSchema.safeParse({ neo4j: { url: "bolt://x" } });
    expect(r.success).toBe(false);
  });
});

describe("sigeAutoOverrideSchema", () => {
  it("accepts a valid manual-only patch", () => {
    const r = sigeAutoOverrideSchema.safeParse({
      enabled: false,
      cadence: "manual",
    });
    expect(r.success).toBe(true);
  });

  it("rejects cadence outside the enum", () => {
    const r = sigeAutoOverrideSchema.safeParse({ cadence: "hourly" });
    expect(r.success).toBe(false);
  });

  it("rejects maxDeepFrontiers above the hard cap of 3", () => {
    const r = sigeAutoOverrideSchema.safeParse({ maxDeepFrontiers: 4 });
    expect(r.success).toBe(false);
  });

  it("rejects broadPoolSize above 200", () => {
    const r = sigeAutoOverrideSchema.safeParse({ broadPoolSize: 201 });
    expect(r.success).toBe(false);
  });

  it("rejects maxConcurrent above 1 (locked)", () => {
    const r = sigeAutoOverrideSchema.safeParse({ maxConcurrent: 2 });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = sigeAutoOverrideSchema.safeParse({ perRunCostCeilingUsd: 5 });
    expect(r.success).toBe(false);
  });
});
