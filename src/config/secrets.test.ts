/**
 * Unit tests for getSecret().
 *
 * getSecret resolves DB-first then falls back to the process environment.
 * In the unit lane the DB is not initialized, so getOverride() throws and
 * getSecret must transparently fall back to process.env — that env-fallback
 * contract is what every ad-hoc credential read now relies on, so it is
 * covered here directly.
 *
 * Lane: *.test.ts — run with `bun run test:unit` (no DB).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { getSecret } from "./secrets";

const TEST_ENV_KEY = "OPENCROW_TEST_SECRET_ONLY_FOR_UNIT";

afterEach(() => {
  delete process.env[TEST_ENV_KEY];
});

describe("getSecret env fallback (DB not initialized)", () => {
  it("returns the env value when DB lookup is unavailable", async () => {
    process.env[TEST_ENV_KEY] = "env-secret-value";
    const value = await getSecret(TEST_ENV_KEY);
    expect(value).toBe("env-secret-value");
  });

  it("returns undefined when neither DB nor env has the key", async () => {
    delete process.env[TEST_ENV_KEY];
    const value = await getSecret(TEST_ENV_KEY);
    expect(value).toBeUndefined();
  });

  it("treats an empty-string env value as unset (returns undefined)", async () => {
    process.env[TEST_ENV_KEY] = "";
    const value = await getSecret(TEST_ENV_KEY);
    expect(value).toBeUndefined();
  });

  it("resolves a newly managed credential key from env", async () => {
    process.env.GITHUB_TOKEN = "ghp_unit_test_token";
    try {
      const value = await getSecret("GITHUB_TOKEN");
      expect(value).toBe("ghp_unit_test_token");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});
