import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { deepMergeSigeOverride, loadConfig } from "./loader";

/**
 * Unit tests for deepMergeSigeOverride — the pure merge helper that replaces
 * the wholesale-replace in mergeFeatureOverrides.
 *
 * These are in the *.test.ts lane (unit) because deepMergeSigeOverride has no
 * DB dependency; it is a pure function over plain objects.
 */

describe("tools sandbox env overrides", () => {
  afterEach(() => {
    delete process.env.OPENCROW_TOOLS_SANDBOX;
    delete process.env.OPENCROW_DEV_TOOLS_ALLOW_NETWORK;
    delete process.env.OPENCROW_ALLOW_UNSANDBOXED_DEV_TOOLS;
  });

  test("defaults to best-effort sandbox, network-denied dev tools, fail-closed unsandboxed", () => {
    delete process.env.OPENCROW_TOOLS_SANDBOX;
    delete process.env.OPENCROW_DEV_TOOLS_ALLOW_NETWORK;
    delete process.env.OPENCROW_ALLOW_UNSANDBOXED_DEV_TOOLS;
    const cfg = loadConfig();
    expect(cfg.tools.sandbox).toBe("best-effort");
    expect(cfg.tools.devToolsAllowNetwork).toBe(false);
    expect(cfg.tools.allowUnsandboxedDevTools).toBe(false);
  });

  test("OPENCROW_ALLOW_UNSANDBOXED_DEV_TOOLS=true opts into unsandboxed dev tools", () => {
    process.env.OPENCROW_ALLOW_UNSANDBOXED_DEV_TOOLS = "true";
    const cfg = loadConfig();
    expect(cfg.tools.allowUnsandboxedDevTools).toBe(true);
  });

  test("OPENCROW_TOOLS_SANDBOX=required forces fail-closed mode", () => {
    process.env.OPENCROW_TOOLS_SANDBOX = "required";
    const cfg = loadConfig();
    expect(cfg.tools.sandbox).toBe("required");
  });

  test("ignores an invalid OPENCROW_TOOLS_SANDBOX value", () => {
    process.env.OPENCROW_TOOLS_SANDBOX = "garbage";
    const cfg = loadConfig();
    expect(cfg.tools.sandbox).toBe("best-effort");
  });

  test("OPENCROW_DEV_TOOLS_ALLOW_NETWORK=true opts dev tools into egress", () => {
    process.env.OPENCROW_DEV_TOOLS_ALLOW_NETWORK = "true";
    const cfg = loadConfig();
    expect(cfg.tools.devToolsAllowNetwork).toBe(true);
  });
});

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

// ---------------------------------------------------------------------------
// outcomeMemory env-toggle tests (loadConfig — no DB required)
// ---------------------------------------------------------------------------

/**
 * Save and restore a set of env vars around each test so leaks cannot affect
 * other unit tests in the same process.
 */
const OUTCOME_MEMORY_VARS = [
  "OPENCROW_SMART_OUTCOME_MEMORY_WRITEBACK",
  "OPENCROW_SMART_OUTCOME_MEMORY_READ_AT_SYNTHESIS",
  "OPENCROW_SMART_OUTCOME_MEMORY_REINFORCE_CAP",
  "OPENCROW_SMART_OUTCOME_MEMORY_AVOID_CAP",
  "OPENCROW_SMART_OUTCOME_MEMORY_SEARCH_LIMIT",
] as const;

describe("loadConfig — outcomeMemory env toggles", () => {
  let saved: Partial<Record<string, string>> = {};

  beforeEach(() => {
    saved = {};
    for (const name of OUTCOME_MEMORY_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OUTCOME_MEMORY_VARS) {
      const prev = saved[name];
      if (prev === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prev;
      }
    }
  });

  test("no env vars set → all outcomeMemory fields carry schema defaults", () => {
    const cfg = loadConfig();
    const om = cfg.pipelines.ideas.smart.outcomeMemory;
    // Both learning-loop halves now default ON (the REINFORCE/AVOID loop is live).
    expect(om.writeBack).toBe(true);
    expect(om.readAtSynthesis).toBe(true);
    expect(om.reinforceCap).toBe(5);
    expect(om.avoidCap).toBe(5);
    expect(om.searchLimit).toBe(12);
  });

  test("WRITEBACK=false → writeBack overrides to false; sibling fields keep defaults", () => {
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_WRITEBACK = "false";
    const cfg = loadConfig();
    const om = cfg.pipelines.ideas.smart.outcomeMemory;
    expect(om.writeBack).toBe(false);
    // sibling defaults must survive the shallow-merge (readAtSynthesis stays ON)
    expect(om.readAtSynthesis).toBe(true);
    expect(om.reinforceCap).toBe(5);
    expect(om.avoidCap).toBe(5);
    expect(om.searchLimit).toBe(12);
  });

  test("READ_AT_SYNTHESIS=false → readAtSynthesis overrides to false", () => {
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_READ_AT_SYNTHESIS = "false";
    const cfg = loadConfig();
    expect(cfg.pipelines.ideas.smart.outcomeMemory.readAtSynthesis).toBe(false);
  });

  test("REINFORCE_CAP=8 → reinforceCap becomes 8 (number, not string)", () => {
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_REINFORCE_CAP = "8";
    const cfg = loadConfig();
    const om = cfg.pipelines.ideas.smart.outcomeMemory;
    expect(om.reinforceCap).toBe(8);
    expect(typeof om.reinforceCap).toBe("number");
    // siblings still default
    expect(om.avoidCap).toBe(5);
    expect(om.searchLimit).toBe(12);
  });

  test("AVOID_CAP=3 → avoidCap becomes 3", () => {
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_AVOID_CAP = "3";
    const cfg = loadConfig();
    expect(cfg.pipelines.ideas.smart.outcomeMemory.avoidCap).toBe(3);
  });

  test("SEARCH_LIMIT=20 → searchLimit becomes 20", () => {
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_SEARCH_LIMIT = "20";
    const cfg = loadConfig();
    expect(cfg.pipelines.ideas.smart.outcomeMemory.searchLimit).toBe(20);
  });

  test("multiple vars set simultaneously all take effect", () => {
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_WRITEBACK = "true";
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_READ_AT_SYNTHESIS = "1";
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_REINFORCE_CAP = "10";
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_AVOID_CAP = "7";
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_SEARCH_LIMIT = "30";
    const cfg = loadConfig();
    const om = cfg.pipelines.ideas.smart.outcomeMemory;
    expect(om.writeBack).toBe(true);
    expect(om.readAtSynthesis).toBe(true);
    expect(om.reinforceCap).toBe(10);
    expect(om.avoidCap).toBe(7);
    expect(om.searchLimit).toBe(30);
  });
});
