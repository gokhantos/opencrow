import { describe, expect, it } from "bun:test";
import {
  ageDaysFromReleaseDate,
  detectMetaEvents,
  isoToEpochSeconds,
  type AppMetaPrevious,
} from "./app-meta-types";
import type { LookupApp } from "./app-lookup";

function lookupApp(overrides: Partial<LookupApp> = {}): LookupApp {
  return {
    id: "1",
    name: "Sample",
    reviews: 100,
    rating: 4.5,
    releaseDate: "2024-01-01T00:00:00Z",
    currentVersionReleaseDate: "2024-06-01T00:00:00Z",
    version: "1.0.0",
    price: 0,
    formattedPrice: "Free",
    genreId: "6000",
    genreName: "Business",
    artistId: "artist-1",
    artistName: "Acme",
    bundleId: "com.acme.sample",
    trackViewUrl: "https://apps.apple.com/app/id1",
    artworkUrl: "https://example.com/icon.png",
    ...overrides,
  };
}

function previous(overrides: Partial<AppMetaPrevious> = {}): AppMetaPrevious {
  return {
    ratingCount: 1000,
    price: 0,
    artistId: "artist-1",
    delistedAt: null,
    ...overrides,
  };
}

describe("isoToEpochSeconds", () => {
  it("converts a valid ISO 8601 date to epoch seconds", () => {
    expect(isoToEpochSeconds("2024-01-01T00:00:00Z")).toBe(1704067200);
  });

  it("returns null for an empty string", () => {
    expect(isoToEpochSeconds("")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(isoToEpochSeconds("not a date")).toBeNull();
  });
});

describe("ageDaysFromReleaseDate", () => {
  it("computes whole days between releaseDate and now", () => {
    const now = 1704067200 + 10 * 86_400; // +10 days
    expect(ageDaysFromReleaseDate("2024-01-01T00:00:00Z", now)).toBe(10);
  });

  it("returns null for a missing/unparseable release date", () => {
    expect(ageDaysFromReleaseDate("", 1704067200)).toBeNull();
    expect(ageDaysFromReleaseDate("garbage", 1704067200)).toBeNull();
  });

  it("clamps to 0 rather than going negative for a future release date", () => {
    expect(ageDaysFromReleaseDate("2099-01-01T00:00:00Z", 1704067200)).toBe(0);
  });
});

describe("detectMetaEvents", () => {
  it("returns [] when previous is null (first-ever enrichment — nothing to diff)", () => {
    expect(detectMetaEvents(null, lookupApp())).toEqual([]);
    expect(detectMetaEvents(null, null)).toEqual([]);
  });

  it("fires a single 'delisted' event on the null-current transition", () => {
    const events = detectMetaEvents(previous(), null);
    expect(events).toEqual([{ eventType: "delisted", oldValue: null, newValue: null }]);
  });

  it("does not re-fire 'delisted' when previous was already delisted", () => {
    const events = detectMetaEvents(previous({ delistedAt: 12345 }), null);
    expect(events).toEqual([]);
  });

  it("fires 'relisted' when previous was delisted and current is found", () => {
    const events = detectMetaEvents(previous({ delistedAt: 12345 }), lookupApp());
    expect(events.some((e) => e.eventType === "relisted")).toBe(true);
  });

  it("does not fire 'relisted' for an ordinary (never-delisted) re-enrichment", () => {
    const events = detectMetaEvents(previous(), lookupApp());
    expect(events.some((e) => e.eventType === "relisted")).toBe(false);
  });

  it("fires 'price_change' when price differs", () => {
    const events = detectMetaEvents(previous({ price: 0 }), lookupApp({ price: 4.99 }));
    expect(events).toContainEqual({
      eventType: "price_change",
      oldValue: "0",
      newValue: "4.99",
    });
  });

  it("does not fire 'price_change' when price is unchanged", () => {
    const events = detectMetaEvents(previous({ price: 4.99 }), lookupApp({ price: 4.99 }));
    expect(events.some((e) => e.eventType === "price_change")).toBe(false);
  });

  it("fires 'developer_change' when artistId differs", () => {
    const events = detectMetaEvents(
      previous({ artistId: "artist-1" }),
      lookupApp({ artistId: "artist-2" }),
    );
    expect(events).toContainEqual({
      eventType: "developer_change",
      oldValue: "artist-1",
      newValue: "artist-2",
    });
  });

  it("does not fire 'developer_change' when current artistId is empty (unknown, not a real change)", () => {
    const events = detectMetaEvents(previous({ artistId: "artist-1" }), lookupApp({ artistId: "" }));
    expect(events.some((e) => e.eventType === "developer_change")).toBe(false);
  });

  describe("rating_spike — 50%/100-floor boundary", () => {
    it("fires when BOTH the absolute floor (>=100) and relative bar (>=50%) are cleared", () => {
      // 1000 -> 1600: +600 absolute (>=100), +60% relative (>=50%)
      const events = detectMetaEvents(
        previous({ ratingCount: 1000 }),
        lookupApp({ reviews: 1600 }),
      );
      expect(events).toContainEqual({
        eventType: "rating_spike",
        oldValue: "1000",
        newValue: "1600",
      });
    });

    it("does NOT fire when the relative bar is cleared but the absolute floor is not", () => {
      // 100 -> 199: +99 absolute (< 100), +99% relative (>= 50%)
      const events = detectMetaEvents(
        previous({ ratingCount: 100 }),
        lookupApp({ reviews: 199 }),
      );
      expect(events.some((e) => e.eventType === "rating_spike")).toBe(false);
    });

    it("does NOT fire when the absolute floor is cleared but the relative bar is not", () => {
      // 100,000 -> 100,150: +150 absolute (>= 100), +0.15% relative (< 50%)
      const events = detectMetaEvents(
        previous({ ratingCount: 100_000 }),
        lookupApp({ reviews: 100_150 }),
      );
      expect(events.some((e) => e.eventType === "rating_spike")).toBe(false);
    });

    it("fires at exactly the boundary (+100 absolute, +50% relative)", () => {
      // 200 -> 300: +100 absolute (>=100), +50% relative (>=50%)
      const events = detectMetaEvents(
        previous({ ratingCount: 200 }),
        lookupApp({ reviews: 300 }),
      );
      expect(events.some((e) => e.eventType === "rating_spike")).toBe(true);
    });

    it("does not fire for a review-count decrease", () => {
      const events = detectMetaEvents(
        previous({ ratingCount: 1000 }),
        lookupApp({ reviews: 500 }),
      );
      expect(events.some((e) => e.eventType === "rating_spike")).toBe(false);
    });

    it("uses a floor of 1 for the relative denominator when previous ratingCount is 0", () => {
      // 0 -> 150: +150 absolute (>=100), 150/1 = 15000% relative (>=50%)
      const events = detectMetaEvents(previous({ ratingCount: 0 }), lookupApp({ reviews: 150 }));
      expect(events.some((e) => e.eventType === "rating_spike")).toBe(true);
    });
  });

  it("can fire multiple independent events in one diff", () => {
    const events = detectMetaEvents(
      previous({ ratingCount: 1000, price: 0, artistId: "artist-1" }),
      lookupApp({ reviews: 2000, price: 2.99, artistId: "artist-2" }),
    );
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual(["developer_change", "price_change", "rating_spike"]);
  });
});
