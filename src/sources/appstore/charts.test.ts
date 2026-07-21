import { describe, expect, it } from "bun:test";
import {
  ITUNES_CATEGORIES,
  buildCategoryRankingUrl,
  buildGlobalTopAppsUrl,
  categoryListTypeTag,
  dedupeRankingsByListKey,
  parseTopAppsItunes,
} from "./charts";
import type { AppRankingRow } from "./store";

describe("ITUNES_CATEGORIES", () => {
  it("includes the two Stage 3 additions (genre 6021 and 6027)", () => {
    const ids = ITUNES_CATEGORIES.map((c) => c.id);
    expect(ids).toContain(6021);
    expect(ids).toContain(6027);
  });

  it("labels the Stage 3 additions with their live-verified names", () => {
    expect(ITUNES_CATEGORIES.find((c) => c.id === 6021)?.name).toBe("Magazines & Newspapers");
    expect(ITUNES_CATEGORIES.find((c) => c.id === 6027)?.name).toBe("Graphics & Design");
  });

  it("has no duplicate genre ids", () => {
    const ids = ITUNES_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildCategoryRankingUrl", () => {
  it("builds a top-free URL for a genre, defaulting to the us storefront", () => {
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

  // Stage 3: intl storefront support.
  it("builds a URL for a non-us storefront when passed explicitly", () => {
    expect(buildCategoryRankingUrl(6000, "top-free", 200, "gb")).toBe(
      "https://itunes.apple.com/gb/rss/topfreeapplications/limit=200/genre=6000/json",
    );
  });

  it("builds distinct URLs per storefront for the same genre/listType", () => {
    const gb = buildCategoryRankingUrl(6014, "top-free", 200, "gb");
    const ca = buildCategoryRankingUrl(6014, "top-free", 200, "ca");
    const au = buildCategoryRankingUrl(6014, "top-free", 200, "au");
    expect(new Set([gb, ca, au]).size).toBe(3);
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

  // Stage 3: cross-storefront distinctness — the SAME (id, list_type) pair
  // must survive dedup once per storefront, since intl sweeps reuse the same
  // list_type tags as the US chart.
  it("keeps the same (id, list_type) pair distinct across storefronts", () => {
    const rows = [
      makeRow({ id: "1", list_type: "top-free-6000", storefront: "us" }),
      makeRow({ id: "1", list_type: "top-free-6000", storefront: "gb" }),
      makeRow({ id: "1", list_type: "top-free-6000", storefront: "ca" }),
    ];
    expect(dedupeRankingsByListKey(rows)).toHaveLength(3);
  });

  it("still dedupes a true duplicate WITHIN the same storefront", () => {
    const rows = [
      makeRow({ id: "1", list_type: "top-free-6000", storefront: "gb", rank: 1 }),
      makeRow({ id: "1", list_type: "top-free-6000", storefront: "gb", rank: 2 }),
    ];
    const result = dedupeRankingsByListKey(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.rank).toBe(1);
  });

  it("treats a missing storefront the same as 'us' for keying purposes", () => {
    const rows = [
      makeRow({ id: "1", list_type: "top-free-6000", storefront: undefined }),
      makeRow({ id: "1", list_type: "top-free-6000", storefront: "us" }),
    ];
    expect(dedupeRankingsByListKey(rows)).toHaveLength(1);
  });
});

// ── parseTopAppsItunes ───────────────────────────────────────────────────

/** Builds a single synthetic RSS `entry` object (minimal shape parseTopAppsItunes reads). */
function fixtureEntry(id: string, name: string): Record<string, unknown> {
  return {
    id: { attributes: { "im:id": id, "im:bundleId": `com.example.${id}` } },
    "im:name": { label: name },
    "im:artist": { label: "Example Dev" },
    category: { attributes: { label: "Games" } },
    "im:image": [{ label: `https://example.com/${id}.png` }],
    link: { attributes: { href: `https://apps.apple.com/app/id${id}` } },
    summary: { label: "A synthetic test app." },
    "im:price": { attributes: { amount: "0" } },
    "im:releaseDate": { attributes: { label: "2026-01-01T00:00:00-07:00" } },
  };
}

describe("parseTopAppsItunes", () => {
  it("defaults storefront to 'us' when not passed", () => {
    const data = { feed: { entry: [fixtureEntry("1", "App One")] } };
    const rows = parseTopAppsItunes(data, "top-free-6000");
    expect(rows[0]?.storefront).toBe("us");
  });

  it("tags every row with the passed storefront", () => {
    const data = { feed: { entry: [fixtureEntry("1", "App One"), fixtureEntry("2", "App Two")] } };
    const rows = parseTopAppsItunes(data, "top-free-6000", "gb");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.storefront === "gb")).toBe(true);
  });

  it("parses a single-entry (non-array) feed.entry the same as a wrapped array", () => {
    // The iTunes RSS API returns `feed.entry` as a bare object (not an
    // array) when the feed has exactly one result — a real shape quirk, not
    // a hypothetical.
    const data = { feed: { entry: fixtureEntry("42", "Solo App") } };
    const rows = parseTopAppsItunes(data, "top-free-6014", "au");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("42");
    expect(rows[0]?.storefront).toBe("au");
  });

  it("parses a 98-entry AU chart fixture end to end (rank order + storefront tagging)", () => {
    const entries = Array.from({ length: 98 }, (_, i) => fixtureEntry(String(i + 1), `AU App ${i + 1}`));
    const data = { feed: { entry: entries } };
    const rows = parseTopAppsItunes(data, "top-free-6014", "au");

    expect(rows).toHaveLength(98);
    expect(rows.every((r) => r.storefront === "au")).toBe(true);
    // rank is 1-based position in the feed, not derived from the id.
    expect(rows[0]?.rank).toBe(1);
    expect(rows[97]?.rank).toBe(98);
    expect(rows[0]?.id).toBe("1");
    expect(rows[97]?.id).toBe("98");
  });

  it("returns an empty array when feed.entry is absent", () => {
    expect(parseTopAppsItunes({ feed: {} }, "top-free-6000")).toEqual([]);
  });

  it("returns an empty array when feed itself is absent", () => {
    expect(parseTopAppsItunes({}, "top-free-6000")).toEqual([]);
  });
});
