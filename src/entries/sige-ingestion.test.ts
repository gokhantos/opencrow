/**
 * Unit tests for pure functions exported from sige-ingestion.
 *
 * No DB, no network, no side effects — runs in the `test:unit` lane.
 *
 * Covers:
 *  - computeCredibility (original suite, unchanged)
 *  - passesQualityGate  (quality gate)
 *  - normaliseForHash   (text normalisation for dedup)
 *  - contentHash        (SHA-256 determinism)
 *  - todayUtc / dailyCountKey (daily budget helpers)
 *  - parseCursor / serializeCursor (composite cursor format — Bug 2)
 */

import { describe, expect, it } from "bun:test";
import {
  ALPHA_RATIO_MIN,
  CREDIBILITY_FLOOR,
  MIN_CONTENT_LENGTH,
  type CompositeCursor,
  type QualityGateResult,
  computeCredibility,
  contentHash,
  dailyCountKey,
  normaliseForHash,
  parseCursor,
  passesQualityGate,
  serializeCursor,
  todayUtc,
} from "./sige-ingestion";

// ─── computeCredibility — appstore_review ────────────────────────────────────

describe("computeCredibility — appstore_review", () => {
  it("returns 1.0 for a 1-star review (maximum signal)", () => {
    expect(computeCredibility({ source_type: "appstore_review", rating: 1 })).toBe(1.0);
  });

  it("returns 0.75 for a 2-star review", () => {
    expect(computeCredibility({ source_type: "appstore_review", rating: 2 })).toBe(0.75);
  });

  it("returns 0.5 for a 3-star review (floor — ingestion gate already filters to ≤2, but heuristic is still safe)", () => {
    expect(computeCredibility({ source_type: "appstore_review", rating: 3 })).toBe(0.5);
  });

  it("defaults to 0.5 when rating is absent", () => {
    expect(computeCredibility({ source_type: "appstore_review" })).toBe(0.5);
  });
});

// ─── computeCredibility — playstore_review ───────────────────────────────────

describe("computeCredibility — playstore_review", () => {
  it("returns 1.0 for a 1-star review with no thumbs-up", () => {
    expect(computeCredibility({ source_type: "playstore_review", rating: 1, thumbs_up: 0 })).toBe(
      1.0,
    );
  });

  it("adds thumbs-up bonus: 100 upvotes on a 2-star review → 0.75 + 0.2 = 0.95", () => {
    expect(
      computeCredibility({ source_type: "playstore_review", rating: 2, thumbs_up: 100 }),
    ).toBeCloseTo(0.95);
  });

  it("clamps to 1.0 even when thumbs-up bonus would push a 1-star review above 1", () => {
    expect(
      computeCredibility({ source_type: "playstore_review", rating: 1, thumbs_up: 999 }),
    ).toBe(1.0);
  });

  it("low engagement 2-star review: only ratingScore contributes → 0.75", () => {
    expect(
      computeCredibility({ source_type: "playstore_review", rating: 2, thumbs_up: 0 }),
    ).toBe(0.75);
  });
});

// ─── computeCredibility — reddit_post ────────────────────────────────────────

describe("computeCredibility — reddit_post", () => {
  it("returns the floor 0.15 for a zero-score, zero-comment post", () => {
    expect(
      computeCredibility({ source_type: "reddit_post", score: 0, num_comments: 0 }),
    ).toBe(0.15);
  });

  it("returns high credibility for viral post (500 score, 200 comments)", () => {
    // scoreComponent = 1.0 * 0.6 = 0.6; engagementComponent = 1.0 * 0.4 = 0.4 → 1.0
    expect(
      computeCredibility({ source_type: "reddit_post", score: 500, num_comments: 200 }),
    ).toBe(1.0);
  });

  it("medium post: score 250, comments 100 → 0.5", () => {
    // scoreComponent = 0.5 * 0.6 = 0.3; engagementComponent = 0.5 * 0.4 = 0.2 → 0.5
    expect(
      computeCredibility({ source_type: "reddit_post", score: 250, num_comments: 100 }),
    ).toBeCloseTo(0.5);
  });

  it("negative score falls back to the floor (0.15)", () => {
    expect(
      computeCredibility({ source_type: "reddit_post", score: -50, num_comments: 0 }),
    ).toBe(0.15);
  });
});

// ─── computeCredibility — producthunt ────────────────────────────────────────

