import { describe, expect, it } from "bun:test";
import {
  AppPageParseError,
  buildAppPageUrl,
  extractServerData,
  parseAppPage,
  parseIapItems,
  parseRatingsHistogram,
  parseRelatedApps,
  verifyIntentId,
} from "./app-page-parse";

// Synthetic ~1-2KB fixture builder — real SHAPE (verified live 2026-07-21
// against Instagram id389801252 and Candy Crush Saga id553834731, see the
// module doc comment), deliberately NOT the real ~600KB-1MB page. Every
// shelf is independently optional so tests can exercise "shelf-missing
// degradation" by simply omitting a key.
function fixtureHtml(opts: {
  readonly appId?: string;
  readonly noScript?: boolean;
  readonly invalidJson?: boolean;
  readonly emptyDataArray?: boolean;
  readonly shelfMapping?: Record<string, unknown>;
}): string {
  if (opts.noScript) {
    return "<!doctype html><html><body>no server data script here</body></html>";
  }

  const body = opts.invalidJson
    ? "{not valid json"
    : JSON.stringify(
        opts.emptyDataArray
          ? { data: [] }
          : { data: [{ intent: { id: opts.appId ?? "1000001" }, data: { shelfMapping: opts.shelfMapping ?? {} } }] },
      );

  return `<!doctype html><html><body><script type="application/json" id="serialized-server-data">${body}</script></body></html>`;
}

function productRatingsShelf(ratingCounts: readonly number[], ratingAverage: number) {
  return {
    productRatings: {
      items: [
        {
          ratingAverage,
          totalNumberOfRatings: ratingCounts.reduce((s, c) => s + c, 0),
          ratingCounts,
        },
      ],
    },
  };
}

describe("buildAppPageUrl", () => {
  it("builds the no-slug URL form (redirects to canonical slug, verified live)", () => {
    expect(buildAppPageUrl("553834731")).toBe("https://apps.apple.com/us/app/id553834731");
  });

  it("threads a non-default storefront through", () => {
    expect(buildAppPageUrl("553834731", "gb")).toBe("https://apps.apple.com/gb/app/id553834731");
  });
});

describe("extractServerData", () => {
  it("extracts and parses the serialized-server-data script tag", () => {
    const html = fixtureHtml({ appId: "42" });
    const data = extractServerData(html);
    expect(data.intent?.id).toBe("42");
  });

  it("throws AppPageParseError('missing-script') when the script tag is absent", () => {
    const html = fixtureHtml({ noScript: true });
    expect(() => extractServerData(html)).toThrow(AppPageParseError);
    try {
      extractServerData(html);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppPageParseError);
      expect((err as AppPageParseError).reason).toBe("missing-script");
    }
  });

  it("throws AppPageParseError('invalid-json') on malformed JSON", () => {
    const html = fixtureHtml({ invalidJson: true });
    try {
      extractServerData(html);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppPageParseError);
      expect((err as AppPageParseError).reason).toBe("invalid-json");
    }
  });

  it("throws AppPageParseError('missing-data') when data[] is empty", () => {
    const html = fixtureHtml({ emptyDataArray: true });
    try {
      extractServerData(html);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppPageParseError);
      expect((err as AppPageParseError).reason).toBe("missing-data");
    }
  });

  it("finds the script tag regardless of attribute order", () => {
    const html = `<script id="serialized-server-data" type="application/json">${JSON.stringify({
      data: [{ intent: { id: "7" }, data: { shelfMapping: {} } }],
    })}</script>`;
    expect(extractServerData(html).intent?.id).toBe("7");
  });
});

describe("verifyIntentId", () => {
  it("passes silently when the ids match", () => {
    const data = extractServerData(fixtureHtml({ appId: "42" }));
    expect(() => verifyIntentId(data, "42")).not.toThrow();
  });

  it("throws AppPageParseError('id-mismatch') when the ids differ", () => {
    const data = extractServerData(fixtureHtml({ appId: "42" }));
    try {
      verifyIntentId(data, "99");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppPageParseError);
      expect((err as AppPageParseError).reason).toBe("id-mismatch");
    }
  });

  it("fails closed on a missing intent.id", () => {
    const data = { intent: {}, data: { shelfMapping: {} } };
    expect(() => verifyIntentId(data, "42")).toThrow(AppPageParseError);
  });
});

