/**
 * Unit tests for the pure Ideas config-as-data validation + response builder.
 *
 * Lane: *.test.ts — run with `bun run test:unit` (no DB, no HTTP).
 */
import { describe, expect, it } from "bun:test";
import { type OpenCrowConfig, opencrowConfigSchema } from "../../config/schema";
import {
  abHoldoutOverrideSchema,
  buildIdeasConfigResponse,
  competabilityOverrideSchema,
  diversityGuardOverrideSchema,
  IDEAS_OVERRIDE_SECTIONS,
  incumbentExclusionOverrideSchema,
  outcomeMemoryOverrideSchema,
} from "./config-ideas-schema";

// A fully-defaulted config — every smart subtree has its schema defaults.
const baseConfig: OpenCrowConfig = opencrowConfigSchema.parse({});

describe("outcomeMemoryOverrideSchema", () => {
  it("accepts a partial body with the writeBack (capital B) field", () => {
    const r = outcomeMemoryOverrideSchema.safeParse({ writeBack: false, reinforceCap: 8 });
    expect(r.success).toBe(true);
  });

  it("rejects the lowercase `writeback` typo (unknown key)", () => {
    const r = outcomeMemoryOverrideSchema.safeParse({ writeback: false });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range caps", () => {
    expect(outcomeMemoryOverrideSchema.safeParse({ reinforceCap: 0 }).success).toBe(false);
    expect(outcomeMemoryOverrideSchema.safeParse({ avoidCap: 21 }).success).toBe(false);
    expect(outcomeMemoryOverrideSchema.safeParse({ searchLimit: 51 }).success).toBe(false);
  });

  it("accepts an empty partial", () => {
    expect(outcomeMemoryOverrideSchema.safeParse({}).success).toBe(true);
  });
});

