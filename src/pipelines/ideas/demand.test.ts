import { test, expect, describe } from "bun:test";
import {
  DEMAND_EVIDENCE_KINDS,
  DEMAND_SCORE_MAX,
  DEMAND_SCORE_MIN,
  ABSENCE_SCORE_CAP,
  ABSENCE_CONFIDENCE_CAP,
  DEMAND_KIND_WEIGHTS,
  extractDemandKeywords,
  distinctKeywordHits,
  DEFAULT_MIN_KEYWORD_HITS,
  aggregateDemand,
  hasCitedDemand,
  demandArtifactSchema,
  demandEvidenceSchema,
  stemToken,
  matchesKeyword,
  type DemandEvidence,
} from "./demand";

// ── helpers ──────────────────────────────────────────────────────────────────

function ev(
  overrides: Partial<DemandEvidence> & Pick<DemandEvidence, "kind" | "count">,
): DemandEvidence {
  return {
    query: "x",
    ...overrides,
  } as DemandEvidence;
}

// ── extractDemandKeywords (PURE) ─────────────────────────────────────────────

describe("extractDemandKeywords", () => {
  test("is deterministic — same input yields identical output", () => {
    const c = {
      title: "Expense report automation for freelancers",
      summary: "Freelancers waste hours on expense reports every month.",
      reasoning: "The expense report workflow is painful and manual.",
    };
    const a = extractDemandKeywords(c);
    const b = extractDemandKeywords(c);
    expect(a).toEqual(b);
  });

  test("drops stopwords and pipeline boilerplate (app/tool/the/for)", () => {
    const kws = extractDemandKeywords({
      title: "A tool for the app users",
      summary: "the app the tool for users",
    });
    for (const noise of ["the", "for", "app", "tool", "users", "a"]) {
      expect(kws).not.toContain(noise);
    }
  });

  test("keeps salient noun-phrase bigrams that recur", () => {
    const kws = extractDemandKeywords({
      title: "Invoice reconciliation",
      summary: "invoice reconciliation pain; manual invoice reconciliation",
      reasoning: "automating invoice reconciliation",
    });
    expect(kws).toContain("invoice reconciliation");
  });

  test("title terms are weighted (double-counted) over body terms", () => {
    const kws = extractDemandKeywords({
      title: "kubernetes",
      summary: "logging is mentioned",
    });
    // At equal frequency, the title term (weight 2) outranks the body term
    // (weight 1): the candidate's title is its sharpest self-description.
    const unigrams = kws.filter((k) => !k.includes(" "));
    expect(unigrams.indexOf("kubernetes")).toBeLessThan(
      unigrams.indexOf("logging"),
    );
  });

  test("respects maxKeywords cap", () => {
    const kws = extractDemandKeywords(
      {
        summary:
          "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu",
      },
      { maxKeywords: 3 },
    );
    expect(kws.length).toBeLessThanOrEqual(3);
  });

  test("filters pure-digit and short tokens", () => {
    const kws = extractDemandKeywords({
      title: "2024 ab compliance reporting",
    });
    expect(kws).not.toContain("2024");
    expect(kws).not.toContain("ab");
    expect(kws).toContain("compliance");
  });

  test("returns [] for empty candidate text", () => {
    expect(extractDemandKeywords({})).toEqual([]);
    expect(extractDemandKeywords({ title: "  ", summary: "the and or" })).toEqual(
      [],
    );
  });

  test("drops ultra-generic single tokens (genericness stoplist)", () => {
    // These tokens are too common to indicate topical relevance; on their own
    // they would match almost any scraped row and inflate the demand count.
    const kws = extractDemandKeywords({
      title: "tracking monitor restaurant",
      summary: "health tracking app that helps everyone every day",
    });
    for (const generic of [
      "tracking",
      "monitor",
      "restaurant",
      "health",
      "everyone",
      "every",
      "day",
    ]) {
      expect(kws).not.toContain(generic);
    }
  });

  test("keeps a topical phrase even when its parts are generic unigrams", () => {
    // "glucose monitoring": "monitoring" is generic alone, but the PHRASE is
    // sharply topical, so the bigram survives while the lone "monitoring" does not.
    const kws = extractDemandKeywords({
      title: "glucose monitoring",
      summary: "glucose monitoring for diabetes; glucose monitoring patterns",
    });
    expect(kws).toContain("glucose monitoring");
    expect(kws).not.toContain("monitoring");
    expect(kws).toContain("glucose");
  });

  test("drops a bigram made of two generic words", () => {
    const kws = extractDemandKeywords({
      title: "easy login health tracking",
      summary: "easy login; health tracking",
    });
    expect(kws).not.toContain("easy login");
  });
});