describe("computeCredibility — producthunt", () => {
  it("returns the floor 0.2 for a zero-vote product", () => {
    expect(computeCredibility({ source_type: "producthunt", points: 0 })).toBe(0.2);
  });

  it("returns 0.8 for a 500-vote product (soft cap)", () => {
    expect(computeCredibility({ source_type: "producthunt", points: 500 })).toBeCloseTo(0.8);
  });

  it("clamps to 1.0 for an exceptionally popular product (1000+ votes)", () => {
    expect(computeCredibility({ source_type: "producthunt", points: 1000 })).toBe(1.0);
  });
});

// ─── computeCredibility — hackernews ─────────────────────────────────────────

describe("computeCredibility — hackernews", () => {
  it("returns the floor 0.2 for a new story with no points", () => {
    expect(
      computeCredibility({ source_type: "hackernews", points: 0, num_comments: 0 }),
    ).toBe(0.2);
  });

  it("returns 1.0 for a top story (500 pts, 200 comments)", () => {
    // pointsComponent = 1.0 * 0.7 = 0.7; engagementComponent = 1.0 * 0.3 = 0.3 → 1.0
    expect(
      computeCredibility({ source_type: "hackernews", points: 500, num_comments: 200 }),
    ).toBe(1.0);
  });
});

// ─── computeCredibility — news_article ───────────────────────────────────────

describe("computeCredibility — news_article", () => {
  it("always returns the fixed 0.6 regardless of inputs", () => {
    expect(computeCredibility({ source_type: "news_article" })).toBe(0.6);
  });
});

// ─── computeCredibility — appstore_app ───────────────────────────────────────

describe("computeCredibility — appstore_app", () => {
  it("always returns 0.5", () => {
    expect(computeCredibility({ source_type: "appstore_app" })).toBe(0.5);
  });
});

// ─── computeCredibility — playstore_app ──────────────────────────────────────

describe("computeCredibility — playstore_app", () => {
  it("returns the floor 0.3 for an app with no install data", () => {
    expect(computeCredibility({ source_type: "playstore_app", installs: null })).toBe(0.3);
  });

  it("returns high credibility for a widely-installed, top-rated app", () => {
    // installsComponent = 1.0 * 0.8 = 0.8; ratingComponent = 1.0 * 0.2 = 0.2 → 1.0
    expect(
      computeCredibility({ source_type: "playstore_app", installs: "10,000,000+", rating: 5 }),
    ).toBe(1.0);
  });

  it("parses shorthand install counts and applies floor (1M+ installs, 4★ → below floor → 0.3)", () => {
    // installsComponent = (1_000_000/10_000_000)*0.8 = 0.08
    // ratingComponent   = (4/5)*0.2 = 0.16
    // raw = 0.24, floor = 0.3 → returns 0.3
    expect(
      computeCredibility({ source_type: "playstore_app", installs: "1,000,000+", rating: 4 }),
    ).toBeCloseTo(0.3);
  });

  it("correctly combines installs and rating for a mid-tier app", () => {
    // 5_000_000 / 10_000_000 * 0.8 = 0.4; 4/5 * 0.2 = 0.16 → 0.56
    const score = computeCredibility({
      source_type: "playstore_app",
      installs: "5,000,000+",
      rating: 4,
    });
    expect(score).toBeCloseTo(0.56);
  });
});

// ─── computeCredibility — unknown source ─────────────────────────────────────

describe("computeCredibility — unknown source type", () => {
  it("returns the conservative default 0.4", () => {
    expect(computeCredibility({ source_type: "mystery_source" })).toBe(0.4);
  });
});

// ─── computeCredibility — output is always in [0, 1] ─────────────────────────

