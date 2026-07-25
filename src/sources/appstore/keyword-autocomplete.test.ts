import { describe, expect, it } from "bun:test";
import {
  buildCandidatesFromHints,
  buildPrefixFanOutWindow,
  buildProbeWrite,
  findSelfRank,
  parseHintTerms,
} from "./keyword-autocomplete";

// Fixture modeled on the real Apple MZSearchHints plist-XML response body,
// captured live 2026-07-20/21 WITH the `X-Apple-Store-Front` header (see
// module doc in keyword-autocomplete.ts): an <array> of <dict> entries, each
// carrying a <key>term</key><string>PHRASE</string> pair alongside other
// keys (here just `kind`, but production responses may carry more — the
// parser only looks for the `term` key/string pair, so extra keys are
// harmless noise). Suggestion order is Apple's own popularity ranking.
const REAL_HINTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>kind</key>
		<string>term</string>
		<key>term</key>
		<string>budget</string>
	</dict>
	<dict>
		<key>kind</key>
		<string>term</string>
		<key>term</key>
		<string>budget &#8211; car rental</string>
	</dict>
	<dict>
		<key>kind</key>
		<string>term</string>
		<key>term</key>
		<string>budget app</string>
	</dict>
	<dict>
		<key>kind</key>
		<string>term</string>
		<key>term</key>
		<string>budget planner</string>
	</dict>
	<dict>
		<key>kind</key>
		<string>term</string>
		<key>term</key>
		<string>budget bestie</string>
	</dict>
</array>
</plist>
`;

// This is the shape returned WITHOUT the storefront header (the response
// that caused the 2026-07-18 "autocomplete is dead" misdiagnosis) — a
// syntactically valid plist wrapping an empty array. Must not be confused
// with a parse failure.
const EMPTY_HINTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
</array>
</plist>
`;

describe("parseHintTerms", () => {
  it("extracts terms in document order (Apple's popularity ranking)", () => {
    expect(parseHintTerms(REAL_HINTS_PLIST)).toEqual([
      "budget",
      "budget – car rental",
      "budget app",
      "budget planner",
      "budget bestie",
    ]);
  });

  it("returns an empty array for a well-formed but empty hints array", () => {
    expect(parseHintTerms(EMPTY_HINTS_PLIST)).toEqual([]);
  });

  it("returns an empty array for malformed/garbage input instead of throwing", () => {
    expect(parseHintTerms("not xml at all")).toEqual([]);
    expect(parseHintTerms("")).toEqual([]);
    expect(parseHintTerms("<html><body>404</body></html>")).toEqual([]);
  });

  it("decodes named XML entities", () => {
    const body = `<array><dict><key>term</key><string>tom &amp; jerry</string></dict></array>`;
    expect(parseHintTerms(body)).toEqual(["tom & jerry"]);
  });

  it("decodes decimal numeric character references", () => {
    const body = `<array><dict><key>term</key><string>budget&#8211;car rental</string></dict></array>`;
    expect(parseHintTerms(body)).toEqual(["budget–car rental"]);
  });

  it("decodes hex numeric character references", () => {
    const body = `<array><dict><key>term</key><string>budget&#x2013;car rental</string></dict></array>`;
    expect(parseHintTerms(body)).toEqual(["budget–car rental"]);
  });

  it("leaves an out-of-range numeric entity as-is instead of throwing (security hardening)", () => {
    // String.fromCodePoint throws RangeError above U+10FFFF — must degrade
    // to leaving the literal entity text in place, never crash the parser.
    const hex = `<array><dict><key>term</key><string>budget&#x110000;planner</string></dict></array>`;
    expect(() => parseHintTerms(hex)).not.toThrow();
    expect(parseHintTerms(hex)).toEqual(["budget&#x110000;planner"]);

    const decimal = `<array><dict><key>term</key><string>budget&#1114112;planner</string></dict></array>`;
    expect(() => parseHintTerms(decimal)).not.toThrow();
    expect(parseHintTerms(decimal)).toEqual(["budget&#1114112;planner"]);
  });

  it("ignores dict entries with no term key", () => {
    const body = `<array><dict><key>kind</key><string>app</string></dict><dict><key>term</key><string>real term</string></dict></array>`;
    expect(parseHintTerms(body)).toEqual(["real term"]);
  });

  it("drops empty/whitespace-only term strings", () => {
    const body = `<array><dict><key>term</key><string>   </string></dict><dict><key>term</key><string>budget</string></dict></array>`;
    expect(parseHintTerms(body)).toEqual(["budget"]);
  });
});

