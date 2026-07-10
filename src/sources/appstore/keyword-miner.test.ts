import { describe, expect, it } from "bun:test";
import { extractCandidates, extractCandidatesFromApp, mapCategoryToZone } from "./keyword-miner";
import type { MinerAppInput } from "./keyword-miner";

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
