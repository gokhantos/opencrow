import { describe, expect, test } from "bun:test";
import {
  BRAND_SERP_MIN_FIELD_SIZE,
  DEFAULT_RETIREMENT_RULES,
  FAMILY_BLOCKING_REASONS,
  FAMILY_ROOT_MAX_TOKENS,
  isBrandDominatedSerp,
  isFamilyBlocked,
  isFamilyRootEligible,
  type RetirementCandidate,
  type RetirementRules,
  type RetirementSerpShape,
  decideRetirement,
  shouldRetireByScore,
  tokenPrefixes,
} from "./keyword-retirement";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A brand-dominated SERP shape modeled on the LIVE measurement that set these
 * thresholds (2026-07-25, `appstore_keyword_scans` latest US scan per active
 * keyword): "netgear" — 14 apps in the field, 7 of whose titles begin with the
 * exact keyword, rank 1 among them, holding 0.37 of the field's review mass.
 */
function brandSerp(overrides: Partial<RetirementSerpShape> = {}): RetirementSerpShape {
  return {
    fieldSize: 14,
    exactBrandTitleCount: 7,
    rankOneExactBrandTitle: true,
    rankOneReviewShare: 0.6,
    ...overrides,
  };
}

function candidate(overrides: Partial<RetirementCandidate> = {}): RetirementCandidate {
  return {
    keyword: "budget planner",
    source: "autocomplete",
    serp: null,
    autocompleteProbe: "never-probed",
    score: null,
    ...overrides,
  };
}

const NO_BRAND_SEGMENTS: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------

describe("DEFAULT_RETIREMENT_RULES", () => {
  test("score-based retirement ships DISABLED", () => {
    expect(DEFAULT_RETIREMENT_RULES.scoreBased).toBe(false);
  });

  test("the autocomplete tri-state rule ships DISABLED (its data source is not persisted yet)", () => {
    expect(DEFAULT_RETIREMENT_RULES.autocompleteProbedAbsent).toBe(false);
  });

  test("the three score-independent rules ship ENABLED", () => {
    expect(DEFAULT_RETIREMENT_RULES.structuralJunk).toBe(true);
    expect(DEFAULT_RETIREMENT_RULES.brandLexical).toBe(true);
    expect(DEFAULT_RETIREMENT_RULES.brandSerpShape).toBe(true);
  });
});

describe("isBrandDominatedSerp", () => {
  test("fires when rank 1 is an exact-brand title, half the field matches, and rank 1 holds the review mass", () => {
    expect(isBrandDominatedSerp(brandSerp())).toBe(true);
  });

  test("does NOT fire when rank 1 is not itself an exact-brand title", () => {
    expect(isBrandDominatedSerp(brandSerp({ rankOneExactBrandTitle: false }))).toBe(false);
  });

  test("does NOT fire below the title-share floor", () => {
    // 3/14 = 0.21, under BRAND_SERP_MIN_TITLE_SHARE.
    expect(isBrandDominatedSerp(brandSerp({ exactBrandTitleCount: 3 }))).toBe(false);
  });

  test("does NOT fire on a thin field, however unanimous", () => {
    expect(
      isBrandDominatedSerp({
        fieldSize: BRAND_SERP_MIN_FIELD_SIZE - 1,
        exactBrandTitleCount: BRAND_SERP_MIN_FIELD_SIZE - 1,
        rankOneExactBrandTitle: true,
        rankOneReviewShare: 1,
      }),
    ).toBe(false);
  });

  test("does NOT fire when review mass is spread across the field (exact-match GENERIC keyword, not a brand)", () => {
    // Live counter-example this guard exists for: "speaker cleaner" — 9 of 17
    // titles begin with the keyword and rank 1 does too, but rank 1 holds
    // 0.001 of the review mass. That is title-stuffing on a generic term, the
    // opposite of a brand-navigational field.
    expect(
      isBrandDominatedSerp({
        fieldSize: 17,
        exactBrandTitleCount: 9,
        rankOneExactBrandTitle: true,
        rankOneReviewShare: 0.001,
      }),
    ).toBe(false);
  });

  test("tolerates an empty field without dividing by zero", () => {
    expect(
      isBrandDominatedSerp({
        fieldSize: 0,
        exactBrandTitleCount: 0,
        rankOneExactBrandTitle: false,
        rankOneReviewShare: 0,
      }),
    ).toBe(false);
  });
});