describe("buildCandidatesFromHints", () => {
  it("normalizes, dedupes, and preserves rank + genreZone", () => {
    const terms = ["Budget Planner", "budget   planner", "Budget Bestie"];
    const candidates = buildCandidatesFromHints(terms, "finance", 10);
    expect(candidates).toEqual([
      { keyword: "budget planner", genreZone: "finance", rank: 0 },
      { keyword: "budget bestie", genreZone: "finance", rank: 2 },
    ]);
  });

  it("drops sole-generic-word junk via isJunkKeyword", () => {
    // "app" alone is junk (JUNK_KEYWORDS); "budget app" (multi-word) is not.
    const candidates = buildCandidatesFromHints(["app", "budget app"], "finance", 10);
    expect(candidates.map((c) => c.keyword)).toEqual(["budget app"]);
  });

  it("drops non-Latin-script terms", () => {
    const candidates = buildCandidatesFromHints(["мойбюджет", "budget"], "finance", 10);
    expect(candidates.map((c) => c.keyword)).toEqual(["budget"]);
  });

  it("caps at perSeed GOOD candidates, backfilling past skipped junk", () => {
    // "app" and "pro" are junk on their own and should be skipped without
    // consuming the perSeed budget — the cap applies to GOOD suggestions.
    const terms = ["app", "budget planner", "pro", "budget bestie", "budget tracker"];
    const candidates = buildCandidatesFromHints(terms, "finance", 2);
    expect(candidates.map((c) => c.keyword)).toEqual(["budget planner", "budget bestie"]);
    // Ranks reflect original position in the raw (pre-filter) term list.
    expect(candidates.map((c) => c.rank)).toEqual([1, 3]);
  });

  it("returns an empty array for an empty term list", () => {
    expect(buildCandidatesFromHints([], "finance", 10)).toEqual([]);
  });

  it("drops suggestions over the 80-char length cap (prompt-injection defense-in-depth)", () => {
    // Corpus keywords flow into synthesis LLM prompts downstream — an
    // oversized "suggestion" from a compromised/spoofed upstream is dropped
    // here rather than trusted through to the prompt.
    const oversized = `budget ${"planner ".repeat(15)}`.trim(); // well over 80 chars
    expect(oversized.length).toBeGreaterThan(80);
    const candidates = buildCandidatesFromHints([oversized, "budget planner"], "finance", 10);
    expect(candidates.map((c) => c.keyword)).toEqual(["budget planner"]);
  });

  it("keeps a suggestion right at the 80-char boundary", () => {
    const exactly80 = "a".repeat(80);
    const candidates = buildCandidatesFromHints([exactly80], "finance", 10);
    expect(candidates.map((c) => c.keyword)).toEqual([exactly80]);
  });
});

