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

describe("competability builder-profile env overrides", () => {
  const VARS = [
    "OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL",
    "OPENCROW_SMART_COMPETABILITY_BUILDER_TEAM_SIZE",
    "OPENCROW_SMART_COMPETABILITY_BUILDER_REGULATORY_APPETITE",
    "OPENCROW_SMART_COMPETABILITY_BUILDER_OPS_APPETITE",
    "OPENCROW_SMART_COMPETABILITY_BUILDER_EXPERTISE_DOMAINS",
    "OPENCROW_SMART_COMPETABILITY_REJECT_THRESHOLD",
  ];
  afterEach(() => {
    for (const v of VARS) delete process.env[v];
  });

  test("default builder profile is the solo bootstrapper (identity)", () => {
    for (const v of VARS) delete process.env[v];
    const bp = loadConfig().pipelines.ideas.smart.competability.builderProfile;
    expect(bp.capital).toBe("bootstrap");
    expect(bp.teamSize).toBe(1);
    expect(bp.expertiseDomains).toEqual([]);
    expect(bp.regulatoryAppetite).toBe("low");
    expect(bp.opsAppetite).toBe("low");
  });

  test("env sets builder profile fields (capital, team, appetites, domains)", () => {
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL = "funded";
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_TEAM_SIZE = "5";
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_REGULATORY_APPETITE = "high";
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_OPS_APPETITE = "high";
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_EXPERTISE_DOMAINS =
      "fintech, healthcare";
    const bp = loadConfig().pipelines.ideas.smart.competability.builderProfile;
    expect(bp.capital).toBe("funded");
    expect(bp.teamSize).toBe(5);
    expect(bp.regulatoryAppetite).toBe("high");
    expect(bp.opsAppetite).toBe("high");
    expect(bp.expertiseDomains).toEqual(["fintech", "healthcare"]);
  });

  test("a PARTIAL builder-profile env override keeps sibling profile fields at default", () => {
    // Only capital is overridden — teamSize/appetites/domains must survive.
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL = "seed";
    const comp = loadConfig().pipelines.ideas.smart.competability;
    expect(comp.builderProfile.capital).toBe("seed");
    expect(comp.builderProfile.teamSize).toBe(1);
    expect(comp.builderProfile.regulatoryAppetite).toBe("low");
    expect(comp.builderProfile.opsAppetite).toBe("low");
    expect(comp.builderProfile.expertiseDomains).toEqual([]);
    // Sibling competability fields untouched.
    expect(comp.enabled).toBe(true);
    expect(comp.rejectThreshold).toBe(2);
  });

  test("a builder-profile env override coexists with a sibling competability env override", () => {
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL = "funded";
    process.env.OPENCROW_SMART_COMPETABILITY_REJECT_THRESHOLD = "1.5";
    const comp = loadConfig().pipelines.ideas.smart.competability;
    expect(comp.builderProfile.capital).toBe("funded");
    expect(comp.rejectThreshold).toBe(1.5);
    // builderProfile siblings still defaulted.
    expect(comp.builderProfile.teamSize).toBe(1);
  });
});

