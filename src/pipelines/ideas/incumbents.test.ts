import { test, expect, describe } from "bun:test";
import {
  normalizeName,
  incumbentMatchKeys,
  buildIncumbentSet,
  mentionsIncumbent,
  MIN_INCUMBENT_NAME_LENGTH,
} from "./incumbents";

describe("normalizeName", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeName("DoorDash - Food Delivery")).toBe("doordash food delivery");
    expect(normalizeName("Uber!")).toBe("uber");
    expect(normalizeName("  Spotify:  Music  ")).toBe("spotify music");
  });

  test("handles null / undefined / non-strings", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
  });

  test("strips diacritics and symbols to spaces", () => {
    expect(normalizeName("Café—Pro™")).toContain("cafe");
  });
});

describe("incumbentMatchKeys", () => {
  test("indexes the first token and the first-two-token prefix", () => {
    const keys = incumbentMatchKeys("google maps navigation");
    expect(keys).toContain("google");
    expect(keys).toContain("google maps");
  });

  test("drops trivially-short first tokens", () => {
    // "x" is below the min length → no key produced from it.
    expect(incumbentMatchKeys("x")).toEqual([]);
  });

  test("single-word brand yields just the word", () => {
    expect(incumbentMatchKeys("doordash")).toEqual(["doordash"]);
  });
});

describe("buildIncumbentSet", () => {
  test("builds a normalized match set, dropping short / empty names", () => {
    const set = buildIncumbentSet(["DoorDash - Food Delivery", "Uber", "x", null, ""]);
    expect(set.has("doordash")).toBe(true);
    expect(set.has("uber")).toBe(true);
    // "x" is too short to ever enter the set.
    expect(set.has("x")).toBe(false);
  });
});

describe("mentionsIncumbent", () => {
  const set = buildIncumbentSet(["DoorDash", "Uber", "Google Maps"]);

  test("matches a prominently-named incumbent (whole word)", () => {
    expect(mentionsIncumbent("A better alternative to DoorDash for rural areas", set)).toBe(true);
    expect(mentionsIncumbent("competes with Uber on price", set)).toBe(true);
  });

  test("matches a multi-word incumbent name", () => {
    expect(mentionsIncumbent("an offline-first rival to Google Maps", set)).toBe(true);
  });

  test("does NOT match a substring of a larger word (word boundary)", () => {
    // "uber" must not match inside "exuberant".
    expect(mentionsIncumbent("an exuberant productivity tool", set)).toBe(false);
  });

  test("does not match when no incumbent is named", () => {
    expect(mentionsIncumbent("a CLI for managing dotfiles", set)).toBe(false);
  });

  test("empty incumbent set never matches", () => {
    expect(mentionsIncumbent("DoorDash clone", new Set<string>())).toBe(false);
  });

  test("guards against trivially-short text", () => {
    expect(mentionsIncumbent("x", set)).toBe(false);
  });

  test("MIN_INCUMBENT_NAME_LENGTH guard is enforced", () => {
    // A 2-char brand cannot enter the set, so it cannot match.
    const shortSet = buildIncumbentSet(["Hi"]);
    expect(shortSet.size).toBe(0);
    expect(MIN_INCUMBENT_NAME_LENGTH).toBeGreaterThanOrEqual(3);
  });
});
