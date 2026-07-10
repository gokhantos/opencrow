import { describe, expect, it } from "bun:test";
import {
  extractCandidates,
  extractCandidatesFromApp,
  mapCategoryToZone,
  selectNewCandidates,
} from "./keyword-miner";
import type { MinedCandidate, MinerAppInput } from "./keyword-miner";

function keywordsOf(app: MinerAppInput): readonly string[] {
  return extractCandidatesFromApp(app).map((c) => c.keyword);
}

describe("mapCategoryToZone", () => {
  it("maps known App Store categories to genre zones", () => {
    expect(mapCategoryToZone("Health & Fitness")).toBe("health");
    expect(mapCategoryToZone("Finance")).toBe("finance");
    expect(mapCategoryToZone("Social Networking")).toBe("social");
    expect(mapCategoryToZone("Food & Drink")).toBe("food");
    expect(mapCategoryToZone("Games")).toBe("entertainment");
    expect(mapCategoryToZone("Book")).toBe("reference");
  });

  it("is case/whitespace-insensitive", () => {
    expect(mapCategoryToZone("  health & fitness  ")).toBe("health");
    expect(mapCategoryToZone("FINANCE")).toBe("finance");
  });

  it("falls back to a default zone for unknown categories", () => {
    expect(mapCategoryToZone("Some Brand New Category")).toBe("lifestyle");
    expect(mapCategoryToZone("")).toBe("lifestyle");
  });
});

