import { describe, expect, it } from "bun:test";
import {
  buildCategoryRankingUrl,
  buildGlobalTopAppsUrl,
  categoryListTypeTag,
  dedupeRankingsByListKey,
} from "./scraper";
import type { AppRankingRow } from "./store";

describe("buildCategoryRankingUrl", () => {
  it("builds a top-free URL for a genre", () => {
    expect(buildCategoryRankingUrl(6000, "top-free", 200)).toBe(
      "https://itunes.apple.com/us/rss/topfreeapplications/limit=200/genre=6000/json",
    );
  });

  it("builds a top-paid URL for a genre", () => {
    expect(buildCategoryRankingUrl(6014, "top-paid", 200)).toBe(
      "https://itunes.apple.com/us/rss/toppaidapplications/limit=200/genre=6014/json",
    );
  });

  it("builds a top-grossing URL for a genre", () => {
    expect(buildCategoryRankingUrl(6014, "top-grossing", 200)).toBe(
      "https://itunes.apple.com/us/rss/topgrossingapplications/limit=200/genre=6014/json",
    );
  });

  it("honors the configured limit", () => {
    expect(buildCategoryRankingUrl(6000, "top-free", 25)).toContain("limit=25/");
  });
});

describe("categoryListTypeTag", () => {
  it("produces a distinct tag per genre + list type", () => {
    expect(categoryListTypeTag(6000, "top-free")).toBe("top-free-6000");
    expect(categoryListTypeTag(6000, "top-paid")).toBe("top-paid-6000");
    expect(categoryListTypeTag(6000, "top-grossing")).toBe("top-grossing-6000");
  });

  it("is distinct across genres for the same list type", () => {
    expect(categoryListTypeTag(6000, "top-free")).not.toBe(categoryListTypeTag(6014, "top-free"));
  });
});

describe("buildGlobalTopAppsUrl", () => {
  it("builds the top-free global feed URL", () => {
    expect(buildGlobalTopAppsUrl("top-free", 100)).toBe(
      "https://rss.applemarketingtools.com/api/v2/us/apps/top-free/100/apps.json",
    );
  });

  it("builds the top-paid global feed URL", () => {
    expect(buildGlobalTopAppsUrl("top-paid", 100)).toBe(
      "https://rss.applemarketingtools.com/api/v2/us/apps/top-paid/100/apps.json",
    );
  });
});

function makeRow(overrides: Partial<AppRankingRow>): AppRankingRow {
  return {
    id: "1",
    name: "App",
    artist: "Dev",
    category: "Games",
    rank: 1,
    list_type: "top-free-6000",
    icon_url: "",
    store_url: "",
    description: "",
    price: "Free",
    bundle_id: "",
    release_date: "",
    updated_at: 0,
    indexed_at: null,
    ...overrides,
  };
}

describe("dedupeRankingsByListKey", () => {
  it("keeps the first occurrence of a duplicate (id, list_type) pair", () => {
    const rows = [
      makeRow({ id: "1", list_type: "top-free-6000", rank: 1 }),
      makeRow({ id: "1", list_type: "top-free-6000", rank: 2 }),
    ];
    const result = dedupeRankingsByListKey(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.rank).toBe(1);
  });

  it("keeps the same app id across different list types", () => {
    const rows = [
      makeRow({ id: "1", list_type: "top-free-6000" }),
      makeRow({ id: "1", list_type: "top-paid-6000" }),
      makeRow({ id: "1", list_type: "top-grossing-6000" }),
    ];
    const result = dedupeRankingsByListKey(rows);
    expect(result).toHaveLength(3);
  });

  it("keeps different app ids in the same list type", () => {
    const rows = [
      makeRow({ id: "1", list_type: "top-free-6000" }),
      makeRow({ id: "2", list_type: "top-free-6000" }),
    ];
    expect(dedupeRankingsByListKey(rows)).toHaveLength(2);
  });

  it("drops rows with an empty id", () => {
    const rows = [makeRow({ id: "" }), makeRow({ id: "1" })];
    expect(dedupeRankingsByListKey(rows)).toHaveLength(1);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeRankingsByListKey([])).toEqual([]);
  });
});