describe("decideRetirement — protected sources", () => {
  for (const source of ["manual", "seed"]) {
    test(`never retires source='${source}', even when every enabled rule would fire`, () => {
      const decision = decideRetirement(
        candidate({
          keyword: "тест",
          source,
          serp: brandSerp(),
        }),
        { ...DEFAULT_RETIREMENT_RULES, scoreBased: true, autocompleteProbedAbsent: true },
        new Set(["тест"]),
      );
      expect(decision).toBeNull();
    });
  }
});

describe("decideRetirement — structural junk (score-independent)", () => {
  test("retires a non-Latin-script keyword", () => {
    expect(decideRetirement(candidate({ keyword: "التحفة" }), DEFAULT_RETIREMENT_RULES, NO_BRAND_SEGMENTS)).toBe(
      "structural-junk",
    );
  });

  test("retires a sole generic stoplist word", () => {
    expect(decideRetirement(candidate({ keyword: "app" }), DEFAULT_RETIREMENT_RULES, NO_BRAND_SEGMENTS)).toBe(
      "structural-junk",
    );
  });

  test("does not retire a real multi-word keyword", () => {
    expect(
      decideRetirement(candidate({ keyword: "budget planner" }), DEFAULT_RETIREMENT_RULES, NO_BRAND_SEGMENTS),
    ).toBeNull();
  });

  test("respects the rule toggle", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, structuralJunk: false };
    expect(decideRetirement(candidate({ keyword: "التحفة" }), rules, NO_BRAND_SEGMENTS)).toBeNull();
  });
});

describe("decideRetirement — lexical brand shape (score-independent)", () => {
  test("retires a keyword that is itself a full 'Brand: description' app title", () => {
    expect(
      decideRetirement(
        candidate({ keyword: "duolingo: language lessons" }),
        DEFAULT_RETIREMENT_RULES,
        NO_BRAND_SEGMENTS,
      ),
    ).toBe("brand-lexical");
  });

  test("retires a keyword that exactly matches a known brand segment", () => {
    expect(
      decideRetirement(candidate({ keyword: "duolingo" }), DEFAULT_RETIREMENT_RULES, new Set(["duolingo"])),
    ).toBe("brand-lexical");
  });

  test("does not retire a generic phrase that merely CONTAINS a brand segment", () => {
    expect(
      decideRetirement(
        candidate({ keyword: "duolingo alternative for kids" }),
        DEFAULT_RETIREMENT_RULES,
        new Set(["duolingo"]),
      ),
    ).toBeNull();
  });

  test("respects the rule toggle", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, brandLexical: false };
    expect(decideRetirement(candidate({ keyword: "duolingo: language lessons" }), rules, NO_BRAND_SEGMENTS)).toBeNull();
  });
});

describe("decideRetirement — brand-dominated SERP shape (score-independent)", () => {
  test("retires a brand-dominated field regardless of demand or review count", () => {
    expect(
      decideRetirement(
        candidate({ keyword: "netgear", serp: brandSerp(), score: { demand: 99, topAppReviews: 900_000, scanCount: 9 } }),
        DEFAULT_RETIREMENT_RULES,
        NO_BRAND_SEGMENTS,
      ),
    ).toBe("brand-serp-shape");
  });

  test("does not fire without SERP data", () => {
    expect(
      decideRetirement(candidate({ keyword: "netgear", serp: null }), DEFAULT_RETIREMENT_RULES, NO_BRAND_SEGMENTS),
    ).toBeNull();
  });

  test("respects the rule toggle", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, brandSerpShape: false };
    expect(decideRetirement(candidate({ keyword: "netgear", serp: brandSerp() }), rules, NO_BRAND_SEGMENTS)).toBeNull();
  });

  // The three niches the owner actually shipped, with their LIVE latest-US-scan
  // shapes (2026-07-25). None may ever be retired by an enabled rule — this is
  // the regression guard for the whole feature.
  const OWNER_NICHES: ReadonlyArray<readonly [string, RetirementSerpShape]> = [
    ["card grading", { fieldSize: 20, exactBrandTitleCount: 1, rankOneExactBrandTitle: false, rankOneReviewShare: 0.013 }],
    ["stock analysis", { fieldSize: 20, exactBrandTitleCount: 2, rankOneExactBrandTitle: true, rankOneReviewShare: 0.002 }],
    ["peptide tracker", { fieldSize: 20, exactBrandTitleCount: 4, rankOneExactBrandTitle: true, rankOneReviewShare: 0.027 }],
  ];

  for (const [keyword, serp] of OWNER_NICHES) {
    test(`does not retire the owner's own shipped niche "${keyword}"`, () => {
      expect(isBrandDominatedSerp(serp)).toBe(false);
      expect(
        decideRetirement(
          candidate({
            keyword,
            source: "autocomplete",
            serp,
            // Deliberately the exact profile the BROKEN score gives these
            // niches (near-zero demand, small incumbents): with the enabled
            // rules that must not matter at all.
            score: { demand: 0, topAppReviews: 10, scanCount: 5 },
          }),
          DEFAULT_RETIREMENT_RULES,
          NO_BRAND_SEGMENTS,
        ),
      ).toBeNull();
    });
  }
});

