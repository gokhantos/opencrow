import { describe, expect, test } from "bun:test";
import { DEFAULT_BUILDER_PROFILE } from "./builder-profile";
import {
  buildGiantCritiquePrompt,
  type GiantCritiqueContext,
} from "./giant-critique";
import type { GeneratedIdeaCandidate } from "./types";

// The chat-backed runCritiqueBatch is exercised end-to-end by the synthesizer
// integration paths; here we pin the PURE prompt builder (product surface).

function candidate(title: string): GeneratedIdeaCandidate {
  return {
    title,
    summary: "summary",
    reasoning: "reasoning",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "",
    category: "devtools",
    qualityScore: 0,
    targetAudience: "devs",
    keyFeatures: ["a", "b"],
    revenueModel: "",
    trendIntersection: "",
  };
}

function ctx(competabilityOn: boolean): GiantCritiqueContext {
  return {
    rawContext: "=== RAW TRENDS SUMMARY ===\nstuff",
    antiSection: "",
    competabilityOn,
    builderProfile: DEFAULT_BUILDER_PROFILE,
  };
}

describe("buildGiantCritiquePrompt", () => {
  test("numbers candidates restarting at 1 per batch (positional contract)", () => {
    const prompt = buildGiantCritiquePrompt(
      [candidate("Alpha"), candidate("Beta")],
      ctx(false),
    );
    expect(prompt).toContain(`1. "Alpha"`);
    expect(prompt).toContain(`2. "Beta"`);
    // The critic is told to return ONE entry per idea in the same order.
    expect(prompt).toContain("one entry per idea (in the same order)");
  });

  test("omits the competability block when competability is off", () => {
    const prompt = buildGiantCritiquePrompt([candidate("Alpha")], ctx(false));
    expect(prompt).not.toContain("COMPETABILITY");
  });

  test("includes the competability block when competability is on", () => {
    const prompt = buildGiantCritiquePrompt([candidate("Alpha")], ctx(true));
    expect(prompt).toContain("COMPETABILITY");
    expect(prompt).toContain('"networkEffect"');
  });

  test("includes the monetization + feasibility GIANT axes in the schema", () => {
    const prompt = buildGiantCritiquePrompt([candidate("Alpha")], ctx(false));
    expect(prompt).toContain('"monetization"');
    expect(prompt).toContain('"feasibility"');
  });
});
