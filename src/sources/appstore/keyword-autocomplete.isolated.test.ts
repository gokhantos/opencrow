import { describe, expect, it, mock, beforeEach } from "bun:test";

/**
 * Realistic Apple MZSearchHints plist XML sample: an <array> of <dict>
 * entries, each carrying a <key>term</key><string>...</string> pair (plus
 * an unrelated <key>kind</key> pair, mirroring the real payload shape).
 * One entry has mixed case + irregular whitespace to exercise
 * normalization; the parser must extract only the term strings.
 */
const HINTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>kind</key>
		<string>Application</string>
		<key>term</key>
		<string>budget tracker free</string>
	</dict>
	<dict>
		<key>kind</key>
		<string>Application</string>
		<key>term</key>
		<string>  Budget   Tracker App </string>
	</dict>
	<dict>
		<key>kind</key>
		<string>Application</string>
		<key>term</key>
		<string>expense manager</string>
	</dict>
</array>
</plist>`;

const WINNER = { keyword: "budget tracker", genreZone: "finance" };

describe("expandFromWinners", () => {
  let upsertCalls: unknown[][];
  let keywordsExistArg: readonly string[] | null;
  let existingSet: Set<string>;
  let fetchedUrls: string[];
  let fetchResponse: { ok: boolean; status?: number; text: () => Promise<string> };

  beforeEach(() => {
    upsertCalls = [];
    keywordsExistArg = null;
    existingSet = new Set();
    fetchedUrls = [];
    fetchResponse = { ok: true, text: async () => HINTS_XML };

    mock.module("./keyword-store", () => ({
      getWinnerKeywords: async (_minOpportunity: number, _limit: number) => [WINNER],
      keywordsExist: async (keywords: readonly string[]) => {
        keywordsExistArg = keywords;
        return existingSet;
      },
      upsertKeywords: async (rows: unknown[]) => {
        upsertCalls.push(rows);
        return rows.length;
      },
    }));

    mock.module("../shared/ssrf-safe-fetch", () => ({
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return fetchResponse;
      },
    }));
  });

  it("parses hints, upserts new terms with source:autocomplete and the winner's genreZone", async () => {
    const { expandFromWinners } = await import("./keyword-autocomplete");
    const added = await expandFromWinners({ minOpportunity: 0.4, perSeed: 5 });

    expect(added).toBe(3);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain(encodeURIComponent("budget tracker"));

    expect(upsertCalls).toHaveLength(1);
    const rows = upsertCalls[0] as Array<{ keyword: string; genreZone: string; source: string }>;
    expect(rows).toHaveLength(3);
    const keywords = rows.map((r) => r.keyword).sort();
    expect(keywords).toEqual(["budget tracker app", "budget tracker free", "expense manager"]);
    for (const row of rows) {
      expect(row.source).toBe("autocomplete");
      expect(row.genreZone).toBe("finance");
    }
  });

  it("bounds suggestions to perSeed per winner", async () => {
    const { expandFromWinners } = await import("./keyword-autocomplete");
    const added = await expandFromWinners({ minOpportunity: 0.4, perSeed: 2 });

    expect(added).toBe(2);
    const rows = upsertCalls[0] as Array<{ keyword: string }>;
    expect(rows).toHaveLength(2);
  });

  it("does not count an already-existing keyword as new", async () => {
    existingSet = new Set(["expense manager"]);

    const { expandFromWinners } = await import("./keyword-autocomplete");
    const added = await expandFromWinners({ minOpportunity: 0.4, perSeed: 5 });

    expect(added).toBe(2);
    expect(keywordsExistArg).not.toBeNull();
    const rows = upsertCalls[0] as Array<{ keyword: string }>;
    expect(rows.map((r) => r.keyword)).not.toContain("expense manager");
  });

  it("treats an unexpected/malformed response body as zero hints and never throws", async () => {
    fetchResponse = { ok: true, text: async () => "not xml at all, just garbage {}" };

    const { expandFromWinners } = await import("./keyword-autocomplete");
    const added = await expandFromWinners({ minOpportunity: 0.4, perSeed: 5 });

    expect(added).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("skips a winner whose fetch fails, without throwing", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      ssrfSafeFetch: async () => {
        throw new Error("network failure");
      },
    }));

    const { expandFromWinners } = await import("./keyword-autocomplete");
    const added = await expandFromWinners({ minOpportunity: 0.4, perSeed: 5 });

    expect(added).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("returns 0 and skips fetching when there are no winners", async () => {
    mock.module("./keyword-store", () => ({
      getWinnerKeywords: async () => [],
      keywordsExist: async () => new Set(),
      upsertKeywords: async (rows: unknown[]) => rows.length,
    }));

    const { expandFromWinners } = await import("./keyword-autocomplete");
    const added = await expandFromWinners({ minOpportunity: 0.4, perSeed: 5 });

    expect(added).toBe(0);
    expect(fetchedUrls).toHaveLength(0);
  });
});
