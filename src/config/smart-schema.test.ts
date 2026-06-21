import { describe, expect, test } from "bun:test";

import {
  giantConfigSchema,
  GIANT_DEFAULT_WEIGHTS,
  ideasPipelineConfigSchema,
  opencrowConfigSchema,
  pipelinesConfigSchema,
  SIGE_DEFAULT_JUDGE_MODELS,
  sigeHardeningConfigSchema,
  smartConfigSchema,
  tasteConfigSchema,
} from "./schema";

describe("smartConfigSchema", () => {
  test("applies safe defaults when no fields are provided", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed).toEqual({
      sigeValuation: false,
      knowledgeGraphRetrieval: true,
      deepSearchReranker: false,
      signalFacets: false,
      signalRanking: false,
      signalImportanceFloor: "low",
      adaptiveCollection: true,
      validatedExemplars: true,
      chainOfEvidence: true,
      rerankTopK: 6,
      rerankFetchK: 30,
      giant: {
        enabled: true,
        enforceGates: false,
        weights: {
          acuteProblem: 0.22,
          whyNow: 0.18,
          demand: 0.18,
          nonObviousness: 0.15,
          defensibility: 0.12,
          marketShape: 0.08,
          founderFit: 0.07,
        },
      },
      generateWide: {
        overGenerate: true,
        seedsPerIntersection: 5,
        maxCandidates: 40,
        multiSegment: true,
        sigeDivergent: false,
      },
      demand: {
        enabled: true,
        redditIntent: true,
        fundingSignal: true,
        reviewComplaint: true,
        hnIntent: true,
        phSupply: true,
        externalTrends: false,
        minMatches: 2,
        minKeywordHits: 2,
      },
      sige: {
        independentJudge: true,
        judgeModels: [
          { provider: "anthropic", model: "claude-haiku-4-5" },
          { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
          { provider: "alibaba", model: "qwen3.7-plus" },
        ],
        dissentWeight: 0.15,
        convergenceVetoThreshold: 0.85,
        convergenceVetoAction: "log",
        deepTier: true,
      },
      taste: {
        antiExemplars: true,
        syntheticGolden: true,
        autoProxyLabels: true,
        calibrateGiantWeights: false,
        exemplarCount: 4,
        goldenMinHumanLabels: 10,
      },
      sigeAuto: {
        enabled: false,
        maxDeepFrontiers: 1,
        broadPoolSize: 50,
        cadence: "daily",
        maxConcurrent: 1,
        memoryWriteback: false,
        perRunCostCeilingUsd: 0,
      },
      outcomeMemory: {
        writeBack: true,
        readAtSynthesis: true,
        reinforceCap: 5,
        avoidCap: 5,
        searchLimit: 12,
      },
      graphReasoning: {
        enabled: false,
        maxHops: 2,
        maxPaths: 8,
        searchLimit: 25,
        minDegree: 3,
        maxDegree: 200,
      },
      incumbentExclusion: {
        enabled: true,
        topN: 100,
      },
      competability: {
        enabled: true,
        enforceGate: false,
        rejectThreshold: 2,
        softPenaltyThreshold: 2.5,
        topNIncumbents: 100,
        builderProfile: {
          capital: "bootstrap",
          teamSize: 1,
          expertiseDomains: [],
          regulatoryAppetite: "low",
          opsAppetite: "low",
        },
      },
      diversityGuard: {
        enabled: true,
        maxBucketShare: 0.5,
        bucketBy: "archetype",
        signalGuard: true,
        maxSignalShare: 0.34,
      },
      seedDiversity: {
        enabled: true,
        focusRotation: true,
        focusSpread: 8,
        highOpportunitySlice: 4,
        recentAnchorLookback: 40,
        painThemesLeadSummary: true,
        maxLeadingPainThemes: 15,
        echoChamberDownweight: true,
        echoChamberFactor: 0.5,
      },
      independentJury: {
        enabled: true,
        penaltyWeight: 0.7,
      },
      shallowIdeation: {
        enabled: false,
        candidateCount: 30,
        batchSize: 10,
        model: "",
      },
      deepDevelopCount: 6,
      stratifiedIntake: {
        enabled: true,
        perBucketCap: 8,
        totalCap: 90,
        fetchLimit: 100,
      },
    });
  });

  test("seed-diversity levers default ON (pure-logic, attacks seed monoculture)", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.seedDiversity.enabled).toBe(true);
    expect(parsed.seedDiversity.focusRotation).toBe(true);
    expect(parsed.seedDiversity.painThemesLeadSummary).toBe(true);
    expect(parsed.seedDiversity.echoChamberDownweight).toBe(true);
    expect(parsed.seedDiversity.echoChamberFactor).toBe(0.5);
  });

  test("seed-diversity numeric bounds + echo factor range are enforced", () => {
    expect(() => smartConfigSchema.parse({ seedDiversity: { echoChamberFactor: -0.1 } })).toThrow();
    expect(() => smartConfigSchema.parse({ seedDiversity: { echoChamberFactor: 1.1 } })).toThrow();
    expect(() => smartConfigSchema.parse({ seedDiversity: { focusSpread: 0 } })).toThrow();
    const parsed = smartConfigSchema.parse({
      seedDiversity: { enabled: false, focusRotation: false, echoChamberFactor: 0.25 },
    });
    expect(parsed.seedDiversity.enabled).toBe(false);
    expect(parsed.seedDiversity.focusRotation).toBe(false);
    expect(parsed.seedDiversity.echoChamberFactor).toBe(0.25);
  });

  test("Stage 2 shallowIdeation defaults OFF (reversible) with conservative knobs", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.shallowIdeation.enabled).toBe(false);
    expect(parsed.shallowIdeation.candidateCount).toBe(30);
    expect(parsed.shallowIdeation.batchSize).toBe(10);
    expect(parsed.shallowIdeation.model).toBe("");
    expect(parsed.deepDevelopCount).toBe(6);
  });

  test("Stage 2 bounds are enforced + overrides honored", () => {
    expect(() => smartConfigSchema.parse({ shallowIdeation: { candidateCount: 3 } })).toThrow();
    expect(() => smartConfigSchema.parse({ shallowIdeation: { candidateCount: 121 } })).toThrow();
    expect(() => smartConfigSchema.parse({ shallowIdeation: { batchSize: 0 } })).toThrow();
    expect(() => smartConfigSchema.parse({ deepDevelopCount: 0 })).toThrow();
    expect(() => smartConfigSchema.parse({ deepDevelopCount: 21 })).toThrow();
    const parsed = smartConfigSchema.parse({
      shallowIdeation: { enabled: true, candidateCount: 24, batchSize: 8, model: "cheap-x" },
      deepDevelopCount: 5,
    });
    expect(parsed.shallowIdeation).toEqual({
      enabled: true,
      candidateCount: 24,
      batchSize: 8,
      model: "cheap-x",
    });
    expect(parsed.deepDevelopCount).toBe(5);
  });

  test("Layer C incumbent exclusion defaults ON (pure-logic safe)", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.incumbentExclusion.enabled).toBe(true);
    expect(parsed.incumbentExclusion.topN).toBe(100);
  });

  test("Layer B competability is enabled but SHADOW (enforceGate OFF) by default", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.competability.enabled).toBe(true);
    // Shadow mode: computed + logged, never rejects until explicitly enforced.
    expect(parsed.competability.enforceGate).toBe(false);
    expect(parsed.competability.rejectThreshold).toBe(2);
    expect(parsed.competability.softPenaltyThreshold).toBe(2.5);
  });

  test("within-run diversity guard defaults ON (archetype, 0.5 share, signal guard 0.34)", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.diversityGuard.enabled).toBe(true);
    expect(parsed.diversityGuard.maxBucketShare).toBe(0.5);
    expect(parsed.diversityGuard.bucketBy).toBe("archetype");
    expect(parsed.diversityGuard.signalGuard).toBe(true);
    expect(parsed.diversityGuard.maxSignalShare).toBe(0.34);
  });

  test("diversity guard bounds + enum are enforced", () => {
    expect(() => smartConfigSchema.parse({ diversityGuard: { maxBucketShare: -0.1 } })).toThrow();
    expect(() => smartConfigSchema.parse({ diversityGuard: { maxBucketShare: 1.1 } })).toThrow();
    expect(() => smartConfigSchema.parse({ diversityGuard: { bucketBy: "segment" } })).toThrow();
    const parsed = smartConfigSchema.parse({
      diversityGuard: { enabled: false, maxBucketShare: 0.3, bucketBy: "category" },
    });
    expect(parsed.diversityGuard).toEqual({
      enabled: false,
      maxBucketShare: 0.3,
      bucketBy: "category",
      signalGuard: true,
      maxSignalShare: 0.34,
    });
  });

  test("external-service and expensive gates default OFF", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.sigeValuation).toBe(false);
    expect(parsed.deepSearchReranker).toBe(false);
    expect(parsed.signalFacets).toBe(false);
    expect(parsed.signalRanking).toBe(false);
  });

  test("read-only graph + outcome-memory learning loop default ON", () => {
    const parsed = smartConfigSchema.parse({});
    // knowledgeGraphRetrieval is read-only (injects sanitized + untrusted-fenced
    // mem0 facts into synthesis): now ON to leverage the populated graph. No
    // autonomous feedback loop.
    expect(parsed.knowledgeGraphRetrieval).toBe(true);
    // The REINFORCE/AVOID learning loop (write verdicts back + read them at
    // synthesis) is now ON by default. Both halves degrade gracefully on mem0
    // failure, so a default run stays safe.
    expect(parsed.outcomeMemory.writeBack).toBe(true);
    expect(parsed.outcomeMemory.readAtSynthesis).toBe(true);
    // sigeAuto.memoryWriteback stays OFF — autonomous feedback-loop risk.
    expect(parsed.sigeAuto.memoryWriteback).toBe(false);
  });

  test("graph reasoning defaults OFF with bounded traversal caps", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.graphReasoning.enabled).toBe(false);
    expect(parsed.graphReasoning.maxHops).toBe(2);
    expect(parsed.graphReasoning.maxPaths).toBe(8);
    expect(parsed.graphReasoning.searchLimit).toBe(25);
    expect(parsed.graphReasoning.minDegree).toBe(3);
    expect(parsed.graphReasoning.maxDegree).toBe(200);
  });

  test("signalRanking defaults OFF and is gated on top of signalFacets", () => {
    expect(smartConfigSchema.parse({}).signalRanking).toBe(false);
    const parsed = smartConfigSchema.parse({
      signalFacets: true,
      signalRanking: true,
    });
    expect(parsed.signalFacets).toBe(true);
    expect(parsed.signalRanking).toBe(true);
  });

  test("signalImportanceFloor defaults to low and accepts the bucket enum", () => {
    expect(smartConfigSchema.parse({}).signalImportanceFloor).toBe("low");
    for (const floor of ["noise", "low", "medium", "high"] as const) {
      expect(smartConfigSchema.parse({ signalImportanceFloor: floor }).signalImportanceFloor).toBe(
        floor,
      );
    }
  });

  test("signalImportanceFloor rejects values outside the bucket enum", () => {
    expect(() => smartConfigSchema.parse({ signalImportanceFloor: "critical" })).toThrow();
  });

  test("pure-logic flags default ON", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.adaptiveCollection).toBe(true);
    expect(parsed.validatedExemplars).toBe(true);
    expect(parsed.chainOfEvidence).toBe(true);
  });

  test("rerank bounds are enforced", () => {
    expect(() => smartConfigSchema.parse({ rerankTopK: 3 })).toThrow();
    expect(() => smartConfigSchema.parse({ rerankTopK: 51 })).toThrow();
    expect(() => smartConfigSchema.parse({ rerankFetchK: 9 })).toThrow();
    expect(() => smartConfigSchema.parse({ rerankFetchK: 101 })).toThrow();
  });

  test("honors explicit overrides", () => {
    const parsed = smartConfigSchema.parse({
      sigeValuation: true,
      rerankTopK: 12,
    });
    expect(parsed.sigeValuation).toBe(true);
    expect(parsed.rerankTopK).toBe(12);
  });
});