describe("parseRatingsHistogram", () => {
  it("parses a well-formed 5-star-first histogram without flipping (real Instagram data)", () => {
    // Verified live 2026-07-19: ratingAverage 4.7, counts [25114270, 1991579,
    // 692820, 272564, 1217404] — 5-first-weighted average computes to ~4.69.
    const shelfMapping = productRatingsShelf([25_114_270, 1_991_579, 692_820, 272_564, 1_217_404], 4.7);
    const result = parseRatingsHistogram(shelfMapping);

    expect(result).not.toBeNull();
    expect(result?.orderFlipped).toBe(false);
    expect(result?.ratingCounts).toEqual([25_114_270, 1_991_579, 692_820, 272_564, 1_217_404]);
    expect(result?.ratingAverage).toBe(4.7);
    expect(result?.totalRatings).toBe(29_288_637);
  });

  it("flips the order when the raw payload is 1-star-first", () => {
    // Same distribution as above, but stored reversed — the reported average
    // (4.7) only matches the REVERSED interpretation of this raw order.
    const shelfMapping = productRatingsShelf([1_217_404, 272_564, 692_820, 1_991_579, 25_114_270], 4.7);
    const result = parseRatingsHistogram(shelfMapping);

    expect(result).not.toBeNull();
    expect(result?.orderFlipped).toBe(true);
    // Flipped back to canonical 5-star-first order.
    expect(result?.ratingCounts).toEqual([25_114_270, 1_991_579, 692_820, 272_564, 1_217_404]);
  });

  it("keeps the forward (canonical) order when neither interpretation matches within tolerance", () => {
    const shelfMapping = productRatingsShelf([10, 10, 10, 10, 10], 4.9); // uniform -> avg is always 3, no match either way
    const result = parseRatingsHistogram(shelfMapping);

    expect(result).not.toBeNull();
    expect(result?.orderFlipped).toBe(false);
    expect(result?.ratingCounts).toEqual([10, 10, 10, 10, 10]);
  });

  it("degrades to null when the productRatings shelf is entirely missing", () => {
    expect(parseRatingsHistogram({})).toBeNull();
  });

  it("degrades to null when ratingCounts has the wrong length", () => {
    const shelfMapping = { productRatings: { items: [{ ratingAverage: 4.5, totalNumberOfRatings: 10, ratingCounts: [1, 2, 3] }] } };
    expect(parseRatingsHistogram(shelfMapping)).toBeNull();
  });

  it("degrades to null when ratingCounts contains a negative/non-finite value", () => {
    const shelfMapping = { productRatings: { items: [{ ratingAverage: 4.5, totalNumberOfRatings: 10, ratingCounts: [1, -1, 3, 4, 5] }] } };
    expect(parseRatingsHistogram(shelfMapping)).toBeNull();
  });

  it("rounds floating-point counts (observed live artifact, e.g. 1991579.0000000002)", () => {
    const shelfMapping = productRatingsShelf([100, 50.00000000001, 20, 10, 5], 4.5);
    const result = parseRatingsHistogram(shelfMapping);
    expect(result?.ratingCounts[1]).toBe(50);
  });
});

describe("parseIapItems", () => {
  it("extracts textPairs from items_V3 (real Candy Crush Saga data)", () => {
    const shelfMapping = {
      information: {
        items: [
          {
            title: "In-App Purchases",
            items_V3: [
              { $kind: "textPair", leadingText: "10 Gold Bars", trailingText: "$1.99" },
              { $kind: "textPair", leadingText: "Extra Moves", trailingText: "$0.99" },
            ],
          },
        ],
      },
    };
    const items = parseIapItems(shelfMapping);
    expect(items).toEqual([
      { name: "10 Gold Bars", price: "$1.99" },
      { name: "Extra Moves", price: "$0.99" },
    ]);
  });

  it("falls back to the legacy items[0].textPairs shape when items_V3 is empty", () => {
    const shelfMapping = {
      information: {
        items: [
          {
            title: "In-App Purchases",
            items_V3: [],
            items: [{ textPairs: [["10 Gold Bars", "$1.99"]] }],
          },
        ],
      },
    };
    const items = parseIapItems(shelfMapping);
    expect(items).toEqual([{ name: "10 Gold Bars", price: "$1.99" }]);
  });

  it("filters items_V3 entries that aren't well-formed textPairs", () => {
    const shelfMapping = {
      information: {
        items: [
          {
            title: "In-App Purchases",
            items_V3: [
              { $kind: "textPair", leadingText: "Good", trailingText: "$1.99" },
              { $kind: "spacer" },
              { $kind: "textPair", leadingText: "Missing price" },
            ],
          },
        ],
      },
    };
    expect(parseIapItems(shelfMapping)).toEqual([{ name: "Good", price: "$1.99" }]);
  });

  it("returns [] when there's no In-App Purchases row (normal, most apps)", () => {
    const shelfMapping = { information: { items: [{ title: "Seller", items_V3: [] }] } };
    expect(parseIapItems(shelfMapping)).toEqual([]);
  });

  it("returns [] when the information shelf is entirely missing (shelf-missing degradation)", () => {
    expect(parseIapItems({})).toEqual([]);
  });

  it("caps at 200 items defensively", () => {
    const items_V3 = Array.from({ length: 300 }, (_, i) => ({ $kind: "textPair", leadingText: `Item ${i}`, trailingText: "$0.99" }));
    const shelfMapping = { information: { items: [{ title: "In-App Purchases", items_V3 }] } };
    expect(parseIapItems(shelfMapping)).toHaveLength(200);
  });
});

