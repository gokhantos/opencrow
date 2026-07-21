import { describe, expect, it } from "bun:test";
import { buildReviewFeedUrl, MAX_REVIEW_PAGES, parseReviewFeedPage, REVIEW_PAGE_SIZE, toAppReviewRow } from "./review-rss";

describe("buildReviewFeedUrl", () => {
  it("builds the verified-live URL shape, defaulting to storefront 'us'", () => {
    expect(buildReviewFeedUrl("389801252", 1)).toBe(
      "https://itunes.apple.com/us/rss/customerreviews/page=1/id=389801252/sortby=mostrecent/json",
    );
  });

  it("threads a non-default storefront through", () => {
    expect(buildReviewFeedUrl("389801252", 3, "gb")).toBe(
      "https://itunes.apple.com/gb/rss/customerreviews/page=3/id=389801252/sortby=mostrecent/json",
    );
  });

  it("clamps page to >= 1", () => {
    expect(buildReviewFeedUrl("1", 0)).toContain("/page=1/");
    expect(buildReviewFeedUrl("1", -5)).toContain("/page=1/");
  });

  it("floors a fractional page", () => {
    expect(buildReviewFeedUrl("1", 2.9)).toContain("/page=2/");
  });
});

describe("REVIEW_PAGE_SIZE / MAX_REVIEW_PAGES constants", () => {
  it("match the verified-live feed shape (50/page, 10 pages)", () => {
    expect(REVIEW_PAGE_SIZE).toBe(50);
    expect(MAX_REVIEW_PAGES).toBe(10);
  });
});

/** A single synthetic RSS review `entry` — real-shape fields verified live against the endpoint. */
function fixtureEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    author: { name: { label: "Test Reviewer" } },
    updated: { label: "2026-07-19T21:15:58-07:00" },
    "im:rating": { label: "4" },
    "im:version": { label: "1.2.3" },
    id: { label: "14324928259" },
    title: { label: "Pretty good" },
    content: { label: "Does what it says." },
    "im:voteSum": { label: "3" },
    "im:voteCount": { label: "5" },
    ...overrides,
  };
}

describe("parseReviewFeedPage", () => {
  it("parses a normal multi-entry page", () => {
    const data = { feed: { entry: [fixtureEntry(), fixtureEntry({ id: { label: "999" } })] } };
    const parsed = parseReviewFeedPage(data);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      id: "14324928259",
      author: "Test Reviewer",
      rating: 4,
      version: "1.2.3",
      title: "Pretty good",
      content: "Does what it says.",
      reviewDate: Date.parse("2026-07-19T21:15:58-07:00") / 1000,
      voteSum: 3,
      voteCount: 5,
    });
  });

  it("tolerates a single bare-object entry (iTunes RSS-as-JSON quirk, not wrapped in an array)", () => {
    const data = { feed: { entry: fixtureEntry() } };
    const parsed = parseReviewFeedPage(data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("14324928259");
  });

  it("returns [] when the feed has no entry key at all (zero reviews / past the app's last page)", () => {
    expect(parseReviewFeedPage({ feed: {} })).toEqual([]);
    expect(parseReviewFeedPage({ feed: { author: {} } })).toEqual([]);
  });

  it("returns [] for a missing/malformed feed", () => {
    expect(parseReviewFeedPage(null)).toEqual([]);
    expect(parseReviewFeedPage({})).toEqual([]);
    expect(parseReviewFeedPage(undefined)).toEqual([]);
  });

  it("drops an entry missing id.label rather than crashing the page", () => {
    const data = { feed: { entry: [fixtureEntry({ id: { label: "" } }), fixtureEntry()] } };
    const parsed = parseReviewFeedPage(data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("14324928259");
  });

  it("defaults missing rating/vote fields to 0 rather than NaN", () => {
    const data = {
      feed: {
        entry: [
          fixtureEntry({
            "im:rating": undefined,
            "im:voteSum": undefined,
            "im:voteCount": undefined,
          }),
        ],
      },
    };
    const parsed = parseReviewFeedPage(data);
    expect(parsed[0]?.rating).toBe(0);
    expect(parsed[0]?.voteSum).toBe(0);
    expect(parsed[0]?.voteCount).toBe(0);
  });

  it("returns null reviewDate for an unparseable/missing updated field", () => {
    const data = { feed: { entry: [fixtureEntry({ updated: undefined })] } };
    const parsed = parseReviewFeedPage(data);
    expect(parsed[0]?.reviewDate).toBeNull();
  });
});

describe("toAppReviewRow", () => {
  it("maps a ParsedReview to the persisted row shape", () => {
    const parsed = parseReviewFeedPage({ feed: { entry: fixtureEntry() } })[0];
    if (!parsed) throw new Error("fixture produced no parsed review");
    const row = toAppReviewRow(parsed, "389801252", "Instagram", "gb", 1_700_000_000);
    expect(row).toEqual({
      id: "14324928259",
      app_id: "389801252",
      app_name: "Instagram",
      author: "Test Reviewer",
      rating: 4,
      title: "Pretty good",
      content: "Does what it says.",
      version: "1.2.3",
      first_seen_at: 1_700_000_000,
      indexed_at: null,
      review_date: parsed.reviewDate,
      storefront: "gb",
      vote_count: 5,
      vote_sum: 3,
    });
  });
});