describe("deepMergeSigeOverride — competability builderProfile no-clobber", () => {
  // The DB config/competability override path reuses deepMergeSigeOverride. Its
  // one-level-deep merge is EXACTLY deep enough because builderProfile sits
  // exactly one level below competability: a partial builderProfile override has
  // its nested keys shallow-merged onto base.builderProfile, so siblings survive.
  test("partial builderProfile override keeps sibling profile + competability fields", () => {
    const base: Record<string, unknown> = {
      enabled: true,
      enforceGate: false,
      rejectThreshold: 2,
      builderProfile: {
        capital: "bootstrap",
        teamSize: 1,
        expertiseDomains: [],
        regulatoryAppetite: "low",
        opsAppetite: "low",
      },
    };
    const override: Record<string, unknown> = {
      builderProfile: { capital: "funded" },
    };

    const result = deepMergeSigeOverride(base, override);

    const bp = result.builderProfile as Record<string, unknown>;
    expect(bp.capital).toBe("funded");
    // Sibling builderProfile fields survive the one-level merge.
    expect(bp.teamSize).toBe(1);
    expect(bp.regulatoryAppetite).toBe("low");
    expect(bp.opsAppetite).toBe("low");
    expect(bp.expertiseDomains).toEqual([]);
    // Sibling competability fields survive.
    expect(result.enabled).toBe(true);
    expect(result.rejectThreshold).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// seedDiversity env-toggle tests (loadConfig — no DB required)
// ---------------------------------------------------------------------------

const SEED_DIVERSITY_VARS = [
  "OPENCROW_SMART_SEED_DIVERSITY_ENABLED",
  "OPENCROW_SMART_SEED_DIVERSITY_FOCUS_ROTATION",
  "OPENCROW_SMART_SEED_DIVERSITY_FOCUS_SPREAD",
  "OPENCROW_SMART_SEED_DIVERSITY_HIGH_OPPORTUNITY_SLICE",
  "OPENCROW_SMART_SEED_DIVERSITY_RECENT_ANCHOR_LOOKBACK",
  "OPENCROW_SMART_SEED_DIVERSITY_PAIN_THEMES_LEAD_SUMMARY",
  "OPENCROW_SMART_SEED_DIVERSITY_MAX_LEADING_PAIN_THEMES",
  "OPENCROW_SMART_SEED_DIVERSITY_ECHO_CHAMBER_DOWNWEIGHT",
  "OPENCROW_SMART_SEED_DIVERSITY_ECHO_CHAMBER_FACTOR",
] as const;

describe("loadConfig — seedDiversity env toggles", () => {
  let saved: Partial<Record<string, string>> = {};

  beforeEach(() => {
    saved = {};
    for (const name of SEED_DIVERSITY_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of SEED_DIVERSITY_VARS) {
      const prev = saved[name];
      if (prev === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prev;
      }
    }
  });

  test("no env vars set → all seedDiversity fields carry schema defaults", () => {
    const sd = loadConfig().pipelines.ideas.smart.seedDiversity;
    expect(sd.enabled).toBe(true);
    expect(sd.focusRotation).toBe(true);
    expect(sd.focusSpread).toBe(8);
    expect(sd.highOpportunitySlice).toBe(4);
    expect(sd.recentAnchorLookback).toBe(40);
    expect(sd.painThemesLeadSummary).toBe(true);
    expect(sd.maxLeadingPainThemes).toBe(15);
    expect(sd.echoChamberDownweight).toBe(true);
    expect(sd.echoChamberFactor).toBe(0.5);
  });

  test("ECHO_CHAMBER_FACTOR=0.25 → number override; sibling fields keep defaults", () => {
    process.env.OPENCROW_SMART_SEED_DIVERSITY_ECHO_CHAMBER_FACTOR = "0.25";
    const sd = loadConfig().pipelines.ideas.smart.seedDiversity;
    expect(sd.echoChamberFactor).toBe(0.25);
    expect(typeof sd.echoChamberFactor).toBe("number");
    // siblings survive the shallow-merge
    expect(sd.enabled).toBe(true);
    expect(sd.focusRotation).toBe(true);
    expect(sd.focusSpread).toBe(8);
  });

  test("FOCUS_ROTATION=false and ENABLED=false override booleans", () => {
    process.env.OPENCROW_SMART_SEED_DIVERSITY_FOCUS_ROTATION = "false";
    process.env.OPENCROW_SMART_SEED_DIVERSITY_ENABLED = "false";
    const sd = loadConfig().pipelines.ideas.smart.seedDiversity;
    expect(sd.enabled).toBe(false);
    expect(sd.focusRotation).toBe(false);
    // numeric siblings still default
    expect(sd.focusSpread).toBe(8);
  });

  test("FOCUS_SPREAD=12 → numeric override (not string)", () => {
    process.env.OPENCROW_SMART_SEED_DIVERSITY_FOCUS_SPREAD = "12";
    const sd = loadConfig().pipelines.ideas.smart.seedDiversity;
    expect(sd.focusSpread).toBe(12);
    expect(typeof sd.focusSpread).toBe("number");
  });
});
