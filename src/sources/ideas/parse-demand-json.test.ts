/**
 * Unit tests for parseDemandJson (src/sources/ideas/store.ts).
 *
 * Pure function — no DB, no I/O. Covers all four input forms:
 *   - already-parsed DemandArtifact object
 *   - valid JSON string
 *   - null / undefined
 *   - invalid JSON string or object that fails demandArtifactSchema
 *
 * Lane: *.test.ts (unit, no DB).
 */
import { describe, expect, it } from "bun:test";
import type { DemandArtifact } from "../../pipelines/ideas/demand";
import { parseDemandJson } from "./store";

const VALID_ARTIFACT: DemandArtifact = {
  score: 3.5,
  confidence: 0.7,
  whitespace: 0.6,
  evidence: [
    {
      kind: "reddit_intent",
      query: "async task queue",
      count: 5,
    },
  ],
};

describe("parseDemandJson", () => {
  describe("valid DemandArtifact object", () => {
    it("returns the artifact unchanged when passed a real object", () => {
      const result = parseDemandJson(VALID_ARTIFACT);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(3.5);
      expect(result!.confidence).toBe(0.7);
      expect(result!.whitespace).toBe(0.6);
      expect(result!.evidence).toHaveLength(1);
    });

    it("accepts an artifact with no evidence array items", () => {
      const artifact: DemandArtifact = {
        score: 0,
        confidence: 0.1,
        whitespace: 0,
        evidence: [],
      };
      const result = parseDemandJson(artifact);
      expect(result).not.toBeNull();
      expect(result!.evidence).toHaveLength(0);
    });

    it("accepts an artifact with optional evidence fields (quote, sourceId)", () => {
      const artifact: DemandArtifact = {
        score: 4.5,
        confidence: 0.9,
        whitespace: 0.8,
        evidence: [
          {
            kind: "funding_news",
            query: "devops automation",
            count: 2,
            quote: "We raised to automate devops",
            sourceId: "news-abc-123",
          },
        ],
      };
      const result = parseDemandJson(artifact);
      expect(result).not.toBeNull();
      expect(result!.evidence[0]?.quote).toBe("We raised to automate devops");
    });
  });

  describe("valid JSON string", () => {
    it("parses a JSON string of a valid artifact", () => {
      const json = JSON.stringify(VALID_ARTIFACT);
      const result = parseDemandJson(json);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(3.5);
      expect(result!.confidence).toBe(0.7);
    });

    it("accepts a minimal JSON string (no optional evidence fields)", () => {
      const json = JSON.stringify({
        score: 1,
        confidence: 0.2,
        whitespace: 0.1,
        evidence: [],
      });
      expect(parseDemandJson(json)).not.toBeNull();
    });
  });

  describe("null / undefined", () => {
    it("returns null for null", () => {
      expect(parseDemandJson(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(parseDemandJson(undefined)).toBeNull();
    });
  });

  describe("invalid inputs", () => {
    it("returns null for a non-JSON string", () => {
      expect(parseDemandJson("not json at all" as unknown as string)).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(parseDemandJson("" as unknown as string)).toBeNull();
    });

    it("returns null when score is missing", () => {
      const bad = JSON.stringify({ confidence: 0.5, whitespace: 0.5, evidence: [] });
      expect(parseDemandJson(bad)).toBeNull();
    });

    it("returns null when confidence is missing", () => {
      const bad = JSON.stringify({ score: 3, whitespace: 0.5, evidence: [] });
      expect(parseDemandJson(bad)).toBeNull();
    });

    it("returns null when evidence is not an array", () => {
      const bad = JSON.stringify({ score: 3, confidence: 0.5, whitespace: 0.5, evidence: "bad" });
      expect(parseDemandJson(bad)).toBeNull();
    });

    it("returns null when score is out of range (>5)", () => {
      const bad = JSON.stringify({ score: 10, confidence: 0.5, whitespace: 0.5, evidence: [] });
      expect(parseDemandJson(bad)).toBeNull();
    });

    it("returns null when confidence is out of range (>1)", () => {
      const bad = JSON.stringify({ score: 3, confidence: 1.5, whitespace: 0.5, evidence: [] });
      expect(parseDemandJson(bad)).toBeNull();
    });

    it("returns null when passed a number (wrong type)", () => {
      expect(parseDemandJson(42 as unknown as DemandArtifact)).toBeNull();
    });
  });
});