// ── distinctKeywordHits (RELEVANCE GATE primitive) ───────────────────────────

describe("distinctKeywordHits", () => {
  const KWS = ["glucose monitoring", "glucose", "diabetes", "insulin"] as const;

  test("counts distinct keywords present, ignores absent ones", () => {
    // "diabetes" + "insulin" co-occur; "glucose"/"glucose monitoring" absent.
    expect(distinctKeywordHits("managing diabetes with insulin", KWS)).toBe(2);
  });

  test("a single non-phrase keyword counts as 1 (below the default gate)", () => {
    expect(distinctKeywordHits("just some diabetes chatter", KWS)).toBe(1);
    expect(1).toBeLessThan(DEFAULT_MIN_KEYWORD_HITS);
  });

  test("a multi-word phrase match counts as strong co-occurrence (>=2)", () => {
    // The phrase alone clears the default gate — its parts already co-occurred.
    const hits = distinctKeywordHits("review of glucose monitoring tools", KWS);
    expect(hits).toBeGreaterThanOrEqual(DEFAULT_MIN_KEYWORD_HITS);
  });

  test("a repeated keyword does not inflate the hit count", () => {
    expect(distinctKeywordHits("diabetes diabetes diabetes", KWS)).toBe(1);
  });

  test("returns 0 for empty haystack or empty keywords", () => {
    expect(distinctKeywordHits("", KWS)).toBe(0);
    expect(distinctKeywordHits("diabetes", [])).toBe(0);
  });

  test("phraseWeight is configurable", () => {
    // Isolate the phrase contribution with a single-phrase keyword set.
    const phraseOnly = ["staff scheduling"] as const;
    expect(distinctKeywordHits("staff scheduling tool", phraseOnly, 1)).toBe(1);
    expect(distinctKeywordHits("staff scheduling tool", phraseOnly, 3)).toBe(3);
  });

  // Lever 3 — fuzzy matching is inherited by distinctKeywordHits.
  test("matches morphological variants via stemming (fuzzy on by default)", () => {
    // "scheduling" keyword should match a row that says "scheduler"/"schedules".
    const kws = ["scheduling", "overtime"] as const;
    expect(
      distinctKeywordHits("the scheduler keeps double-booking overtime", kws),
    ).toBe(2);
  });

  test("rejects substring-only matches at word boundaries", () => {
    // "cat" must NOT match inside "category" — the old includes() bug.
    expect(distinctKeywordHits("a product category page", ["cat", "page"])).toBe(
      1,
    );
  });

  test("matches curated synonyms (payroll ↔ wages)", () => {
    const kws = ["payroll", "compliance"] as const;
    expect(
      distinctKeywordHits("late wages and compliance headaches", kws),
    ).toBe(2);
  });

  test("can be made literal via fuzzyMatch=false (restores old behavior)", () => {
    // With fuzzy off, "scheduling" no longer matches "scheduler".
    const kws = ["scheduling", "overtime"] as const;
    expect(
      distinctKeywordHits("the scheduler logs overtime", kws, 2, false),
    ).toBe(1);
  });
});

// ── stemToken (Lever 3 — PURE) ───────────────────────────────────────────────