describe("giantConfigSchema", () => {
  test("computes + stores by default but enforces gates in SHADOW mode", () => {
    const parsed = giantConfigSchema.parse(undefined);
    expect(parsed.enabled).toBe(true);
    expect(parsed.enforceGates).toBe(false);
  });

  test("applies the 7 default axis weights", () => {
    const parsed = giantConfigSchema.parse({});
    expect(parsed.weights).toEqual({
      acuteProblem: 0.22,
      whyNow: 0.18,
      demand: 0.18,
      nonObviousness: 0.15,
      defensibility: 0.12,
      marketShape: 0.08,
      founderFit: 0.07,
    });
  });

  test("default weights match the exported GIANT_DEFAULT_WEIGHTS", () => {
    expect(giantConfigSchema.parse({}).weights).toEqual({
      ...GIANT_DEFAULT_WEIGHTS,
    });
  });

  test("default weights sum to 1.0", () => {
    const sum = Object.values(GIANT_DEFAULT_WEIGHTS).reduce((acc, w) => acc + w, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  test("enforceGates can be opted into for hard-gate enforcement", () => {
    const parsed = giantConfigSchema.parse({ enforceGates: true });
    expect(parsed.enforceGates).toBe(true);
    // enabling enforcement does not implicitly disable compute/store
    expect(parsed.enabled).toBe(true);
  });

  test("weights accept partial overrides and default the rest", () => {
    const parsed = giantConfigSchema.parse({
      weights: { acuteProblem: 0.3 },
    });
    expect(parsed.weights.acuteProblem).toBe(0.3);
    expect(parsed.weights.whyNow).toBe(0.18);
    expect(parsed.weights.founderFit).toBe(0.07);
  });

  test("is reachable via the documented smart.giant access path", () => {
    const cfg = opencrowConfigSchema.parse({});
    const giant = cfg.pipelines.ideas.smart.giant;
    expect(giant.enabled).toBe(true);
    expect(giant.enforceGates).toBe(false);
    expect(giant.weights.demand).toBe(0.18);
  });
});

describe("sigeHardeningConfigSchema", () => {
  test("applies hardening defaults when no fields are provided", () => {
    const parsed = sigeHardeningConfigSchema.parse(undefined);
    expect(parsed.independentJudge).toBe(true);
    expect(parsed.dissentWeight).toBe(0.15);
    expect(parsed.convergenceVetoThreshold).toBe(0.85);
    expect(parsed.deepTier).toBe(true);
  });

  test("default judgeModels are a cross-family set (>1 provider)", () => {
    const parsed = sigeHardeningConfigSchema.parse({});
    expect(parsed.judgeModels.length).toBeGreaterThanOrEqual(2);
    const providers = new Set(parsed.judgeModels.map((m) => m.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
    expect(parsed.judgeModels).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5" },
      { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
      { provider: "alibaba", model: "qwen3.7-plus" },
    ]);
  });

  test("default judgeModels match exported SIGE_DEFAULT_JUDGE_MODELS", () => {
    expect(sigeHardeningConfigSchema.parse({}).judgeModels).toEqual([...SIGE_DEFAULT_JUDGE_MODELS]);
  });

  test("honors explicit overrides on every field", () => {
    const parsed = sigeHardeningConfigSchema.parse({
      independentJudge: false,
      judgeModels: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
      dissentWeight: 0.4,
      convergenceVetoThreshold: 0.7,
      deepTier: false,
    });
    expect(parsed.independentJudge).toBe(false);
    expect(parsed.judgeModels).toEqual([{ provider: "anthropic", model: "claude-sonnet-4-6" }]);
    expect(parsed.dissentWeight).toBe(0.4);
    expect(parsed.convergenceVetoThreshold).toBe(0.7);
    expect(parsed.deepTier).toBe(false);
  });

  test("rejects judgeModels missing provider/model", () => {
    expect(() => sigeHardeningConfigSchema.parse({ judgeModels: [{ provider: "x" }] })).toThrow();
  });

  test("is reachable via the documented smart.sige access path", () => {
    const cfg = opencrowConfigSchema.parse({});
    const sige = cfg.pipelines.ideas.smart.sige;
    expect(sige.independentJudge).toBe(true);
    expect(sige.convergenceVetoThreshold).toBe(0.85);
    expect(sige.judgeModels.length).toBeGreaterThanOrEqual(2);
  });

  test("smart.sige defaults when smart parsed empty", () => {
    const smart = smartConfigSchema.parse({});
    expect(smart.sige.deepTier).toBe(true);
    expect(smart.sige.dissentWeight).toBe(0.15);
  });
});

describe("tasteConfigSchema", () => {
  test("applies cold-start taste defaults when no fields are provided", () => {
    const parsed = tasteConfigSchema.parse(undefined);
    expect(parsed).toEqual({
      antiExemplars: true,
      syntheticGolden: true,
      autoProxyLabels: true,
      calibrateGiantWeights: false,
      exemplarCount: 4,
      goldenMinHumanLabels: 10,
    });
  });

  test("safe levers default ON, weight calibration defaults OFF", () => {
    const parsed = tasteConfigSchema.parse({});
    expect(parsed.antiExemplars).toBe(true);
    expect(parsed.syntheticGolden).toBe(true);
    expect(parsed.autoProxyLabels).toBe(true);
    expect(parsed.calibrateGiantWeights).toBe(false);
  });

  test("exemplarCount bounds are enforced (anti-mode-collapse: low + bounded)", () => {
    expect(() => tasteConfigSchema.parse({ exemplarCount: 0 })).toThrow();
    expect(() => tasteConfigSchema.parse({ exemplarCount: 13 })).toThrow();
    expect(tasteConfigSchema.parse({ exemplarCount: 1 }).exemplarCount).toBe(1);
    expect(tasteConfigSchema.parse({ exemplarCount: 12 }).exemplarCount).toBe(12);
  });

  test("goldenMinHumanLabels accepts zero and positive integers", () => {
    expect(tasteConfigSchema.parse({ goldenMinHumanLabels: 0 }).goldenMinHumanLabels).toBe(0);
    expect(tasteConfigSchema.parse({ goldenMinHumanLabels: 25 }).goldenMinHumanLabels).toBe(25);
    expect(() => tasteConfigSchema.parse({ goldenMinHumanLabels: -1 })).toThrow();
    expect(() => tasteConfigSchema.parse({ goldenMinHumanLabels: 1.5 })).toThrow();
  });

  test("honors explicit overrides on every field", () => {
    const parsed = tasteConfigSchema.parse({
      antiExemplars: false,
      syntheticGolden: false,
      autoProxyLabels: false,
      calibrateGiantWeights: true,
      exemplarCount: 6,
      goldenMinHumanLabels: 3,
    });
    expect(parsed.antiExemplars).toBe(false);
    expect(parsed.syntheticGolden).toBe(false);
    expect(parsed.autoProxyLabels).toBe(false);
    expect(parsed.calibrateGiantWeights).toBe(true);
    expect(parsed.exemplarCount).toBe(6);
    expect(parsed.goldenMinHumanLabels).toBe(3);
  });

  test("smart.taste defaults when smart parsed empty", () => {
    const smart = smartConfigSchema.parse({});
    expect(smart.taste.antiExemplars).toBe(true);
    expect(smart.taste.calibrateGiantWeights).toBe(false);
    expect(smart.taste.exemplarCount).toBe(4);
  });

  test("is reachable via the documented smart.taste access path", () => {
    const cfg = opencrowConfigSchema.parse({});
    const taste = cfg.pipelines.ideas.smart.taste;
    expect(taste.antiExemplars).toBe(true);
    expect(taste.syntheticGolden).toBe(true);
    expect(taste.goldenMinHumanLabels).toBe(10);
  });
});

describe("pipelines.ideas.smart backward compatibility", () => {
  test("ideasPipelineConfigSchema yields smart defaults when empty", () => {
    expect(ideasPipelineConfigSchema.parse({}).smart.rerankTopK).toBe(6);
    expect(ideasPipelineConfigSchema.parse(undefined).smart.sigeValuation).toBe(false);
  });

  test("pipelinesConfigSchema yields ideas.smart defaults when empty", () => {
    expect(pipelinesConfigSchema.parse({}).ideas.smart.adaptiveCollection).toBe(true);
    expect(pipelinesConfigSchema.parse(undefined).ideas.smart.rerankFetchK).toBe(30);
  });

  test("full config without pipelines still validates with smart defaults", () => {
    const parsed = opencrowConfigSchema.parse({});
    expect(parsed.pipelines.ideas.smart.signalFacets).toBe(false);
    expect(parsed.pipelines.ideas.smart.validatedExemplars).toBe(true);
  });
});