describe("decideRetirement — autocomplete tri-state (reserved, disabled by default)", () => {
  test("does not fire while disabled, even on 'probed-absent'", () => {
    expect(
      decideRetirement(
        candidate({ source: "autocomplete", autocompleteProbe: "probed-absent" }),
        DEFAULT_RETIREMENT_RULES,
        NO_BRAND_SEGMENTS,
      ),
    ).toBeNull();
  });

  test("fires on 'probed-absent' once enabled", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, autocompleteProbedAbsent: true };
    expect(
      decideRetirement(
        candidate({ source: "autocomplete", autocompleteProbe: "probed-absent" }),
        rules,
        NO_BRAND_SEGMENTS,
      ),
    ).toBe("autocomplete-probed-absent");
  });

  test("never fires on 'never-probed' — absence of a probe is not evidence", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, autocompleteProbedAbsent: true };
    expect(
      decideRetirement(
        candidate({ source: "autocomplete", autocompleteProbe: "never-probed" }),
        rules,
        NO_BRAND_SEGMENTS,
      ),
    ).toBeNull();
  });

  test("never fires on 'present'", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, autocompleteProbedAbsent: true };
    expect(
      decideRetirement(candidate({ source: "autocomplete", autocompleteProbe: "present" }), rules, NO_BRAND_SEGMENTS),
    ).toBeNull();
  });

  test("only applies to autocomplete-sourced keywords", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, autocompleteProbedAbsent: true };
    expect(
      decideRetirement(
        candidate({ source: "mined", autocompleteProbe: "probed-absent" }),
        rules,
        NO_BRAND_SEGMENTS,
      ),
    ).toBeNull();
  });
});

describe("shouldRetireByScore — the DISABLED score-based rule", () => {
  test("would retire the owner's own shipped niches — the reason it ships off", () => {
    // `card grading`: demand ~0, biggest incumbent well under 1000 reviews.
    expect(shouldRetireByScore({ demand: 0, topAppReviews: 120, scanCount: 5 })).toBe(true);
    // `shorts blocker`: same shape.
    expect(shouldRetireByScore({ demand: 0, topAppReviews: 40, scanCount: 5 })).toBe(true);
  });

  test("is never consulted under DEFAULT_RETIREMENT_RULES", () => {
    expect(
      decideRetirement(
        candidate({ keyword: "card grading", score: { demand: 0, topAppReviews: 120, scanCount: 5 } }),
        DEFAULT_RETIREMENT_RULES,
        NO_BRAND_SEGMENTS,
      ),
    ).toBeNull();
  });

  test("needs a minimum scan count even when explicitly enabled", () => {
    expect(shouldRetireByScore({ demand: 0, topAppReviews: 0, scanCount: 1 })).toBe(false);
  });

  test("fires through decideRetirement only when explicitly enabled", () => {
    const rules: RetirementRules = { ...DEFAULT_RETIREMENT_RULES, scoreBased: true };
    expect(
      decideRetirement(
        candidate({ keyword: "some phrase", score: { demand: 0, topAppReviews: 120, scanCount: 5 } }),
        rules,
        NO_BRAND_SEGMENTS,
      ),
    ).toBe("score-based");
  });
});

