import { describe, expect, test } from "bun:test";

import {
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
      adaptiveCollection: true,
      validatedExemplars: true,
      chainOfEvidence: true,
      rerankTopK: 6,
      rerankFetchK: 30,
    });
  });

  test("external-service and expensive gates default OFF", () => {
    const parsed = smartConfigSchema.parse({});
    expect(parsed.sigeValuation).toBe(false);
    expect(parsed.knowledgeGraphRetrieval).toBe(false);
    expect(parsed.deepSearchReranker).toBe(false);
    expect(parsed.signalFacets).toBe(false);
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