describe("stemToken", () => {
  test("strips common inflections", () => {
    expect(stemToken("schedules")).toBe(stemToken("schedule"));
    expect(stemToken("scheduling")).toBe(stemToken("schedule"));
    expect(stemToken("scheduled")).toBe(stemToken("schedule"));
    expect(stemToken("scheduler")).toBe(stemToken("schedule"));
  });

  test("collapses -es plurals", () => {
    expect(stemToken("invoices")).toBe(stemToken("invoice"));
    expect(stemToken("boxes")).toBe(stemToken("box"));
  });

  test("does NOT over-stem distinct lexemes", () => {
    // The classic over-stemming trap: "billing" must not collapse to "bill".
    expect(stemToken("billing")).not.toBe(stemToken("bill"));
    // Short words are left intact (no stripping below the safety length).
    expect(stemToken("bed")).toBe("bed");
    expect(stemToken("red")).toBe("red");
    expect(stemToken("ring")).toBe("ring");
  });

  test("is deterministic and idempotent", () => {
    const once = stemToken("reconciliations");
    expect(stemToken("reconciliations")).toBe(once);
    expect(stemToken(once)).toBe(once);
  });

  test("handles -tion → -t only where safe", () => {
    // "automation" → "automat" (a real shared stem with "automate").
    expect(stemToken("automation")).toBe(stemToken("automate"));
  });
});

// ── matchesKeyword (Lever 3 — PURE) ──────────────────────────────────────────

describe("matchesKeyword", () => {
  test("exact word match", () => {
    expect(matchesKeyword("manual invoice entry", "invoice")).toBe(true);
  });

  test("morphological variant match (stem)", () => {
    expect(matchesKeyword("our scheduler is broken", "scheduling")).toBe(true);
    expect(matchesKeyword("invoices piling up", "invoicing")).toBe(true);
  });

  test("word-boundary precision — rejects substrings", () => {
    expect(matchesKeyword("the category list", "cat")).toBe(false);
    expect(matchesKeyword("schedules slipping", "scheduling")).toBe(true); // stem
    expect(matchesKeyword("a classic case", "lass")).toBe(false);
  });

  test("multi-word phrase keyword matches as a boundary phrase", () => {
    expect(matchesKeyword("staff scheduling tool", "staff scheduling")).toBe(
      true,
    );
    // The phrase parts must be adjacent (stemmed), not scattered.
    expect(
      matchesKeyword("staff hate the scheduling form", "staff scheduling"),
    ).toBe(false);
  });

  test("curated synonym match", () => {
    expect(matchesKeyword("we cut wages last month", "payroll")).toBe(true);
    expect(matchesKeyword("billing disputes everywhere", "invoicing")).toBe(
      true,
    );
  });

  test("no false synonym beyond the curated map", () => {
    // "payroll" must not match an unrelated word just because both are HR-ish.
    expect(matchesKeyword("the manager approved it", "payroll")).toBe(false);
  });

  test("empty inputs are safe", () => {
    expect(matchesKeyword("", "invoice")).toBe(false);
    expect(matchesKeyword("invoice", "")).toBe(false);
  });
});

// ── aggregateDemand: absence penalty ─────────────────────────────────────────

describe("aggregateDemand — absence penalty", () => {
  test("no evidence => low score (<=cap), low confidence (<=cap), NOT neutral", () => {
    const art = aggregateDemand([]);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
    expect(art.confidence).toBeLessThanOrEqual(ABSENCE_CONFIDENCE_CAP);
    expect(art.whitespace).toBe(0);
    expect(art.evidence).toEqual([]);
    // explicitly NOT a free middling score
    expect(art.score).toBeLessThan(2.5);
  });

  test("evidence whose counts are all zero is treated as absence", () => {
    const art = aggregateDemand([
      ev({ kind: "reddit_intent", count: 0 }),
      ev({ kind: "funding_news", count: 0 }),
    ]);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
    expect(art.confidence).toBeLessThanOrEqual(ABSENCE_CONFIDENCE_CAP);
  });

  test("non-array input degrades to absence (graceful)", () => {
    const art = aggregateDemand(undefined as unknown as DemandEvidence[]);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
  });
});

// ── aggregateDemand: scoring ─────────────────────────────────────────────────

