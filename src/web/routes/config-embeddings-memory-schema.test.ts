/**
 * Unit tests for the Embeddings & Memory config validation/transform logic.
 * Lane: *.test.ts — run with `bun run test:unit` (no DB).
 */
import { describe, expect, it } from "bun:test";
import {
  dimensionsChangeSchema,
  isDimensionsChange,
  memoryOverrideSchema,
} from "./config-embeddings-memory-schema";

describe("memoryOverrideSchema", () => {
  it("accepts qdrant", () => {
    const parsed = memoryOverrideSchema.safeParse({ backend: "qdrant" });
    expect(parsed.success).toBe(true);
  });

  it("accepts mem0", () => {
    const parsed = memoryOverrideSchema.safeParse({ backend: "mem0" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown backend value", () => {
    const parsed = memoryOverrideSchema.safeParse({ backend: "pinecone" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing backend", () => {
    const parsed = memoryOverrideSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown extra keys (strict)", () => {
    const parsed = memoryOverrideSchema.safeParse({ backend: "qdrant", foo: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("dimensionsChangeSchema", () => {
  it("accepts a valid dimensions value and defaults confirmReindex to false", () => {
    const parsed = dimensionsChangeSchema.safeParse({ dimensions: 768 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dimensions).toBe(768);
      expect(parsed.data.confirmReindex).toBe(false);
    }
  });

  it("accepts confirmReindex true", () => {
    const parsed = dimensionsChangeSchema.safeParse({
      dimensions: 1024,
      confirmReindex: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.confirmReindex).toBe(true);
  });

  it("rejects dimensions below the minimum (32)", () => {
    expect(dimensionsChangeSchema.safeParse({ dimensions: 8 }).success).toBe(false);
  });

  it("rejects dimensions above the maximum (4096)", () => {
    expect(dimensionsChangeSchema.safeParse({ dimensions: 9000 }).success).toBe(false);
  });

  it("rejects non-integer dimensions", () => {
    expect(dimensionsChangeSchema.safeParse({ dimensions: 512.5 }).success).toBe(false);
  });

  it("rejects unknown extra keys (strict)", () => {
    expect(dimensionsChangeSchema.safeParse({ dimensions: 512, bogus: true }).success).toBe(false);
  });
});

describe("isDimensionsChange", () => {
  it("returns false when the value is unchanged", () => {
    expect(isDimensionsChange(512, 512)).toBe(false);
  });

  it("returns true when the value differs", () => {
    expect(isDimensionsChange(512, 768)).toBe(true);
  });
});
