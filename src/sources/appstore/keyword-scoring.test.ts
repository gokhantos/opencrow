import { describe, expect, it } from "bun:test";
import {
  computeCompetitiveness,
  computeDemand,
  computeIncumbentWeakness,
  computeOpportunity,
} from "./keyword-scoring";
import type { TopApp } from "./keyword-types";

const app = (reviews: number, rating: number, ratingsPerDay: number): TopApp => ({
  id: "x",
  name: "x",
  reviews,
  rating,
  ageDays: 1000,
  ratingsPerDay,
  titleMatch: true,
});

// saturated field (receipt-scanner-like): many strong apps
const saturated = Array.from({ length: 20 }, () => app(400_000, 4.6, 180));
// open field (fatty-liver-like): all toys
const open = Array.from({ length: 20 }, () => app(8, 3.4, 0.03));

describe("keyword-scoring", () => {
  it("scores a saturated field high (>=70) and an open field low (<=30)", () => {
    expect(computeCompetitiveness(saturated)).toBeGreaterThanOrEqual(70);
    expect(computeCompetitiveness(open)).toBeLessThanOrEqual(30);
  });
  it("flags weak incumbents on the open field", () => {
    const comp = computeCompetitiveness(open);
    expect(computeIncumbentWeakness(open, comp)).toBeGreaterThan(0.6);
  });
  it("ranks the open gap's opportunity above the saturated one", () => {
    const oComp = computeCompetitiveness(open);
    const sComp = computeCompetitiveness(saturated);
    const oOpp = computeOpportunity({
      demand: computeDemand(open),
      competitiveness: oComp,
      incumbentWeakness: computeIncumbentWeakness(open, oComp),
      trend: "heating",
    });
    const sOpp = computeOpportunity({
      demand: computeDemand(saturated),
      competitiveness: sComp,
      incumbentWeakness: computeIncumbentWeakness(saturated, sComp),
      trend: "stable",
    });
    expect(oOpp).toBeGreaterThan(sOpp);
  });
  it("handles an empty field without throwing", () => {
    expect(computeCompetitiveness([])).toBe(0);
    expect(computeDemand([])).toBe(0);
  });
});
