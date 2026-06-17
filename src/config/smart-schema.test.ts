import { describe, expect, test } from "bun:test";

import {
  giantConfigSchema,
  GIANT_DEFAULT_WEIGHTS,
  ideasPipelineConfigSchema,
  opencrowConfigSchema,
  pipelinesConfigSchema,
  smartConfigSchema,
} from "./schema";

describe("smartConfigSchema", () => {
  test("applies safe defaults when no fields are provided", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed).toEqual({
      sigeValuation: false,
      knowledgeGraphRetrieval: false,
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
    });
  });

  test("external-service and expensive gates default OFF", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.sigeValuation).toBe(false);
    expect(parsed.knowledgeGraphRetrieval).toBe(false);
    expect(parsed.deepSearchReranker).toBe(false);
    expect(parsed.signalFacets).toBe(false);
    expect(parsed.signalRanking).toBe(false);
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
      expect(
        smartConfigSchema.parse({ signalImportanceFloor: floor })
          .signalImportanceFloor,
      ).toBe(floor);
    }
  });

  test("signalImportanceFloor rejects values outside the bucket enum", () => {
    expect(() =>
      smartConfigSchema.parse({ signalImportanceFloor: "critical" }),
    ).toThrow();
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
    const sum = Object.values(GIANT_DEFAULT_WEIGHTS).reduce(
      (acc, w) => acc + w,
      0,
    );
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

describe("pipelines.ideas.smart backward compatibility", () => {
  test("ideasPipelineConfigSchema yields smart defaults when empty", () => {
    expect(ideasPipelineConfigSchema.parse({}).smart.rerankTopK).toBe(6);
    expect(ideasPipelineConfigSchema.parse(undefined).smart.sigeValuation).toBe(
      false,
    );
  });

  test("pipelinesConfigSchema yields ideas.smart defaults when empty", () => {
    expect(pipelinesConfigSchema.parse({}).ideas.smart.adaptiveCollection).toBe(
      true,
    );
    expect(pipelinesConfigSchema.parse(undefined).ideas.smart.rerankFetchK).toBe(
      30,
    );
  });

  test("full config without pipelines still validates with smart defaults", () => {
    const parsed = opencrowConfigSchema.parse({});
    expect(parsed.pipelines.ideas.smart.signalFacets).toBe(false);
    expect(parsed.pipelines.ideas.smart.validatedExemplars).toBe(true);
  });
});
