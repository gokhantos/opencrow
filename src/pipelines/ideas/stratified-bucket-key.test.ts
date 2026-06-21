import { describe, expect, it } from "bun:test";
import { selectStratified, stratifiedBucketKey } from "./collector-ranking";

// ── stratifiedBucketKey ──────────────────────────────────────────────────────
//
// Theme-Stratified Intake (Component 3). Pure, table-driven derivation of the
// stratified bucket key from a candidate's (table, signalType, category) and the
// `bucketBy` flag. See docs/.../2026-06-21-theme-stratified-intake-design.md §5.

describe("stratifiedBucketKey — bucketBy: signalCategory (hybrid, default)", () => {
  it("enriched row buckets on `${category}:${table}`", () => {
    expect(
      stratifiedBucketKey(
        { table: "reddit_posts", signalType: "topical", category: "fintech" },
        "signalCategory",
      ),
    ).toBe("fintech:reddit_posts");
  });

  it('un-enriched ("unknown") row falls back to `${signalType}:${table}`', () => {
    expect(
      stratifiedBucketKey(
        { table: "reddit_posts", signalType: "topical", category: "unknown" },
        "signalCategory",
      ),
    ).toBe("topical:reddit_posts");
  });

  it("empty-string category falls back to signalType", () => {
    expect(
      stratifiedBucketKey(
        { table: "github_repos", signalType: "trending", category: "" },
        "signalCategory",
      ),
    ).toBe("trending:github_repos");
  });

  it("null/undefined category falls back to signalType", () => {
    expect(
      stratifiedBucketKey(
        {
          table: "hn_stories",
          signalType: "front-page",
          category: undefined as unknown as string,
        },
        "signalCategory",
      ),
    ).toBe("front-page:hn_stories");
  });

  it("distinct categories on the same table yield distinct buckets", () => {
    const a = stratifiedBucketKey(
      { table: "news_articles", signalType: "reuters", category: "fintech" },
      "signalCategory",
    );
    const b = stratifiedBucketKey(
      { table: "news_articles", signalType: "reuters", category: "healthcare" },
      "signalCategory",
    );
    expect(a).not.toBe(b);
  });
});

describe("stratifiedBucketKey — bucketBy: signalType (legacy)", () => {
  it("legacy key is `${table}:${signalType}` regardless of category", () => {
    expect(
      stratifiedBucketKey(
        { table: "reddit_posts", signalType: "topical", category: "fintech" },
        "signalType",
      ),
    ).toBe("reddit_posts:topical");
  });

  it("legacy key ignores category even when un-enriched", () => {
    expect(
      stratifiedBucketKey(
        { table: "x_scraped_tweets", signalType: "verified", category: "unknown" },
        "signalType",
      ),
    ).toBe("x_scraped_tweets:verified");
  });
});

// ── spread property: hybrid theme bucketing vs legacy source bucketing ────────
//
// Verifies the end goal of Component 3: with selectStratified's perBucketCap,
// the hybrid key spreads a single hot source across its THEMES, whereas the
// legacy key collapses them into one (table:signalType) bucket capped flat.

describe("stratifiedBucketKey × selectStratified — theme spread", () => {
  // 24 same-source rows (all reddit_posts / signalType "topical") across 4
  // distinct enriched themes, 6 rows each.
  const themes = ["fintech", "devtools", "healthcare", "consumer-social"];
  const rows = Array.from({ length: 24 }, (_, i) => ({
    id: `r${i}`,
    table: "reddit_posts",
    signalType: "topical",
    category: themes[i % themes.length] as string,
  }));

  it("hybrid (signalCategory) keys spread one source across 4 theme buckets", () => {
    const hybridKeys = new Set(rows.map((r) => stratifiedBucketKey(r, "signalCategory")));
    expect(hybridKeys.size).toBe(4);
    expect([...hybridKeys].sort()).toEqual([
      "consumer-social:reddit_posts",
      "devtools:reddit_posts",
      "fintech:reddit_posts",
      "healthcare:reddit_posts",
    ]);
  });

  it("legacy (signalType) keys collapse the same rows into ONE source bucket", () => {
    const legacyKeys = new Set(rows.map((r) => stratifiedBucketKey(r, "signalType")));
    expect(legacyKeys.size).toBe(1);
    expect([...legacyKeys]).toEqual(["reddit_posts:topical"]);
  });

  it("with totalCap = 4 theme buckets × cap, hybrid fills every theme evenly", () => {
    // totalCap exactly equals the Phase-1 round-robin ceiling (2 × 4), so the
    // anti-starvation backfill is a no-op and the cap is observable: 2 rows from
    // EACH of the 4 themes, never 8 from a single hot theme.
    const { selected } = selectStratified(rows, {
      idOf: (r) => r.id,
      bucketOf: (r) => stratifiedBucketKey(r, "signalCategory"),
      scoreOf: () => 1,
      perBucketCap: 2,
      totalCap: 8,
    });
    expect(selected.length).toBe(8);
    const perTheme = new Map<string, number>();
    for (const r of selected) perTheme.set(r.category, (perTheme.get(r.category) ?? 0) + 1);
    expect([...perTheme.values()].every((n) => n === 2)).toBe(true);
    expect(perTheme.size).toBe(4);
  });
});
