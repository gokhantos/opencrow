import { describe, expect, it } from "bun:test";
import { buildLookupUrl, buildPortfolioUrl, chunkIds, MAX_LOOKUP_BATCH_SIZE } from "./app-lookup";

describe("chunkIds", () => {
  it("returns [] for an empty input", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("returns a single batch when input fits within size", () => {
    expect(chunkIds(["1", "2", "3"], 200)).toEqual([["1", "2", "3"]]);
  });

  it("splits into multiple batches of at most `size`, preserving order", () => {
    const ids = Array.from({ length: 5 }, (_, i) => String(i));
    expect(chunkIds(ids, 2)).toEqual([["0", "1"], ["2", "3"], ["4"]]);
  });

  it("defaults to MAX_LOOKUP_BATCH_SIZE when size is omitted", () => {
    const ids = Array.from({ length: MAX_LOOKUP_BATCH_SIZE + 1 }, (_, i) => String(i));
    const batches = chunkIds(ids);
    expect(batches.length).toBe(2);
    expect(batches[0]?.length).toBe(MAX_LOOKUP_BATCH_SIZE);
    expect(batches[1]?.length).toBe(1);
  });

  it("never returns an empty batch even for a fractional last chunk", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const batches = chunkIds(ids, 3);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
    }
    expect(batches.flat()).toEqual(ids);
  });
});

describe("buildLookupUrl", () => {
  it("joins ids with commas, URI-encoded", () => {
    expect(buildLookupUrl(["123", "456"])).toBe("https://itunes.apple.com/lookup?id=123,456");
  });

  it("handles a single id", () => {
    expect(buildLookupUrl(["789"])).toBe("https://itunes.apple.com/lookup?id=789");
  });
});

describe("buildPortfolioUrl", () => {
  it("builds an artistId lookup URL with entity=software and the given limit", () => {
    expect(buildPortfolioUrl("999", 50)).toBe(
      "https://itunes.apple.com/lookup?id=999&entity=software&limit=50",
    );
  });

  it("defaults limit to MAX_LOOKUP_BATCH_SIZE when omitted", () => {
    expect(buildPortfolioUrl("999")).toBe(
      `https://itunes.apple.com/lookup?id=999&entity=software&limit=${MAX_LOOKUP_BATCH_SIZE}`,
    );
  });
});