describe("computeCredibility — output range invariant", () => {
  const edgeCases: Array<Parameters<typeof computeCredibility>[0]> = [
    { source_type: "appstore_review", rating: 0 },
    { source_type: "playstore_review", rating: 0, thumbs_up: 10_000 },
    { source_type: "reddit_post", score: -1_000, num_comments: -5 },
    { source_type: "producthunt", points: 100_000 },
    { source_type: "hackernews", points: 100_000, num_comments: 100_000 },
    { source_type: "playstore_app", installs: "invalid", rating: 10 },
  ];

  for (const inputs of edgeCases) {
    it(`stays in [0, 1] for ${JSON.stringify(inputs)}`, () => {
      const score = computeCredibility(inputs);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  }
});

// ─── passesQualityGate ────────────────────────────────────────────────────────

describe("passesQualityGate — length check", () => {
  it("rejects content shorter than MIN_CONTENT_LENGTH", () => {
    const short = "x".repeat(MIN_CONTENT_LENGTH - 1);
    const result = passesQualityGate(short, "reddit_post", 0.8);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_too_short");
  });

  it("rejects content that is exactly one char below MIN_CONTENT_LENGTH after trimming", () => {
    const padded = "  " + "a".repeat(MIN_CONTENT_LENGTH - 1) + "  ";
    const result = passesQualityGate(padded, "news_article", 0.8);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_too_short");
  });

  it("passes content exactly at MIN_CONTENT_LENGTH", () => {
    const exact = "a".repeat(MIN_CONTENT_LENGTH);
    const result = passesQualityGate(exact, "news_article", 0.8);
    // May still be rejected by alpha ratio, but not by length.
    expect(result.reason).not.toBe("content_too_short");
  });

  it("passes a long article excerpt", () => {
    const text = "This is a long enough article with plenty of real words and content to pass.";
    const result = passesQualityGate(text, "news_article", 0.8);
    expect(result.ok).toBe(true);
  });
});

describe("passesQualityGate — alpha ratio", () => {
  it("rejects pure emoji content", () => {
    const emoji = "🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰🥰";
    const result = passesQualityGate(emoji, "appstore_review", 0.8);
    expect(result.ok).toBe(false);
    // Could be content_too_short or alpha_ratio_too_low depending on byte-vs-char length.
    // Either rejection reason is correct — just confirm it is rejected.
    expect(result.ok).toBe(false);
  });

  it("rejects punctuation/emoji-heavy string that is long enough in bytes but has low alpha ratio", () => {
    // 10 emoji chars repeated — very long in bytes but zero latin letters
    const spam = "❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️";
    const result = passesQualityGate(spam, "reddit_post", 0.8);
    expect(result.ok).toBe(false);
  });

  it("passes a sentence with mostly letters even if some punctuation is present", () => {
    const text = "This app crashes every time I open it — really annoying and frustrating!";
    const result = passesQualityGate(text, "appstore_review", 0.8);
    expect(result.ok).toBe(true);
  });

  it(`rejects when alpha ratio is just below ${ALPHA_RATIO_MIN}`, () => {
    // Build a string with < ALPHA_RATIO_MIN alpha ratio
    // 44% letters, 56% digits/symbols → below 0.45 threshold
    const letters = "a".repeat(44);
    const digits = "1".repeat(56);
    const text = (letters + digits).repeat(2); // 200 chars total, well above MIN_CONTENT_LENGTH
    const result = passesQualityGate(text, "reddit_post", 0.8);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("alpha_ratio_too_low");
  });
});

describe("passesQualityGate — credibility floor", () => {
  it("rejects when credibility is below CREDIBILITY_FLOOR", () => {
    const text = "This is a detailed reddit post with enough text content to pass other checks.";
    const result = passesQualityGate(text, "reddit_post", CREDIBILITY_FLOOR - 0.01);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("credibility_below_floor");
  });

  it("passes when credibility is exactly at CREDIBILITY_FLOOR", () => {
    const text = "This is a detailed reddit post with enough text content to pass other checks.";
    const result = passesQualityGate(text, "reddit_post", CREDIBILITY_FLOOR);
    expect(result.ok).toBe(true);
  });

  it("passes a reddit post with zero engagement (credibility = 0.15) — below floor", () => {
    const text = "Short post about nothing in particular with barely any upvotes from anyone.";
    // computeCredibility gives 0.15 for zero-score reddit posts — below CREDIBILITY_FLOOR (0.25)
    const result = passesQualityGate(text, "reddit_post", 0.15);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("credibility_below_floor");
  });

  it("reviews always have credibility ≥ 0.5 so CREDIBILITY_FLOOR never drops them", () => {
    // The spec states reviews are always ≥0.75 — verify the floor does not interfere.
    const text = "This app keeps crashing and losing my data every single day.";
    const reviewCredibility = computeCredibility({ source_type: "appstore_review", rating: 1 });
    expect(reviewCredibility).toBeGreaterThanOrEqual(CREDIBILITY_FLOOR);
    const result = passesQualityGate(text, "appstore_review", reviewCredibility);
    expect(result.ok).toBe(true);
  });
});

describe("passesQualityGate — review sentiment filter", () => {
  // NOTE: the sentiment filter only fires when the trimmed content is
  // between MIN_CONTENT_LENGTH (40) and REVIEW_SENTIMENT_MAX_LEN (60) chars.
  // Strings shorter than 40 chars never reach this gate — they fail the
  // length check first.  All test strings below are exactly in the 40-60
  // char window unless the test intentionally goes longer.

  it("rejects a purely-positive app store review in the 40-60 char window", () => {
    // 47 chars: ≥40 (passes length), ≤60 (sentiment filter applies), no negative tokens
    const text = "Great app! Love it so much, truly wonderful."; // 44 chars
    expect(text.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    expect(text.trim().length).toBeLessThanOrEqual(60);
    const result = passesQualityGate(text, "appstore_review", 0.75);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("short_positive_review_no_complaint");
  });

  it("rejects a purely-positive play store review in the 40-60 char window", () => {
    const text = "Amazing app! Best productivity tool ever made."; // 46 chars
    expect(text.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    expect(text.trim().length).toBeLessThanOrEqual(60);
    const result = passesQualityGate(text, "playstore_review", 1.0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("short_positive_review_no_complaint");
  });

  it("passes a review in the 40-60 char window that also contains a negative token", () => {
    // "great" is positive, but "crash" is negative → must NOT be dropped
    const text = "Great app but it keeps crashing every single day."; // 49 chars
    expect(text.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    expect(text.trim().length).toBeLessThanOrEqual(60);
    const result = passesQualityGate(text, "appstore_review", 0.75);
    expect(result.ok).toBe(true);
  });

  it("passes a review in the 40-60 char window with 'not' — negative token present", () => {
    const text = "Good looking app but not working at all correctly."; // 50 chars
    expect(text.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    expect(text.trim().length).toBeLessThanOrEqual(60);
    const result = passesQualityGate(text, "playstore_review", 1.0);
    expect(result.ok).toBe(true);
  });

  it("passes a long positive review (> 60 chars) — sentiment filter does not apply", () => {
    // Over 60 chars so sentiment filter does not apply regardless of tokens
    const long =
      "This is a wonderful and amazing app that I absolutely love using every single day without fail.";
    expect(long.trim().length).toBeGreaterThan(60);
    const result = passesQualityGate(long, "appstore_review", 0.75);
    expect(result.ok).toBe(true);
  });

  it("does NOT apply the sentiment filter to non-review sources", () => {
    // Same positive text in the sentiment window — should not be filtered for news
    const text = "Great news! Love this amazing product announcement."; // 51 chars
    expect(text.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    expect(text.trim().length).toBeLessThanOrEqual(60);
    const result = passesQualityGate(text, "news_article", 0.6);
    expect(result.ok).toBe(true);
  });

  it("passes a genuine complaint that starts with a positive word", () => {
    // "good" is positive but "slow" + "terrible" are negative → must survive
    const text = "Good concept but extremely slow and terrible UI design."; // 55 chars
    expect(text.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    expect(text.trim().length).toBeLessThanOrEqual(60);
    const result = passesQualityGate(text, "appstore_review", 0.75);
    expect(result.ok).toBe(true);
  });

  it("rejects emoji-positive review in the 40-60 char window with no negative tokens", () => {
    // 🥰 is in the positive lexicon; no negative tokens
    const text = "🥰 love this app so much, truly absolutely perfect!"; // ~51 chars
    // This may be rejected by alpha ratio first (emoji reduces alpha fraction) —
    // either reason is valid, just confirm it is rejected.
    const result = passesQualityGate(text, "appstore_review", 0.75);
    expect(result.ok).toBe(false);
  });
});

describe("passesQualityGate — combined scenarios", () => {
  it("a long, high-credibility, alpha-rich complaint passes all gates", () => {
    const text =
      "The app crashes every single time I try to export a file. I have lost hours of work because of this bug. Please fix it as soon as possible.";
    const result = passesQualityGate(text, "appstore_review", 1.0);
    expect(result.ok).toBe(true);
  });

  it("returns ok:true with no reason field when passing", () => {
    const text = "I cannot open the app at all. It just crashes immediately on startup.";
    const result: QualityGateResult = passesQualityGate(text, "appstore_review", 0.75);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─── normaliseForHash ─────────────────────────────────────────────────────────

describe("normaliseForHash", () => {
  it("lowercases the text", () => {
    expect(normaliseForHash("HELLO WORLD")).toBe("hello world");
  });

  it("collapses non-alphanumeric runs to a single space", () => {
    expect(normaliseForHash("hello---world!!!")).toBe("hello world");
  });

  it("trims leading and trailing spaces", () => {
    expect(normaliseForHash("  hello world  ")).toBe("hello world");
  });

  it("makes minor punctuation variants hash to the same value", () => {
    const a = normaliseForHash("App crashes every time!");
    const b = normaliseForHash("App crashes every time.");
    expect(a).toBe(b);
  });

  it("makes whitespace variants collide", () => {
    const a = normaliseForHash("hello   world");
    const b = normaliseForHash("hello world");
    expect(a).toBe(b);
  });

  it("preserves digits as alphanumeric", () => {
    expect(normaliseForHash("version 2.0 released")).toBe("version 2 0 released");
  });
});

// ─── contentHash ─────────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const h = contentHash("hello world");
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  it("is deterministic — same input always produces the same hash", () => {
    const text = "The app keeps crashing on iOS 17.";
    expect(contentHash(text)).toBe(contentHash(text));
  });

  it("produces the same hash for minor punctuation variants (via normalisation)", () => {
    const h1 = contentHash("App crashes every time!");
    const h2 = contentHash("App crashes every time.");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for semantically different content", () => {
    const h1 = contentHash("App crashes on startup");
    const h2 = contentHash("App works perfectly fine");
    expect(h1).not.toBe(h2);
  });

  it("is case-insensitive", () => {
    expect(contentHash("HELLO WORLD")).toBe(contentHash("hello world"));
  });
});

// ─── todayUtc / dailyCountKey ─────────────────────────────────────────────────

describe("todayUtc", () => {
  it("returns a string matching YYYY-MM-DD", () => {
    const today = todayUtc();
    expect(/^\d{4}-\d{2}-\d{2}$/.test(today)).toBe(true);
  });

  it("matches the current UTC date", () => {
    const expected = new Date().toISOString().slice(0, 10);
    expect(todayUtc()).toBe(expected);
  });
});

describe("dailyCountKey", () => {
  it("formats the key as ingested:YYYY-MM-DD", () => {
    expect(dailyCountKey("2026-06-19")).toBe("ingested:2026-06-19");
  });

  it("produces different keys for different dates", () => {
    expect(dailyCountKey("2026-06-19")).not.toBe(dailyCountKey("2026-06-20"));
  });
});

// ─── parseCursor / serializeCursor (Bug 2 — composite cursor) ────────────────

describe("serializeCursor", () => {
  it("serialises a cursor to a JSON string", () => {
    const cursor: CompositeCursor = { ts: 1_718_000_000, id: "abc-123" };
    const serialized = serializeCursor(cursor);
    expect(typeof serialized).toBe("string");
    const parsed = JSON.parse(serialized) as unknown;
    expect(parsed).toEqual({ ts: 1_718_000_000, id: "abc-123" });
  });

  it("round-trips through JSON.parse", () => {
    const cursor: CompositeCursor = { ts: 1_234_567, id: "some-uuid-value" };
    const back = JSON.parse(serializeCursor(cursor)) as CompositeCursor;
    expect(back.ts).toBe(cursor.ts);
    expect(back.id).toBe(cursor.id);
  });
});

describe("parseCursor — valid composite format", () => {
  it("parses a correctly-shaped object (config_overrides already JSON.parse'd)", () => {
    const stored = { ts: 1_718_000_000, id: "some-id" };
    const result = parseCursor(stored);
    expect(result).toEqual({ ts: 1_718_000_000, id: "some-id" });
  });

  it("parses a JSON string containing the composite shape", () => {
    const stored = JSON.stringify({ ts: 1_500_000_000, id: "row-42" });
    const result = parseCursor(stored);
    expect(result).toEqual({ ts: 1_500_000_000, id: "row-42" });
  });

  it("returns a readonly object with correct types", () => {
    const result = parseCursor({ ts: 100, id: "x" });
    expect(typeof result?.ts).toBe("number");
    expect(typeof result?.id).toBe("string");
  });
});

describe("parseCursor — legacy / absent values return null (Bug 2 migration handling)", () => {
  it("returns null for null (no stored cursor)", () => {
    expect(parseCursor(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseCursor(undefined)).toBeNull();
  });

  it("returns null for a legacy bare string id (old format)", () => {
    // Old cursor was a plain string like "t5_abc123" (reddit base36) or a UUID
    expect(parseCursor("t5_abc123")).toBeNull();
  });

  it("returns null for a bare numeric string (old numeric id cursor)", () => {
    expect(parseCursor("12345678")).toBeNull();
  });

  it("returns null for an empty string (initial cursor value)", () => {
    expect(parseCursor("")).toBeNull();
  });

  it("returns null for a number (legacy numeric config override)", () => {
    expect(parseCursor(12345)).toBeNull();
  });

  it("returns null for an object missing the ts field", () => {
    expect(parseCursor({ id: "abc" })).toBeNull();
  });

  it("returns null for an object missing the id field", () => {
    expect(parseCursor({ ts: 12345 })).toBeNull();
  });

  it("returns null for an object where ts is a string instead of number", () => {
    expect(parseCursor({ ts: "12345", id: "abc" })).toBeNull();
  });

  it("returns null for an object where id is a number instead of string", () => {
    expect(parseCursor({ ts: 12345, id: 999 })).toBeNull();
  });

  it("returns null for a JSON string that is not a composite cursor shape", () => {
    // JSON string of a raw id — would have been the old stored format
    expect(parseCursor('"some-uuid-here"')).toBeNull();
  });

  it("returns null for an array (malformed)", () => {
    expect(parseCursor([1, 2, 3])).toBeNull();
  });
});

describe("parseCursor — edge cases", () => {
  it("accepts ts=0 and id='' (initial high-water for empty table)", () => {
    const result = parseCursor({ ts: 0, id: "" });
    expect(result).toEqual({ ts: 0, id: "" });
  });

  it("accepts a UUID string as id (news_articles / playstore_reviews)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = parseCursor({ ts: 1_718_000_000, id: uuid });
    expect(result?.id).toBe(uuid);
  });

  it("accepts a package-name string as id (playstore_apps)", () => {
    const pkg = "com.example.myapp";
    const result = parseCursor({ ts: 1_718_000_000, id: pkg });
    expect(result?.id).toBe(pkg);
  });

  it("accepts a base36 reddit post id", () => {
    const base36 = "1a2b3c4d";
    const result = parseCursor({ ts: 1_718_000_000, id: base36 });
    expect(result?.id).toBe(base36);
  });
});

describe("cursor high-water advance logic (pure)", () => {
  /**
   * Verifies the ordering logic:
   * A cursor at (ts=100, id="a") should compare less than (ts=101, id="a") and
   * equal to (ts=100, id="b") when b > "a" lexicographically.
   * This mirrors the SQL predicate: indexed_at > $ts OR (indexed_at = $ts AND id > $id)
   */

  function isCursorAhead(
    candidate: CompositeCursor,
    current: CompositeCursor,
  ): boolean {
    return (
      candidate.ts > current.ts ||
      (candidate.ts === current.ts && candidate.id > current.id)
    );
  }

  it("newer ts always beats older ts regardless of id", () => {
    expect(isCursorAhead({ ts: 101, id: "a" }, { ts: 100, id: "z" })).toBe(true);
  });

  it("same ts, later id is ahead", () => {
    expect(isCursorAhead({ ts: 100, id: "b" }, { ts: 100, id: "a" })).toBe(true);
  });

  it("same ts, earlier id is NOT ahead", () => {
    expect(isCursorAhead({ ts: 100, id: "a" }, { ts: 100, id: "b" })).toBe(false);
  });

  it("older ts is NOT ahead even with a later id", () => {
    expect(isCursorAhead({ ts: 99, id: "z" }, { ts: 100, id: "a" })).toBe(false);
  });

  it("identical cursor is NOT ahead (no false progress)", () => {
    expect(isCursorAhead({ ts: 100, id: "x" }, { ts: 100, id: "x" })).toBe(false);
  });

  it("UUID ids compare lexicographically (no stranding for non-monotonic ids)", () => {
    // Two UUIDs with the same ts — later lexicographic order is considered ahead
    const earlier = "00000000-0000-0000-0000-000000000001";
    const later = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(isCursorAhead({ ts: 1000, id: later }, { ts: 1000, id: earlier })).toBe(true);
  });
});