describe("abHoldoutOverrideSchema", () => {
  it("accepts enabled + a valid holdoutRatio in [0,1]", () => {
    expect(abHoldoutOverrideSchema.safeParse({ enabled: true, holdoutRatio: 0.3 }).success).toBe(
      true,
    );
    expect(abHoldoutOverrideSchema.safeParse({ holdoutRatio: 0 }).success).toBe(true);
    expect(abHoldoutOverrideSchema.safeParse({ holdoutRatio: 1 }).success).toBe(true);
  });

  it("rejects holdoutRatio > 1", () => {
    expect(abHoldoutOverrideSchema.safeParse({ holdoutRatio: 1.5 }).success).toBe(false);
  });

  it("rejects a negative holdoutRatio", () => {
    expect(abHoldoutOverrideSchema.safeParse({ holdoutRatio: -0.1 }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(abHoldoutOverrideSchema.safeParse({ ratio: 0.5 }).success).toBe(false);
  });

  it("accepts an empty partial", () => {
    expect(abHoldoutOverrideSchema.safeParse({}).success).toBe(true);
  });

  it("is registered as an override section under config/smart.abHoldout", () => {
    const section = IDEAS_OVERRIDE_SECTIONS.find((s) => s.id === "abHoldout");
    expect(section).toBeDefined();
    expect(section?.key).toBe("smart.abHoldout");
    expect(section?.namespace).toBe("config");
  });

  it("surfaces abHoldout in the effective config response", () => {
    const res = buildIdeasConfigResponse(baseConfig, {});
    expect(res.effective.abHoldout).toEqual({ enabled: true, holdoutRatio: 0.5 });
    expect(res.overrides.abHoldout).toBeNull();
  });
});

describe("incumbentExclusionOverrideSchema", () => {
  it("accepts enabled + topN", () => {
    expect(incumbentExclusionOverrideSchema.safeParse({ enabled: false, topN: 50 }).success).toBe(
      true,
    );
  });

  it("rejects topN above 1000", () => {
    expect(incumbentExclusionOverrideSchema.safeParse({ topN: 1001 }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(incumbentExclusionOverrideSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });
});

describe("diversityGuardOverrideSchema", () => {
  it("accepts a valid bucketBy enum + share", () => {
    expect(
      diversityGuardOverrideSchema.safeParse({ maxBucketShare: 0.4, bucketBy: "category" }).success,
    ).toBe(true);
  });

  it("rejects an out-of-range share", () => {
    expect(diversityGuardOverrideSchema.safeParse({ maxBucketShare: 1.5 }).success).toBe(false);
  });

  it("rejects an invalid bucketBy enum", () => {
    expect(diversityGuardOverrideSchema.safeParse({ bucketBy: "vertical" }).success).toBe(false);
  });
});

describe("competabilityOverrideSchema", () => {
  it("accepts top-level fields + nested builderProfile with expertiseDomains list", () => {
    const r = competabilityOverrideSchema.safeParse({
      enforceGate: true,
      rejectThreshold: 2.5,
      builderProfile: { capital: "seed", teamSize: 3, expertiseDomains: ["fintech", "ml"] },
    });
    expect(r.success).toBe(true);
  });

  it("rejects the `builder` alias (schema field is builderProfile)", () => {
    expect(competabilityOverrideSchema.safeParse({ builder: { teamSize: 2 } }).success).toBe(false);
  });

  it("rejects rejectThreshold above 5", () => {
    expect(competabilityOverrideSchema.safeParse({ rejectThreshold: 6 }).success).toBe(false);
  });

  it("rejects an unknown builderProfile field", () => {
    expect(competabilityOverrideSchema.safeParse({ builderProfile: { bogus: true } }).success).toBe(
      false,
    );
  });

  it("rejects an over-long expertiseDomains list (>50)", () => {
    const domains = Array.from({ length: 51 }, (_, i) => `d${i}`);
    expect(
      competabilityOverrideSchema.safeParse({ builderProfile: { expertiseDomains: domains } })
        .success,
    ).toBe(false);
  });
});

describe("IDEAS_OVERRIDE_SECTIONS", () => {
  it("maps each section to the expected namespace/key", () => {
    const byId = Object.fromEntries(IDEAS_OVERRIDE_SECTIONS.map((s) => [s.id, s]));
    expect(byId.outcomeMemory).toMatchObject({ namespace: "config", key: "smart.outcomeMemory" });
    expect(byId.incumbentExclusion).toMatchObject({
      namespace: "config",
      key: "smart.incumbentExclusion",
    });
    expect(byId.diversityGuard).toMatchObject({ namespace: "config", key: "smart.diversityGuard" });
    expect(byId.competability).toMatchObject({ namespace: "config", key: "competability" });
  });

  it("has unique section ids", () => {
    const ids = IDEAS_OVERRIDE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildIdeasConfigResponse", () => {
  it("surfaces effective values from pipelines.ideas.smart and null overrides when none", () => {
    const res = buildIdeasConfigResponse(baseConfig, {});
    expect(res.effective.outcomeMemory.writeBack).toBe(true);
    expect(res.effective.incumbentExclusion.enabled).toBe(true);
    expect(res.effective.diversityGuard.bucketBy).toBe("archetype");
    expect(res.effective.competability.builderProfile.capital).toBe("bootstrap");
    expect(res.overrides.outcomeMemory).toBeNull();
    expect(res.overrides.competability).toBeNull();
  });

  it("echoes the raw override JSON per section when present", () => {
    const res = buildIdeasConfigResponse(baseConfig, {
      diversityGuard: { enabled: false },
      competability: { enforceGate: true },
    });
    expect(res.overrides.diversityGuard).toEqual({ enabled: false });
    expect(res.overrides.competability).toEqual({ enforceGate: true });
    expect(res.overrides.outcomeMemory).toBeNull();
  });

  it("does not mutate the input config", () => {
    const before = JSON.stringify(baseConfig.pipelines.ideas.smart.competability);
    buildIdeasConfigResponse(baseConfig, { competability: { enabled: false } });
    expect(JSON.stringify(baseConfig.pipelines.ideas.smart.competability)).toBe(before);
  });
});
