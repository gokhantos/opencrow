import { describe, expect, test } from "bun:test";
import {
  bindCritiques,
  buildCritiqueEntries,
  parseRawCritiques,
  type CritiqueBatch,
} from "./giant-critique-binding";

// ── Pass 3 (GIANT critique) chunked parse + bind ────────────────────────────
//
// ROOT CAUSE of the live GIANT-persistence regression (~2026-06-21): the critic
// scored the WHOLE over-generated pool (~20) in ONE call. With deepseek-v4-flash
// the fenced response TRUNCATED at the token cap, so the strict parser fell to
// the lenient walker EVERY run and the walker only salvaged the COMPLETE
// front-half scorecards (~10-11 of 20). The whole-pool positional fallback then
// refused to bind (11 != 20) and reworded titles missed the title map → NO
// candidate got a GIANT scorecard → every giant_* column persisted NULL.
//
// The fix CHUNKS the critique so each batch fits the budget, fully parses, and
// is positionally aligned PER BATCH. These tests pin the parse + bind contract.

/** A realistic, fully-formed GIANT critique entry (matches the critique schema). */
function critiqueEntry(title: string): Record<string, unknown> {
  return {
    title,
    scores: {
      acuteProblem: 4,
      whyNow: 3,
      demand: 2,
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
      nonObviousness: "no comparable indexed product",
      defensibility: "hard-won integration",
      marketShape: "narrow wedge into a large TAM",
      founderFit: "matches a hard-fact archetype",
    },
    verdict: "strong defensible wedge",
  };
}

/** Wrap entries in the model's ```json fence, optionally truncating mid-tail. */
function fenced(entries: readonly Record<string, unknown>[], truncate = false): string {
  const body = entries.map((e) => JSON.stringify(e)).join(",");
  if (!truncate) return `Here are the critiques:\n\`\`\`json\n[${body}]\n\`\`\``;
  // Truncate mid-element with NO closing ] or fence (the live deepseek failure).
  return `Here are the critiques:\n\`\`\`json\n[${body},{"title":"Tail","scores":{"acuteProblem":3,"whyNow"`;
}

describe("parseRawCritiques", () => {
  test("recovers a clean fenced array via the strict path", () => {
    const text = fenced([critiqueEntry("Alpha"), critiqueEntry("Beta")]);
    const raw = parseRawCritiques(text);
    expect(raw.map((r) => (r as { title: string }).title)).toEqual(["Alpha", "Beta"]);
  });

  test("recovers complete scorecards from a FENCED + TRUNCATED array (live failure mode)", () => {
    // 20-entry fenced array, truncated mid-21st (mirrors the over-gen pool).
    const entries = Array.from({ length: 20 }, (_, i) => critiqueEntry(`Idea ${i + 1}`));
    const text = fenced(entries, true);
    const raw = parseRawCritiques(text);
    // Strict parse fails (no closing fence/]); lenient recovers all 20 complete
    // entries and drops the half-written tail.
    expect(raw.length).toBe(20);
    expect((raw[0] as { title: string }).title).toBe("Idea 1");
    expect((raw[19] as { title: string }).title).toBe("Idea 20");
  });

  test("returns [] when no array is present (model refused)", () => {
    expect(parseRawCritiques("the model wrote prose and refused")).toEqual([]);
  });
});

describe("buildCritiqueEntries", () => {
  test("attaches a parsed GIANT scorecard to each titled row", () => {
    const raw = parseRawCritiques(fenced([critiqueEntry("Alpha")]));
    const entries = buildCritiqueEntries(raw, false);
    expect(entries.length).toBe(1);
    expect(entries[0]!.parsed.scores.acuteProblem).toBe(4);
    expect(entries[0]!.painSeverity).toBe(4);
    expect(entries[0]!.parsed.archetype).toBe("hard-fact");
  });

  test("skips rows with no usable title (cannot be bound)", () => {
    const entries = buildCritiqueEntries([{ scores: {} }, { title: "  " }], false);
    expect(entries.length).toBe(0);
  });
});

describe("bindCritiques: chunked per-batch binding", () => {
  // Helper: build a CritiqueBatch from candidate titles + the model's response.
  function batch(titles: readonly string[], responseTitles: readonly string[]): CritiqueBatch {
    const raw = parseRawCritiques(fenced(responseTitles.map((t) => critiqueEntry(t))));
    return { batchTitles: titles, entries: buildCritiqueEntries(raw, false) };
  }

  test("every candidate the model scored gets bound by exact title", () => {
    const b1 = batch(["Alpha", "Beta"], ["Alpha", "Beta"]);
    const b2 = batch(["Gamma", "Delta"], ["Gamma", "Delta"]);
    const binder = bindCritiques([b1, b2]);

    expect(binder.lookup(0, "Alpha")?.parsed.scores.acuteProblem).toBe(4);
    expect(binder.lookup(1, "Beta")).toBeDefined();
    expect(binder.lookup(2, "Gamma")).toBeDefined();
    expect(binder.lookup(3, "Delta")).toBeDefined();
  });

  test("PER-BATCH positional fallback binds a reworded title (count matches)", () => {
    // The model lightly reworded the titles but returned one entry per candidate,
    // so the batch is positionally aligned and binds by index even though the
    // title map misses.
    const b1 = batch(["Alpha", "Beta"], ["Alpha (v2)", "Beta — refined"]);
    const binder = bindCritiques([b1]);
    expect(binder.lookup(0, "Alpha")).toBeDefined();
    expect(binder.lookup(1, "Beta")).toBeDefined();
  });

  test("REGRESSION: a batch that dropped one entry still binds the survivors", () => {
    // Batch 1 lost an entry to truncation (1 of 2 recovered) so it is NOT
    // positionally aligned; only the exact-title survivor binds there. Batch 2
    // is intact and fully binds — the per-batch design means batch-1 truncation
    // can no longer disable binding for batch 2 (the old whole-pool gate did).
    const b1: CritiqueBatch = {
      batchTitles: ["Alpha", "Beta"],
      entries: buildCritiqueEntries(parseRawCritiques(fenced([critiqueEntry("Alpha")])), false),
    };
    const b2 = batch(["Gamma", "Delta"], ["G-reworded", "D-reworded"]);
    const binder = bindCritiques([b1, b2]);

    // Alpha binds by title; Beta was dropped (no entry) -> undefined.
    expect(binder.lookup(0, "Alpha")).toBeDefined();
    expect(binder.lookup(1, "Beta")).toBeUndefined();
    // Batch 2 stays positionally aligned and binds BOTH despite the rewording.
    expect(binder.lookup(2, "Gamma")).toBeDefined();
    expect(binder.lookup(3, "Delta")).toBeDefined();
  });

  test("title binding wins over a misaligned positional index across batches", () => {
    const b1 = batch(["Alpha"], ["Alpha"]);
    const b2 = batch(["Beta"], ["Beta"]);
    const binder = bindCritiques([b1, b2]);
    // Beta is at pool index 1; its critique must come from batch 2 by title.
    expect(binder.lookup(1, "Beta")?.verdict).toBe("strong defensible wedge");
  });
});