describe("parseRelatedApps", () => {
  it("parses similarItems and moreByDeveloper Lockups with independent per-shelf ranks", () => {
    const shelfMapping = {
      similarItems: {
        items: [
          { $kind: "Lockup", adamId: "111", title: "Similar One", bundleId: "com.a" },
          { $kind: "Lockup", adamId: "222", title: "Similar Two", bundleId: "com.b" },
        ],
      },
      moreByDeveloper: {
        items: [{ $kind: "Lockup", adamId: "333", title: "By Same Dev", bundleId: "com.c" }],
      },
    };
    const related = parseRelatedApps(shelfMapping);
    expect(related).toEqual([
      { appId: "111", name: "Similar One", bundleId: "com.a", source: "similar", rank: 1 },
      { appId: "222", name: "Similar Two", bundleId: "com.b", source: "similar", rank: 2 },
      { appId: "333", name: "By Same Dev", bundleId: "com.c", source: "developer", rank: 1 },
    ]);
  });

  it("skips non-Lockup entries and entries missing adamId/title", () => {
    const shelfMapping = {
      similarItems: {
        items: [
          { $kind: "Lockup", adamId: "111", title: "Good" },
          { $kind: "SomethingElse", adamId: "222", title: "Wrong kind" },
          { $kind: "Lockup", title: "No adamId" },
        ],
      },
    };
    expect(parseRelatedApps(shelfMapping)).toEqual([{ appId: "111", name: "Good", bundleId: null, source: "similar", rank: 1 }]);
  });

  it("returns [] for both shelves absent (shelf-missing degradation)", () => {
    expect(parseRelatedApps({})).toEqual([]);
  });

  it("caps each shelf at 50 entries defensively", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ $kind: "Lockup", adamId: `a${i}`, title: `App ${i}` }));
    const shelfMapping = { similarItems: { items } };
    expect(parseRelatedApps(shelfMapping)).toHaveLength(50);
  });
});

describe("parseAppPage", () => {
  it("combines all three shelves into one result", () => {
    const shelfMapping = {
      ...productRatingsShelf([10, 5, 2, 1, 1], 4.5),
      information: {
        items: [{ title: "In-App Purchases", items_V3: [{ $kind: "textPair", leadingText: "Coins", trailingText: "$0.99" }] }],
      },
      similarItems: { items: [{ $kind: "Lockup", adamId: "999", title: "Similar" }] },
    };
    const html = fixtureHtml({ appId: "42", shelfMapping });
    const result = parseAppPage(html, "42");

    expect(result.ratings).not.toBeNull();
    expect(result.iapItems).toEqual([{ name: "Coins", price: "$0.99" }]);
    expect(result.relatedApps).toEqual([{ appId: "999", name: "Similar", bundleId: null, source: "similar", rank: 1 }]);
  });

  it("degrades gracefully when every optional shelf is missing (brand-new zero-review app)", () => {
    const html = fixtureHtml({ appId: "42", shelfMapping: {} });
    const result = parseAppPage(html, "42");

    expect(result.ratings).toBeNull();
    expect(result.iapItems).toEqual([]);
    expect(result.relatedApps).toEqual([]);
  });

  it("throws AppPageParseError on a structural failure (propagated from extractServerData)", () => {
    const html = fixtureHtml({ noScript: true });
    expect(() => parseAppPage(html, "42")).toThrow(AppPageParseError);
  });

  it("throws AppPageParseError on an id mismatch (propagated from verifyIntentId)", () => {
    const html = fixtureHtml({ appId: "42", shelfMapping: {} });
    expect(() => parseAppPage(html, "99")).toThrow(AppPageParseError);
  });
});
