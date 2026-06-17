import { test, expect, describe } from "bun:test";
import { deepMergeSigeOverride } from "./loader";

/**
 * Unit tests for deepMergeSigeOverride — the pure merge helper that replaces
 * the wholesale-replace in mergeFeatureOverrides.
 *
 * These are in the *.test.ts lane (unit) because deepMergeSigeOverride has no
 * DB dependency; it is a pure function over plain objects.
 */

describe("deepMergeSigeOverride", () => {
  describe("precedence matrix", () => {
    test("DB override with only 'enabled' leaves env-derived mem0.baseUrl intact", () => {
      // Simulates: env sets mem0.baseUrl; DB override = {"enabled":true}
      const base: Record<string, unknown> = {
        enabled: false,
        mem0: {
          baseUrl: "http://mem0:8000",
          userId: "sige-global",
        },
      };
      const dbOverride: Record<string, unknown> = { enabled: true };

      const result = deepMergeSigeOverride(base, dbOverride);

      expect(result.enabled).toBe(true);
      const mem0 = result.mem0 as Record<string, unknown>;
      expect(mem0.baseUrl).toBe("http://mem0:8000");
      expect(mem0.userId).toBe("sige-global");
    });

    test("env-derived mem0.apiToken survives a DB override of mem0.baseUrl", () => {
      // Regression guard: a DB override that only changes baseUrl must not drop
      // the env-derived apiToken, or SIGE would silently lose auth (401s).
      const base: Record<string, unknown> = {
        enabled: true,
        mem0: {
          baseUrl: "http://mem0:8000",
          userId: "sige-global",
          apiToken: "internal-token",
        },
      };
      const dbOverride: Record<string, unknown> = {
        mem0: { baseUrl: "http://override-host:9000" },
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      const mem0 = result.mem0 as Record<string, unknown>;
      expect(mem0.baseUrl).toBe("http://override-host:9000");
      expect(mem0.apiToken).toBe("internal-token");
    });

    test("DB override that sets mem0.baseUrl wins over base mem0.baseUrl", () => {
      // Simulates: env sets mem0.baseUrl to X; DB override explicitly sets it to Y → Y wins
      const base: Record<string, unknown> = {
        enabled: true,
        mem0: {
          baseUrl: "http://mem0:8000",
          userId: "sige-global",
        },
      };
      const dbOverride: Record<string, unknown> = {
        mem0: { baseUrl: "http://override-host:9000" },
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      const mem0 = result.mem0 as Record<string, unknown>;
      expect(mem0.baseUrl).toBe("http://override-host:9000");
      // userId not in DB override → survives from base
      expect(mem0.userId).toBe("sige-global");
    });

    test("DB override with partial mem0 leaves non-overridden mem0 fields intact", () => {
      const base: Record<string, unknown> = {
        enabled: false,
        mem0: {
          baseUrl: "http://mem0:8000",
          userId: "custom-user",
        },
      };
      const dbOverride: Record<string, unknown> = {
        enabled: true,
        mem0: { userId: "db-user" },
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      expect(result.enabled).toBe(true);
      const mem0 = result.mem0 as Record<string, unknown>;
      // userId overridden by DB
      expect(mem0.userId).toBe("db-user");
      // baseUrl not in DB override → survives from env/file
      expect(mem0.baseUrl).toBe("http://mem0:8000");
    });

    test("empty DB override returns a copy of base unchanged", () => {
      const base: Record<string, unknown> = {
        enabled: true,
        mem0: { baseUrl: "http://mem0:8000", userId: "sige-global" },
        provider: "anthropic",
      };

      const result = deepMergeSigeOverride(base, {});

      expect(result).toEqual(base);
    });

    test("base without mem0 and DB override without mem0 produces no mem0 key", () => {
      const base: Record<string, unknown> = { enabled: false };
      const dbOverride: Record<string, unknown> = { enabled: true };

      const result = deepMergeSigeOverride(base, dbOverride);

      expect(result.enabled).toBe(true);
      expect(result.mem0).toBeUndefined();
    });

    test("DB override can introduce a new top-level sige key not present in base", () => {
      const base: Record<string, unknown> = {
        enabled: false,
        mem0: { baseUrl: "http://mem0:8000", userId: "sige-global" },
      };
      const dbOverride: Record<string, unknown> = {
        enabled: true,
        model: "claude-opus-4-5",
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      expect(result.enabled).toBe(true);
      expect(result.model).toBe("claude-opus-4-5");
      // mem0 from base untouched
      const mem0 = result.mem0 as Record<string, unknown>;
      expect(mem0.baseUrl).toBe("http://mem0:8000");
    });
  });

  describe("nested object deep-merge for other sige sub-objects", () => {
    test("DB override with partial simulation leaves other simulation fields intact", () => {
      const base: Record<string, unknown> = {
        simulation: {
          expertRounds: 4,
          socialAgentCount: 50,
          maxConcurrentAgents: 10,
        },
      };
      const dbOverride: Record<string, unknown> = {
        simulation: { expertRounds: 8 },
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      const sim = result.simulation as Record<string, unknown>;
      expect(sim.expertRounds).toBe(8);
      expect(sim.socialAgentCount).toBe(50);
      expect(sim.maxConcurrentAgents).toBe(10);
    });

    test("DB override with partial incentives leaves other incentive weights intact", () => {
      const base: Record<string, unknown> = {
        incentives: {
          diversityWeight: 0.15,
          buildingWeight: 0.1,
          surpriseWeight: 0.1,
        },
      };
      const dbOverride: Record<string, unknown> = {
        incentives: { diversityWeight: 0.25 },
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      const inc = result.incentives as Record<string, unknown>;
      expect(inc.diversityWeight).toBe(0.25);
      expect(inc.buildingWeight).toBe(0.1);
      expect(inc.surpriseWeight).toBe(0.1);
    });
  });

  describe("immutability", () => {
    test("does not mutate the base object", () => {
      const base: Record<string, unknown> = {
        enabled: false,
        mem0: { baseUrl: "http://mem0:8000", userId: "sige-global" },
      };
      const originalBaseEnabled = base.enabled;
      const originalMem0 = { ...(base.mem0 as Record<string, unknown>) };

      deepMergeSigeOverride(base, { enabled: true, mem0: { baseUrl: "http://x:1" } });

      expect(base.enabled).toBe(originalBaseEnabled);
      expect((base.mem0 as Record<string, unknown>).baseUrl).toBe(originalMem0.baseUrl);
    });

    test("does not mutate the override object", () => {
      const override: Record<string, unknown> = {
        enabled: true,
        mem0: { baseUrl: "http://db:9000" },
      };
      const originalUrl = (override.mem0 as Record<string, unknown>).baseUrl;

      deepMergeSigeOverride({ mem0: { baseUrl: "http://base:8000", userId: "u" } }, override);

      expect((override.mem0 as Record<string, unknown>).baseUrl).toBe(originalUrl);
    });
  });

  describe("array values in override", () => {
    test("array values in override replace base arrays (not merged)", () => {
      const base: Record<string, unknown> = {
        someList: ["a", "b"],
      };
      const dbOverride: Record<string, unknown> = {
        someList: ["c"],
      };

      const result = deepMergeSigeOverride(base, dbOverride);

      expect(result.someList).toEqual(["c"]);
    });
  });

  describe("prototype pollution", () => {
    test("a __proto__ key in the override does not pollute Object.prototype", () => {
      // The override originates from a JSON-parsed DB row, so JSON.parse can
      // produce an own enumerable "__proto__" key. The merge must not let it
      // reach the global prototype.
      const malicious = JSON.parse('{"__proto__":{"polluted":1}}') as Record<
        string,
        unknown
      >;

      const result = deepMergeSigeOverride({ enabled: true }, malicious);

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((result as Record<string, unknown>).polluted).toBeUndefined();
      expect(result.enabled).toBe(true);
    });

    test("constructor/prototype keys are dropped, not merged", () => {
      const malicious = JSON.parse(
        '{"constructor":{"x":1},"prototype":{"y":2},"enabled":true}',
      ) as Record<string, unknown>;

      const result = deepMergeSigeOverride({}, malicious);

      expect(result.enabled).toBe(true);
      expect(Object.hasOwn(result, "prototype")).toBe(false);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
  });
});
