import { describe, expect, test } from "bun:test";
import { DEFAULT_ZONE, mapCategoryToZone } from "./keyword-miner";
import {
  STRICT_CATEGORY_TO_ZONE,
  ZONE_MIN_CONFIDENCE,
  ZONE_MIN_INCUMBENTS,
  deriveGenreZone,
  mapCategoryToZoneStrict,
} from "./keyword-zones";

describe("mapCategoryToZoneStrict", () => {
  test("maps a known category the same way the corpus already does", () => {
    expect(mapCategoryToZoneStrict("Health & Fitness")).toBe("health");
    expect(mapCategoryToZoneStrict("photo & video")).toBe("photo");
    expect(mapCategoryToZoneStrict("  Finance  ")).toBe("finance");
  });

  test("returns null for an unknown category instead of a default zone", () => {
    // THE bug this module exists to fix: `mapCategoryToZone` answers
    // 'lifestyle' here, which is a fiction indistinguishable from a real
    // Lifestyle app.
    expect(mapCategoryToZone("Weather")).toBe(DEFAULT_ZONE);
    expect(mapCategoryToZoneStrict("Weather")).toBeNull();
    expect(mapCategoryToZoneStrict("Navigation")).toBeNull();
    expect(mapCategoryToZoneStrict("Developer Tools")).toBeNull();
  });

  test("returns null for empty/whitespace input", () => {
    expect(mapCategoryToZoneStrict("")).toBeNull();
    expect(mapCategoryToZoneStrict("   ")).toBeNull();
  });

  test("still maps the categories that legitimately ARE lifestyle", () => {
    expect(mapCategoryToZoneStrict("Lifestyle")).toBe("lifestyle");
    expect(mapCategoryToZoneStrict("Shopping")).toBe("lifestyle");
  });

  // Drift guard: this module keeps its own STRICT table (it must stay free of
  // `keyword-miner.ts`'s transitive `./keyword-store` imports — see the module
  // doc comment). This test is what keeps the two in lockstep.
  test("agrees with keyword-miner's mapCategoryToZone on every category it knows", () => {
    for (const [category, zone] of Object.entries(STRICT_CATEGORY_TO_ZONE)) {
      expect(mapCategoryToZone(category)).toBe(zone);
    }
  });
});

describe("deriveGenreZone", () => {
  /** `n` copies of `category` — the incumbents' raw genre labels. */
  function times(category: string, n: number): string[] {
    return Array.from({ length: n }, () => category);
  }

  test("derives the mode zone with its share as confidence", () => {
    const derived = deriveGenreZone([...times("Finance", 3), ...times("Business", 1)]);
    expect(derived).toEqual({ zone: "finance", confidence: 0.75, incumbentCount: 4 });
  });

  test("collapses distinct categories that map to the same zone", () => {
    // Games + Entertainment both map to 'entertainment' — 4/4 agreement.
    const derived = deriveGenreZone([...times("Games", 2), ...times("Entertainment", 2)]);
    expect(derived).toEqual({ zone: "entertainment", confidence: 1, incumbentCount: 4 });
  });

  test("returns NULL — never a default string — when there are no incumbents", () => {
    expect(deriveGenreZone([])).toBeNull();
  });

  test("returns NULL when no incumbent carries a genre", () => {
    expect(deriveGenreZone([null, undefined, "", "   "])).toBeNull();
  });

  test("returns NULL when every genre is unmappable, rather than defaulting", () => {
    expect(deriveGenreZone(times("Weather", 8))).toBeNull();
  });

  test("ignores unmappable genres when computing the share (they are not evidence either way)", () => {
    // 3 Finance + 5 Weather -> 3/3 resolvable agree on finance.
    const derived = deriveGenreZone([...times("Finance", 3), ...times("Weather", 5)]);
    expect(derived).toEqual({ zone: "finance", confidence: 1, incumbentCount: 3 });
  });

  test(`returns NULL below ZONE_MIN_INCUMBENTS (${ZONE_MIN_INCUMBENTS}) resolvable incumbents`, () => {
    expect(deriveGenreZone(times("Finance", ZONE_MIN_INCUMBENTS - 1))).toBeNull();
    expect(deriveGenreZone(times("Finance", ZONE_MIN_INCUMBENTS))).not.toBeNull();
  });

  test(`returns NULL below ZONE_MIN_CONFIDENCE (${ZONE_MIN_CONFIDENCE})`, () => {
    // 2 finance / 2 health / 2 travel / 2 sports -> mode share 0.25.
    const derived = deriveGenreZone([
      ...times("Finance", 2),
      ...times("Medical", 2),
      ...times("Travel", 2),
      ...times("Sports", 2),
    ]);
    expect(derived).toBeNull();
  });

  test("accepts a bare majority exactly at the threshold", () => {
    const derived = deriveGenreZone([...times("Finance", 4), ...times("Travel", 4)]);
    expect(derived).toEqual({ zone: "finance", confidence: 0.5, incumbentCount: 8 });
  });

  test("breaks ties deterministically by zone name, not by input order", () => {
    const a = deriveGenreZone([...times("Travel", 4), ...times("Finance", 4)]);
    const b = deriveGenreZone([...times("Finance", 4), ...times("Travel", 4)]);
    expect(a).toEqual(b);
    expect(a?.zone).toBe("finance");
  });

  test("is case- and whitespace-insensitive on the raw genre labels", () => {
    const derived = deriveGenreZone(["  HEALTH & FITNESS ", "health & fitness", "Medical"]);
    expect(derived).toEqual({ zone: "health", confidence: 1, incumbentCount: 3 });
  });

  test("never mutates its input", () => {
    const input = ["Finance", "Finance", "Travel"];
    const snapshot = [...input];
    deriveGenreZone(input);
    expect(input).toEqual(snapshot);
  });

  test("a genuinely lifestyle field still derives lifestyle", () => {
    // The point is not "lifestyle is always wrong" — it is that lifestyle must
    // be EARNED from real categories rather than defaulted into.
    const derived = deriveGenreZone([...times("Lifestyle", 3), ...times("Shopping", 2)]);
    expect(derived).toEqual({ zone: "lifestyle", confidence: 1, incumbentCount: 5 });
  });
});