describe("aggregateDemand — scoring", () => {
  test("score rises monotonically with weighted match volume", () => {
    const low = aggregateDemand([ev({ kind: "reddit_intent", count: 1 })]);
    const mid = aggregateDemand([ev({ kind: "reddit_intent", count: 5 })]);
    const high = aggregateDemand([ev({ kind: "reddit_intent", count: 30 })]);
    expect(low.score).toBeLessThan(mid.score);
    expect(mid.score).toBeLessThan(high.score);
  });

  test("score is capped at DEMAND_SCORE_MAX even with huge volume", () => {
    const art = aggregateDemand([ev({ kind: "funding_news", count: 1e6 })]);
    expect(art.score).toBeLessThanOrEqual(DEMAND_SCORE_MAX);
    expect(art.score).toBeGreaterThanOrEqual(DEMAND_SCORE_MIN);
  });

  test("score is log-scaled (diminishing returns), not linear", () => {
    // equal additive steps => shrinking increments (strict concavity of log1p)
    const s5 = aggregateDemand([ev({ kind: "reddit_intent", count: 5 })]).score;
    const s15 = aggregateDemand([ev({ kind: "reddit_intent", count: 15 })]).score;
    const s25 = aggregateDemand([ev({ kind: "reddit_intent", count: 25 })]).score;
    expect(s15 - s5).toBeGreaterThan(s25 - s15);
  });

  test("kind weights make funding count for more than reddit at equal count", () => {
    const reddit = aggregateDemand([ev({ kind: "reddit_intent", count: 4 })]);
    const funding = aggregateDemand([ev({ kind: "funding_news", count: 4 })]);
    expect(DEMAND_KIND_WEIGHTS.funding_news).toBeGreaterThan(
      DEMAND_KIND_WEIGHTS.reddit_intent,
    );
    expect(funding.score).toBeGreaterThan(reddit.score);
  });

  test("clears the absence cap once real evidence exists", () => {
    const art = aggregateDemand([
      ev({ kind: "reddit_intent", count: 8 }),
      ev({ kind: "funding_news", count: 3 }),
    ]);
    expect(art.score).toBeGreaterThan(ABSENCE_SCORE_CAP);
  });
});

// ── aggregateDemand: confidence ──────────────────────────────────────────────

describe("aggregateDemand — confidence", () => {
  test("confidence grows with evidence volume", () => {
    const few = aggregateDemand([ev({ kind: "reddit_intent", count: 1 })]);
    const many = aggregateDemand([ev({ kind: "reddit_intent", count: 6 })]);
    expect(many.confidence).toBeGreaterThan(few.confidence);
  });

  test("source-kind diversity raises confidence at equal volume", () => {
    const single = aggregateDemand([
      ev({ kind: "reddit_intent", count: 2 }),
      ev({ kind: "reddit_intent", count: 2 }),
    ]);
    const diverse = aggregateDemand([
      ev({ kind: "reddit_intent", count: 2 }),
      ev({ kind: "funding_news", count: 2 }),
    ]);
    expect(diverse.confidence).toBeGreaterThan(single.confidence);
  });

  test("confidence stays within [0,1]", () => {
    const art = aggregateDemand([
      ev({ kind: "reddit_intent", count: 100 }),
      ev({ kind: "funding_news", count: 100 }),
      ev({ kind: "hiring", count: 100 }),
      ev({ kind: "search_trend", count: 100 }),
    ]);
    expect(art.confidence).toBeLessThanOrEqual(1);
    expect(art.confidence).toBeGreaterThanOrEqual(0);
  });

  test("below minMatches, confidence is dampened toward the absence cap", () => {
    const thin = aggregateDemand([ev({ kind: "funding_news", count: 1 })], {
      minMatches: 5,
    });
    expect(thin.confidence).toBeLessThanOrEqual(ABSENCE_CONFIDENCE_CAP);
    // score still stands (a single strong funding hit is real)
    expect(thin.score).toBeGreaterThan(0);
  });
});

// ── aggregateDemand: whitespace ──────────────────────────────────────────────