describe("decideRetirement — reason precedence", () => {
  test("structural junk wins over brand rules (cheapest, most certain signal first)", () => {
    expect(
      decideRetirement(
        candidate({ keyword: "التحفة", serp: brandSerp() }),
        DEFAULT_RETIREMENT_RULES,
        new Set(["التحفة"]),
      ),
    ).toBe("structural-junk");
  });

  test("lexical brand wins over SERP shape", () => {
    expect(
      decideRetirement(
        candidate({ keyword: "netgear", serp: brandSerp() }),
        DEFAULT_RETIREMENT_RULES,
        new Set(["netgear"]),
      ),
    ).toBe("brand-lexical");
  });
});

// ---------------------------------------------------------------------------
// Brand-FAMILY resistance
// ---------------------------------------------------------------------------

describe("tokenPrefixes", () => {
  test("returns every whitespace-token prefix, shortest first, including the whole keyword", () => {
    expect(tokenPrefixes("spotify premium apk")).toEqual(["spotify", "spotify premium", "spotify premium apk"]);
  });

  test("normalizes case and collapses whitespace", () => {
    expect(tokenPrefixes("  Spotify   Premium ")).toEqual(["spotify", "spotify premium"]);
  });

  test("a single token is its own only prefix", () => {
    expect(tokenPrefixes("spotify")).toEqual(["spotify"]);
  });

  test("empty input yields no prefixes", () => {
    expect(tokenPrefixes("   ")).toEqual([]);
  });
});

describe("isFamilyRootEligible", () => {
  test("a short brand-retired keyword becomes a family root", () => {
    expect(isFamilyRootEligible("spotify", "brand-lexical")).toBe(true);
    expect(isFamilyRootEligible("google maps", "brand-serp-shape")).toBe(true);
  });

  test("a non-brand retirement reason never seeds a family root", () => {
    // Retiring junk or a weak score says nothing about the keyword's whole
    // token family — only brand-ness generalizes.
    expect(isFamilyRootEligible("spotify", "structural-junk")).toBe(false);
    expect(isFamilyRootEligible("spotify", "score-based")).toBe(false);
    expect(isFamilyRootEligible("spotify", "autocomplete-probed-absent")).toBe(false);
  });

  test("a long phrase never becomes a family root (over-broad blocking guard)", () => {
    expect(isFamilyRootEligible("budget planner for couples", "brand-lexical")).toBe(false);
  });

  test(`the token ceiling is ${FAMILY_ROOT_MAX_TOKENS}`, () => {
    expect(isFamilyRootEligible("a b", "brand-lexical")).toBe(true);
    expect(isFamilyRootEligible("a b c", "brand-lexical")).toBe(false);
  });

  test("FAMILY_BLOCKING_REASONS is exactly the two brand reasons", () => {
    expect([...FAMILY_BLOCKING_REASONS].sort()).toEqual(["brand-lexical", "brand-serp-shape"]);
  });
});

describe("isFamilyBlocked", () => {
  const roots: ReadonlySet<string> = new Set(["spotify", "google maps"]);

  test("blocks the retired root itself", () => {
    expect(isFamilyBlocked("spotify", roots)).toBe(true);
  });

  test("blocks a descendant of a retired brand root", () => {
    expect(isFamilyBlocked("spotify premium", roots)).toBe(true);
    expect(isFamilyBlocked("spotify premium apk", roots)).toBe(true);
    expect(isFamilyBlocked("google maps offline", roots)).toBe(true);
  });

  test("blocks case/whitespace variants", () => {
    expect(isFamilyBlocked("  Spotify   Premium ", roots)).toBe(true);
  });

  test("does NOT block on a mid-phrase or suffix occurrence — only a token PREFIX generalizes", () => {
    expect(isFamilyBlocked("best spotify alternative", roots)).toBe(false);
    expect(isFamilyBlocked("offline google maps", roots)).toBe(false);
  });

  test("does NOT block a keyword that merely shares a leading substring", () => {
    expect(isFamilyBlocked("spotifysomething", roots)).toBe(false);
    expect(isFamilyBlocked("google mapsy", roots)).toBe(false);
  });

  test("does NOT block a partial root match (both root tokens are required)", () => {
    expect(isFamilyBlocked("google photos", roots)).toBe(false);
  });

  test("an empty root set blocks nothing", () => {
    expect(isFamilyBlocked("spotify premium", new Set())).toBe(false);
  });
});
