// Pure unit coverage for `toTopApp`'s title-matching (2026-07-21 audit item C
// fix: token-boundary matching replaces the old substring-anywhere check).
// No mocking needed — `toTopApp` is a pure mapping function over already-parsed
// iTunes payload shapes.

import { describe, expect, it } from "bun:test";
import { toTopApp } from "./keyword-gaps";
import type { ItunesSoftwareResult } from "./keyword-gaps";

const NOW = Math.floor(Date.now() / 1000);

function itunesResult(overrides: Partial<ItunesSoftwareResult> = {}): ItunesSoftwareResult {
  return {
    trackId: 1,
    trackName: "Sample App",
    userRatingCount: 100,
    averageUserRating: 4.0,
    releaseDate: "2020-01-01T00:00:00Z",
    currentVersionReleaseDate: "2026-01-01T00:00:00Z",
    price: 0,
    formattedPrice: "Free",
    ...overrides,
  };
}

describe("toTopApp titleMatch — token-boundary matching (2026-07-21 audit item C fix)", () => {
  // The three named false-positive examples from the audit: each keyword IS
  // a raw substring of the app name at some position, but not at a word
  // boundary — the old `String.includes` check matched all three; none
  // should match under token-boundary matching.
  it('"hat" does NOT title-match "ChatGPT"', () => {
    const app = toTopApp(itunesResult({ trackName: "ChatGPT" }), "hat", NOW);
    expect(app.titleMatch).toBe(false);
  });

  it('"face" does NOT title-match "Facebook"', () => {
    const app = toTopApp(itunesResult({ trackName: "Facebook" }), "face", NOW);
    expect(app.titleMatch).toBe(false);
  });

  it('"tub" does NOT title-match "YouTube"', () => {
    const app = toTopApp(itunesResult({ trackName: "YouTube" }), "tub", NOW);
    expect(app.titleMatch).toBe(false);
  });

  it('"widget" DOES title-match "Widgets" (plural/inflection tolerance)', () => {
    const app = toTopApp(itunesResult({ trackName: "Widgets by Acme" }), "widget", NOW);
    expect(app.titleMatch).toBe(true);
  });

  it("matches an exact multi-word keyword against a punctuated/multi-word name", () => {
    const app = toTopApp(
      itunesResult({ trackName: "Block Shorts: Video Editor" }),
      "block shorts",
      NOW,
    );
    expect(app.titleMatch).toBe(true);
  });

  it("requires EVERY keyword token to match — a partial multi-word match is not a title match", () => {
    const app = toTopApp(itunesResult({ trackName: "Budget Tracker" }), "budget planner", NOW);
    expect(app.titleMatch).toBe(false);
  });

  it("does not title-match when the keyword is empty", () => {
    const app = toTopApp(itunesResult({ trackName: "Budget Planner" }), "", NOW);
    expect(app.titleMatch).toBe(false);
  });

  it("matches case-insensitively", () => {
    const app = toTopApp(itunesResult({ trackName: "BUDGET PLANNER" }), "Budget Planner", NOW);
    expect(app.titleMatch).toBe(true);
  });

  it("treats punctuation as a token boundary on the name side (e.g. a colon-separated subtitle)", () => {
    const app = toTopApp(
      itunesResult({ trackName: "CardGrading: Numista Companion" }),
      "numista",
      NOW,
    );
    expect(app.titleMatch).toBe(true);
  });

  it("a short (<4 char) keyword token never prefix-matches, even a genuine prefix", () => {
    // "hat" IS a structural prefix of "hatchback" (4+ char remainder), but
    // MIN_PREFIX_MATCH_LEN (4) blocks prefix-matching for keyword tokens
    // shorter than that regardless.
    const app = toTopApp(itunesResult({ trackName: "Hatchback Finder" }), "hat", NOW);
    expect(app.titleMatch).toBe(false);
  });

  it("a >=4 char keyword token does not prefix-match a name token with a long unmatched remainder", () => {
    // "card" is 4 chars and IS a prefix of "cardiology", but the unmatched
    // remainder ("iology", 6 chars) is far longer than a plural/inflection
    // suffix — MAX_INFLECTION_SUFFIX_CHARS bounds this.
    const app = toTopApp(itunesResult({ trackName: "Cardiology Notes" }), "card", NOW);
    expect(app.titleMatch).toBe(false);
  });
});
