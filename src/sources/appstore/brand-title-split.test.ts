import { describe, expect, it } from "bun:test";
import { extractBrandPrefix, hasBrandSeparator, stripBrandPrefix } from "./brand-title-split";

describe("stripBrandPrefix", () => {
  it("strips a leading 'Brand:' prefix", () => {
    expect(stripBrandPrefix("MyFitnessPal: Calorie Counter")).toBe("Calorie Counter");
  });

  it("strips a leading 'Brand - ' prefix", () => {
    expect(stripBrandPrefix("Egg Timer - Boiled Eggs")).toBe("Boiled Eggs");
  });

  it("returns the name unchanged when there is no separator", () => {
    expect(stripBrandPrefix("Notion")).toBe("Notion");
  });

  it("returns the name unchanged when the suffix would be empty", () => {
    expect(stripBrandPrefix("Brand Name:")).toBe("Brand Name:");
  });
});

// Batch A budget rescue (2026-07-22) — consumed by keyword-brand.ts's
// insert-time brand-segment filter; see that module's own test suite for
// the combined-heuristic coverage.
describe("extractBrandPrefix", () => {
  it("returns the brand prefix before the earliest colon separator", () => {
    expect(extractBrandPrefix("MyFitnessPal: Calorie Counter")).toBe("MyFitnessPal");
  });

  it("returns the brand prefix before the earliest ' - ' separator", () => {
    expect(extractBrandPrefix("Egg Timer - Boiled Eggs")).toBe("Egg Timer");
  });

  it("uses the EARLIEST separator when multiple are present", () => {
    expect(extractBrandPrefix("Brand: Sub - Title")).toBe("Brand");
  });

  it("returns null when there is no separator", () => {
    expect(extractBrandPrefix("Notion")).toBeNull();
  });

  it("returns null when the prefix would be empty", () => {
    expect(extractBrandPrefix(": No Prefix Here")).toBeNull();
  });
});

describe("hasBrandSeparator", () => {
  it("is true for text containing a colon", () => {
    expect(hasBrandSeparator("duolingo: language lessons")).toBe(true);
  });

  it("is true for text containing a ' - ' or ' | '", () => {
    expect(hasBrandSeparator("egg timer - boiled eggs")).toBe(true);
    expect(hasBrandSeparator("app name | subtitle")).toBe(true);
  });

  it("is false for a bare multi-word phrase with no separator", () => {
    expect(hasBrandSeparator("budget planner")).toBe(false);
  });

  it("is false for a hyphenated word that is NOT a ' - ' separator (no surrounding spaces)", () => {
    expect(hasBrandSeparator("co-parenting app")).toBe(false);
  });
});