describe("extractCandidatesFromApp", () => {
  it("strips a colon-separated brand prefix and extracts the descriptive n-grams", () => {
    const keywords = keywordsOf({
      name: "MyFitnessPal: Calorie Counter",
      artist: "MyFitnessPal, Inc.",
      category: "Health & Fitness",
    });
    expect(keywords).toContain("calorie counter");
    expect(keywords).toContain("calorie");
    expect(keywords).toContain("counter");
    expect(keywords).not.toContain("myfitnesspal");
  });

  it("strips a dash-separated brand prefix", () => {
    const keywords = keywordsOf({
      name: "Duolingo - Learn Languages",
      artist: "Duolingo",
      category: "Education",
    });
    expect(keywords).toContain("learn languages");
    expect(keywords).not.toContain("duolingo");
  });

  it("assigns the genreZone via the app's category", () => {
    const candidates = extractCandidatesFromApp({
      name: "Acme: Budget Tracker",
      artist: "Acme Software",
      category: "Finance",
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.genreZone).toBe("finance");
  });

  it("strips punctuation and emoji", () => {
    const keywords = keywordsOf({
      name: "Sleep Cycle 😴: Smart Alarm Clock!!!",
      artist: "Northcube AB",
      category: "Health & Fitness",
    });
    expect(keywords).toContain("smart alarm");
    expect(keywords).toContain("alarm clock");
    expect(keywords.some((k) => /[^a-z0-9\s]/.test(k))).toBe(false);
  });

  it("drops pure-number and too-short tokens", () => {
    const keywords = keywordsOf({
      name: "Acme: Workout 2024 AI Go",
      artist: "Acme Software",
      category: "Health & Fitness",
    });
    expect(keywords).not.toContain("2024");
    expect(keywords).not.toContain("ai"); // 2 chars, below MIN_TOKEN_LENGTH
    expect(keywords).toContain("workout");
  });

  it("drops stopwords from the token stream", () => {
    const keywords = keywordsOf({
      name: "Acme: Notes for Students",
      artist: "Acme Software",
      category: "Education",
    });
    expect(keywords.every((k) => !k.split(" ").includes("for"))).toBe(true);
    expect(keywords).toContain("notes");
    expect(keywords).toContain("students");
  });

  it("drops tokens that match the app's own developer/artist name (brand filter)", () => {
    const keywords = keywordsOf({
      name: "Notion",
      artist: "Notion Labs, Inc.",
      category: "Productivity",
    });
    expect(keywords).toEqual([]);
  });

  it("returns no candidates for an empty app name", () => {
    expect(
      extractCandidatesFromApp({ name: "", artist: "Someone", category: "Finance" }),
    ).toEqual([]);
  });

  it("dedupes n-grams within a single app", () => {
    const keywords = keywordsOf({
      name: "Acme: Budget Budget Tracker",
      artist: "Acme Software",
      category: "Finance",
    });
    expect(keywords.filter((k) => k === "budget").length).toBe(1);
  });
});

describe("extractCandidates", () => {
  it("dedupes across a batch, first app wins the genreZone", () => {
    const candidates = extractCandidates([
      { name: "Acme: Budget Tracker", artist: "Acme", category: "Finance" },
      { name: "Zeta: Budget Tracker", artist: "Zeta", category: "Business" },
    ]);
    const budgetTracker = candidates.find((c) => c.keyword === "budget tracker");
    expect(budgetTracker).toBeDefined();
    expect(budgetTracker?.genreZone).toBe("finance");
    // Only counted once despite appearing in both apps.
    expect(candidates.filter((c) => c.keyword === "budget tracker").length).toBe(1);
  });

  it("returns an empty list for an empty batch", () => {
    expect(extractCandidates([])).toEqual([]);
  });

  it("combines candidates from multiple apps", () => {
    const candidates = extractCandidates([
      { name: "Acme: Budget Tracker", artist: "Acme", category: "Finance" },
      { name: "Zeta: Sleep Analysis", artist: "Zeta", category: "Health & Fitness" },
    ]);
    const keywords = candidates.map((c) => c.keyword);
    expect(keywords).toContain("budget tracker");
    expect(keywords).toContain("sleep analysis");
  });
});

// Coverage for mining from the broader `top_apps` scan pool
// (`keyword-store.ts` `getScannedAppNames`) alongside the existing rankings
// pool. That source has no artist/category — callers map it to
// `{ name, artist: "", category: "" }` before calling into the same pure
// extraction pipeline exercised above, so these tests just confirm that
// shape of input behaves as expected (name-only path, default zone) and
// blends/dedupes correctly against rankings-sourced candidates.
describe("extraction from top_apps-style (name-only) app input", () => {
  it("produces candidates from a bare app name with no artist or category", () => {
    const keywords = keywordsOf({
      name: "Wobblesnizzle Gadget Helper",
      artist: "",
      category: "",
    });
    expect(keywords).toContain("wobblesnizzle");
    expect(keywords).toContain("wobblesnizzle gadget");
    expect(keywords).toContain("gadget helper");
    expect(keywords).toContain("helper");
  });

  it("falls back to the default genre zone since there is no category to map", () => {
    const candidates = extractCandidatesFromApp({
      name: "Some New Gadget App",
      artist: "",
      category: "",
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.genreZone).toBe("lifestyle");
  });

  it("still strips a brand-separator prefix even with no artist to filter against", () => {
    const keywords = keywordsOf({
      name: "Zzzscannedbrand: Wobblesnizzle Tracker",
      artist: "",
      category: "",
    });
    expect(keywords).toContain("wobblesnizzle tracker");
    expect(keywords).not.toContain("zzzscannedbrand");
  });

  it("dedupes a keyword found via both the rankings source and the top_apps source", () => {
    // Same descriptive keyword surfaces from a "real" ranking app (with
    // artist/category) and a bare top_apps-style name — extractCandidates
    // treats them as one combined batch (mirroring how mineKeywords blends
    // both sources) and the FIRST app in the batch wins the genreZone.
    const candidates = extractCandidates([
      { name: "Acme: Budget Tracker", artist: "Acme", category: "Finance" },
      { name: "Budget Tracker", artist: "", category: "" },
    ]);
    const matches = candidates.filter((c) => c.keyword === "budget tracker");
    expect(matches).toHaveLength(1);
    // Rankings source came first in the batch, so its real "finance" zone
    // wins over the top_apps-derived entry's default "lifestyle" fallback.
    expect(matches[0]?.genreZone).toBe("finance");
  });
});

describe("selectNewCandidates", () => {
  function candidate(keyword: string, genreZone = "lifestyle"): MinedCandidate {
    return { keyword, genreZone };
  }

  it("drops candidates already present in the existing set", () => {
    const result = selectNewCandidates(
      [candidate("alpha"), candidate("beta"), candidate("gamma")],
      new Set(["beta"]),
      10,
    );
    expect(result.map((c) => c.keyword)).toEqual(["alpha", "gamma"]);
  });

  it("caps the result at maxNew, preserving order", () => {
    const result = selectNewCandidates(
      [candidate("alpha"), candidate("beta"), candidate("gamma"), candidate("delta")],
      new Set(),
      2,
    );
    expect(result.map((c) => c.keyword)).toEqual(["alpha", "beta"]);
  });

  it("returns an empty list when maxNew is 0", () => {
    const result = selectNewCandidates([candidate("alpha")], new Set(), 0);
    expect(result).toEqual([]);
  });

  it("returns an empty list when every candidate already exists", () => {
    const result = selectNewCandidates(
      [candidate("alpha"), candidate("beta")],
      new Set(["alpha", "beta"]),
      10,
    );
    expect(result).toEqual([]);
  });
});
