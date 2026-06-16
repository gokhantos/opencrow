import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  setOverride,
  getOverride,
  deleteOverride,
  getAllOverrides,
} from "./config-overrides";
import { initDb, closeDb, getDb } from "./db";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("config-overrides", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();

    // Clean up test data
    const db = getDb();
    await db.unsafe("DELETE FROM config_overrides WHERE namespace = 'test-ns'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM config_overrides WHERE namespace = 'test-ns'");
    await closeDb();
  });

  describe("setOverride / getOverride", () => {
    it("round-trips a JSON value", async () => {
      const value = { foo: "bar", count: 42, nested: { ok: true } };

      await setOverride("test-ns", "key-roundtrip", value);
      const result = await getOverride("test-ns", "key-roundtrip");

      expect(result).toEqual(value);
    });

    it("upserts an existing key with a new value", async () => {
      await setOverride("test-ns", "key-upsert", { version: 1 });
      await setOverride("test-ns", "key-upsert", { version: 2 });

      const result = await getOverride("test-ns", "key-upsert");

      expect(result).toEqual({ version: 2 });
    });
  });

  describe("getOverride", () => {
    it("returns null for a missing key", async () => {
      const result = await getOverride("test-ns", "key-missing");

      expect(result).toBeNull();
    });
  });

  describe("deleteOverride", () => {
    it("removes the entry so subsequent getOverride returns null", async () => {
      await setOverride("test-ns", "key-delete", "to-be-removed");
      await deleteOverride("test-ns", "key-delete");

      const result = await getOverride("test-ns", "key-delete");

      expect(result).toBeNull();
    });
  });

  describe("getAllOverrides", () => {
    it("returns entries sorted by key", async () => {
      await setOverride("test-ns", "key-z", "last");
      await setOverride("test-ns", "key-a", "first");
      await setOverride("test-ns", "key-m", "middle");

      const overrides = await getAllOverrides("test-ns");

      const keys = overrides.map((o) => o.key);
      expect(keys).toEqual(["key-a", "key-m", "key-z"]);
    });

    it("respects namespace isolation", async () => {
      const db = getDb();
      await db.unsafe("DELETE FROM config_overrides WHERE namespace = 'other-ns'");

      try {
        await setOverride("test-ns", "key-isolated", "mine");
        await setOverride("other-ns", "key-isolated", "theirs");

        const testNsResults = await getAllOverrides("test-ns");
        const otherNsResults = await getAllOverrides("other-ns");

        expect(testNsResults.every((o) => o.namespace === "test-ns")).toBe(true);
        expect(otherNsResults.every((o) => o.namespace === "other-ns")).toBe(true);

        const testValue = testNsResults.find((o) => o.key === "key-isolated");
        const otherValue = otherNsResults.find((o) => o.key === "key-isolated");

        expect(testValue?.value).toBe("mine");
        expect(otherValue?.value).toBe("theirs");
      } finally {
        await db.unsafe("DELETE FROM config_overrides WHERE namespace = 'other-ns'");
      }
    });
  });
});
