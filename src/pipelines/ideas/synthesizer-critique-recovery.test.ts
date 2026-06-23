import { test, expect, describe } from "bun:test";
import { parseJsonArrayLenient, parseJsonFromResponse } from "./synthesizer";

// ── Pass 3 (GIANT critique) truncation recovery ─────────────────────────────
//
// ROOT CAUSE of the live GIANT-persistence bug: with generate-wide ON (default),
// the critique LLM must emit one scorecard PER candidate (up to maxCandidates).
// That array overflows the output-token cap and is TRUNCATED mid-stream. The
// strict parser (parseJsonFromResponse) yields ZERO entries on a truncated array,
// so every candidate fell through critiqueIdeas' "no critique" branch WITHOUT a
// GIANT scorecard → candidate.giant stayed undefined → giant_* columns persisted
// NULL. critiqueIdeas now falls back to the truncation-tolerant lenient parser,
// which recovers every COMPLETE scorecard so GIANT survives to the store.
//
// These tests pin that contract on the shared pure parsers the fix relies on.

/** A realistic, fully-formed GIANT critique entry (matches the critique schema). */
function critiqueEntry(title: string): string {
  return JSON.stringify({
    title,
    scores: {
      acuteProblem: 4,
      whyNow: 3,
      demand: 2,
      monetization: 4,
      feasibility: 4,
      nonObviousness: 4,
      defensibility: 3,
      marketShape: 3,
      founderFit: 4,
    },
    archetype: "hard-fact",
    painSeverity: 4,
    whyNow: [
      {
        axis: "technological",
        claim: "vendor shipped a stable API in 2025-11",
        boundSignalId: "producthunt_3",
        date: "2025-11",
        strength: 0.8,
      },
    ],
    evidence: {
      acuteProblem: "complaint cluster of 40+ reddit posts",
      whyNow: "API GA dated 2025-11",
      demand: "",
      monetization: "named buyer with a $49/mo plan",
      feasibility: "all integrations exist via public APIs today",
      nonObviousness: "no comparable indexed product",
      defensibility: "hard-won integration",
      marketShape: "narrow wedge into a large TAM",
      founderFit: "matches a hard-fact archetype",
    },
    verdict: "strong defensible wedge",
  });
}

describe("Pass 3 critique: truncated GIANT array recovery", () => {
  test("strict parser yields nothing when the array is cut off mid-element", () => {
    // Build a 3-entry array but truncate the trailing element (token cap hit).
    const full = `[${critiqueEntry("Alpha")},${critiqueEntry("Beta")},{"title":"Gamma","scores":{"acuteProblem":3,"whyNow"`;
    // Strict parse collapses to the fallback (this is the bug surface).
    expect(parseJsonFromResponse<unknown[]>(full, [])).toEqual([]);
  });

  test("lenient parser recovers every COMPLETE scorecard from a truncated array", () => {
    const truncated = `[${critiqueEntry("Alpha")},${critiqueEntry("Beta")},{"title":"Gamma","scores":{"acuteProblem":3,"whyNow"`;
    const recovered = parseJsonArrayLenient(truncated);

    // The two complete entries survive; the half-written third is discarded.
    expect(recovered.length).toBe(2);
    const titles = recovered.map((r) => (r as { title: string }).title);
    expect(titles).toEqual(["Alpha", "Beta"]);

    // Recovered entries are real scorecards (so GIANT can be attached + persisted).
    const first = recovered[0] as { scores: { acuteProblem: number } };
    expect(first.scores.acuteProblem).toBe(4);
  });

  test("lenient parser keeps all entries when the array is NOT truncated", () => {
    const whole = `[${critiqueEntry("Alpha")},${critiqueEntry("Beta")}]`;
    const recovered = parseJsonArrayLenient(whole);
    expect(recovered.map((r) => (r as { title: string }).title)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  test("lenient parser returns [] when there is no array at all", () => {
    expect(parseJsonArrayLenient("the model refused and wrote prose")).toEqual(
      [],
    );
  });
});