// Batch C1 ("prefix fan-out never rotates"): `buildPrefixFanOutWindow`
// replaces the pre-fix fixed `PREFIX_FAN_OUT_LETTERS.slice(0, count)` with a
// wraparound window starting at a per-seed cursor — see keyword-autocomplete.ts
// module doc and `keyword-store.ts`'s `ExpansionSeed.nextPrefixOffset`.
describe("buildPrefixFanOutWindow", () => {
  it("starts at offset 0 and returns the leading letters — matches the pre-fix fixed-slice behavior for a never-rotated seed", () => {
    expect(buildPrefixFanOutWindow(0, 5)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("starts mid-alphabet when given a non-zero offset", () => {
    expect(buildPrefixFanOutWindow(5, 3)).toEqual(["f", "g", "h"]);
  });

  it("wraps around past 'z' back to 'a'", () => {
    expect(buildPrefixFanOutWindow(24, 5)).toEqual(["y", "z", "a", "b", "c"]);
  });

  it("wraps around exactly at the boundary (offset 25, count 1 -> just 'z')", () => {
    expect(buildPrefixFanOutWindow(25, 1)).toEqual(["z"]);
  });

  it("returns the full alphabet in order when count is 26, regardless of offset", () => {
    const window = buildPrefixFanOutWindow(10, 26);
    expect(window).toHaveLength(26);
    expect(new Set(window).size).toBe(26); // every letter exactly once
    expect(window[0]).toBe("k"); // offset 10 -> 'k'
  });

  it("clamps count above 26 to 26 (never returns more letters than exist)", () => {
    expect(buildPrefixFanOutWindow(0, 100)).toHaveLength(26);
  });

  it("returns an empty array for count 0", () => {
    expect(buildPrefixFanOutWindow(0, 0)).toEqual([]);
  });

  it("returns an empty array for a negative count", () => {
    expect(buildPrefixFanOutWindow(0, -5)).toEqual([]);
  });

  it("normalizes a negative offset via true modulo (never returns undefined letters)", () => {
    // -1 mod 26 == 25 ('z'), so a window of 2 starting there wraps to ['z', 'a'].
    expect(buildPrefixFanOutWindow(-1, 2)).toEqual(["z", "a"]);
  });

  it("normalizes an offset >= 26 by wrapping it back into range", () => {
    expect(buildPrefixFanOutWindow(26, 2)).toEqual(["a", "b"]);
    expect(buildPrefixFanOutWindow(27, 2)).toEqual(["b", "c"]);
  });
});

// --- Coverage wave (2026-07-26): probe-ledger primitives (migration 057) ---

describe("findSelfRank", () => {
  it("returns the 0-based position at which the query is suggested back", () => {
    expect(findSelfRank("budget", ["budget planner", "budget", "budget app"])).toBe(1);
  });

  it("returns 0 when the query is Apple's top suggestion (not falsy-null)", () => {
    // The strongest possible self-signal must not be confusable with "absent".
    expect(findSelfRank("budget", ["budget", "budget planner"])).toBe(0);
  });

  it("returns null when Apple did not suggest the exact phrase back", () => {
    // With `returnedAny: true` this is the cleanest negative the endpoint can
    // give: Apple answered, and the phrase wasn't in the answer.
    expect(findSelfRank("peptide tracker", ["peptide guide", "peptide calculator"])).toBeNull();
  });

  it("returns null for an empty response", () => {
    expect(findSelfRank("peptide tracker", [])).toBeNull();
  });

  it("matches through casing and whitespace differences in Apple's echo", () => {
    expect(findSelfRank("Meal   Prep", ["meal prep"])).toBe(0);
    expect(findSelfRank("meal prep", ["  MEAL PREP  "])).toBe(0);
  });

  it("returns null for a blank query rather than matching a blank term", () => {
    expect(findSelfRank("   ", ["", "budget"])).toBeNull();
  });

  it("returns the FIRST (best) position when Apple repeats the phrase", () => {
    expect(findSelfRank("budget", ["budget", "budget", "budget app"])).toBe(0);
  });
});

describe("buildProbeWrite", () => {
  it("marks a non-empty response as `returnedAny` with a term count and self rank", () => {
    expect(
      buildProbeWrite({
        query: "budget",
        storefront: "us",
        probedAt: 1_800_000_000,
        terms: ["budget planner", "budget"],
      }),
    ).toEqual({
      query: "budget",
      storefront: "us",
      probedAt: 1_800_000_000,
      returnedAny: true,
      termCount: 2,
      selfRank: 1,
    });
  });

  it("marks an EMPTY response as `returnedAny: false` — the previously unrepresentable datum", () => {
    expect(
      buildProbeWrite({ query: "peptide tracker", storefront: "us", probedAt: 42, terms: [] }),
    ).toEqual({
      query: "peptide tracker",
      storefront: "us",
      probedAt: 42,
      returnedAny: false,
      termCount: 0,
      selfRank: null,
    });
  });

  it("keeps `returnedAny: true` with a null self rank when Apple answered about other phrases", () => {
    const write = buildProbeWrite({
      query: "peptide tracker",
      storefront: "gb",
      probedAt: 42,
      terms: ["peptide guide"],
    });
    expect(write.returnedAny).toBe(true);
    expect(write.selfRank).toBeNull();
    expect(write.storefront).toBe("gb");
  });
});
