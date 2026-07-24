/**
 * Isolated tests for getSecret()'s DB-lookup timeout.
 *
 * The unit-lane test (secrets.test.ts) covers the DB-THROWS -> env fallback
 * path (getOverride throws when the DB is uninitialized). This isolated lane
 * covers the regression that the unit lane structurally cannot: a getOverride
 * that NEVER SETTLES (a hung config_overrides query under connection-pool
 * starvation) must still fall back to env within `DB_LOOKUP_TIMEOUT_MS`
 * instead of hanging the caller forever.
 *
 * Root cause (2026-07-24): a never-settling proxy-credential read wedged the
 * memoized getAppstoreProxyUrl, hanging every proxied App Store scan request.
 * The pre-fix getSecret caught only throws, not never-settling promises.
 *
 * Lane: *.isolated.test.ts — uses mock.module; run with `bun run test:isolated`.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";

const TEST_KEY = "OPENCROW_TEST_HANGING_SECRET";

afterEach(() => {
  delete process.env[TEST_KEY];
  mock.restore();
});

describe("getSecret DB-lookup timeout (never-settling query)", () => {
  it("falls back to env when getOverride never settles", async () => {
    // getOverride returns a promise that never resolves or rejects — the exact
    // shape of the production hang. Without the timeout, getSecret would hang.
    mock.module("../store/config-overrides", () => ({
      getOverride: () => new Promise<never>(() => {}),
    }));
    process.env[TEST_KEY] = "env-fallback-value";

    const { getSecret } = await import("./secrets");
    const started = performance.now();
    const value = await getSecret(TEST_KEY);
    const elapsedMs = performance.now() - started;

    expect(value).toBe("env-fallback-value");
    // Must resolve via the ~3s DB-lookup timeout, not hang; generous ceiling.
    expect(elapsedMs).toBeLessThan(8_000);
  }, 10_000);

  it("still returns the DB value when getOverride resolves promptly", async () => {
    mock.module("../store/config-overrides", () => ({
      getOverride: async () => "db-value",
    }));
    process.env[TEST_KEY] = "env-should-be-ignored";

    const { getSecret } = await import("./secrets");
    const value = await getSecret(TEST_KEY);

    expect(value).toBe("db-value");
  });
});