describe("aggregateDemand — whitespace", () => {
  test("whitespace == demand intensity when no supply density given", () => {
    const art = aggregateDemand([ev({ kind: "reddit_intent", count: 30 })]);
    expect(art.whitespace).toBeCloseTo(art.score / DEMAND_SCORE_MAX, 6);
  });

  test("supply density discounts whitespace (wanted but served = low)", () => {
    const matches = [ev({ kind: "reddit_intent", count: 30 })];
    const open = aggregateDemand(matches, { supplyDensity: 0 });
    const crowded = aggregateDemand(matches, { supplyDensity: 0.9 });
    expect(crowded.whitespace).toBeLessThan(open.whitespace);
  });

  test("whitespace clamps to 0 when supply density exceeds demand intensity", () => {
    const art = aggregateDemand([ev({ kind: "reddit_intent", count: 2 })], {
      supplyDensity: 1,
    });
    expect(art.whitespace).toBe(0);
  });

  test("high demand + low supply yields high whitespace", () => {
    const art = aggregateDemand([ev({ kind: "funding_news", count: 35 })], {
      supplyDensity: 0.1,
    });
    expect(art.whitespace).toBeGreaterThan(0.5);
  });
});

// ── hasCitedDemand (the GIANT evidence-gate opener) ──────────────────────────

describe("hasCitedDemand", () => {
  test("false on the absence artifact", () => {
    expect(hasCitedDemand(aggregateDemand([]))).toBe(false);
  });

  test("false when evidence exists but score is at/below the absence cap", () => {
    // a single tiny match keeps score at/below the cap
    const art = aggregateDemand([ev({ kind: "reddit_intent", count: 0.01 })]);
    expect(hasCitedDemand(art)).toBe(false);
  });

  test("true once real cited evidence pushes score above the cap", () => {
    const art = aggregateDemand([ev({ kind: "funding_news", count: 10 })]);
    expect(hasCitedDemand(art)).toBe(true);
  });

  test("review_complaint evidence counts as cited demand (escapes the cap)", () => {
    const art = aggregateDemand([
      ev({ kind: "review_complaint", count: 6, quote: "this app is broken" }),
    ]);
    expect(art.score).toBeGreaterThan(ABSENCE_SCORE_CAP);
    expect(hasCitedDemand(art)).toBe(true);
  });

  test("hn_intent evidence counts as cited demand (escapes the cap)", () => {
    const art = aggregateDemand([
      ev({ kind: "hn_intent", count: 6, quote: "is there a tool for X" }),
    ]);
    expect(art.score).toBeGreaterThan(ABSENCE_SCORE_CAP);
    expect(hasCitedDemand(art)).toBe(true);
  });
});

// ── schema / shape guards ────────────────────────────────────────────────────

describe("schemas", () => {
  test("DEMAND_EVIDENCE_KINDS covers the documented kinds", () => {
    const kinds: string[] = [...DEMAND_EVIDENCE_KINDS];
    expect(kinds.sort()).toEqual(
      [
        "funding_news",
        "hiring",
        "hn_intent",
        "reddit_intent",
        "review_complaint",
        "search_trend",
        "semantic_corpus",
        "x_intent",
      ].sort(),
    );
  });

  test("every kind has a positive weight", () => {
    for (const kind of DEMAND_EVIDENCE_KINDS) {
      expect(DEMAND_KIND_WEIGHTS[kind]).toBeGreaterThan(0);
    }
  });

  test("aggregateDemand output validates against demandArtifactSchema", () => {
    const art = aggregateDemand([
      ev({ kind: "reddit_intent", count: 5, quote: "is there a tool for X" }),
      ev({ kind: "funding_news", count: 2, sourceId: "news_1" }),
    ]);
    expect(() => demandArtifactSchema.parse(art)).not.toThrow();
  });

  test("demandEvidenceSchema rejects an unknown kind", () => {
    expect(() =>
      demandEvidenceSchema.parse({ kind: "twitter", query: "x", count: 1 }),
    ).toThrow();
  });
});
