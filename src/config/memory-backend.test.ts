import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "./loader";
import { memorySearchConfigSchema } from "./schema";

/**
 * Unit tests for the `memory.backend` selection flag.
 *
 * Pins the zero-behavior-change default (`qdrant`) and the
 * `OPENCROW_MEMORY_BACKEND` env override. No DB required — `loadConfig()` is the
 * sync env-only path, and schema parsing is pure — so this is in the unit lane.
 */

describe("memorySearch.backend schema default", () => {
  test("backend defaults to 'qdrant' when the memorySearch block is empty", () => {
    const parsed = memorySearchConfigSchema.parse({});
    expect(parsed.backend).toBe("qdrant");
  });

  test("an explicit backend value is preserved", () => {
    const parsed = memorySearchConfigSchema.parse({ backend: "mem0" });
    expect(parsed.backend).toBe("mem0");
  });

  test("an invalid backend value is rejected", () => {
    expect(() => memorySearchConfigSchema.parse({ backend: "pinecone" })).toThrow();
  });

  test("mem0SharedUserId defaults to 'opencrow-shared'", () => {
    const parsed = memorySearchConfigSchema.parse({});
    expect(parsed.mem0SharedUserId).toBe("opencrow-shared");
  });
});

describe("OPENCROW_MEMORY_BACKEND env override", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OPENCROW_MEMORY_BACKEND;
    delete process.env.OPENCROW_MEMORY_BACKEND;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OPENCROW_MEMORY_BACKEND;
    } else {
      process.env.OPENCROW_MEMORY_BACKEND = saved;
    }
  });

  test("unset → no env-injected memorySearch block (default behavior unchanged)", () => {
    const cfg = loadConfig();
    // Without a configured memorySearch block and without the env override,
    // loadConfig leaves memorySearch undefined (the prior behavior).
    expect(cfg.memorySearch).toBeUndefined();
  });

  test("OPENCROW_MEMORY_BACKEND=mem0 overrides backend to 'mem0'", () => {
    process.env.OPENCROW_MEMORY_BACKEND = "mem0";
    const cfg = loadConfig();
    expect(cfg.memorySearch?.backend).toBe("mem0");
  });

  test("OPENCROW_MEMORY_BACKEND=qdrant keeps backend at 'qdrant'", () => {
    process.env.OPENCROW_MEMORY_BACKEND = "qdrant";
    const cfg = loadConfig();
    expect(cfg.memorySearch?.backend).toBe("qdrant");
  });
});
