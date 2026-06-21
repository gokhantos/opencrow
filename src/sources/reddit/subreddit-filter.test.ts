/**
 * Unit tests for subreddit-filter.ts — denylist/allowlist logic and SSRF guard.
 * Lane: unit (*.test.ts). No DB, no network.
 */

import { describe, expect, it } from "bun:test";
import {
  isSafeSubredditName,
  sanitizeSubredditList,
  isDenylisted,
  buildDenylistSet,
  resolveSubredditsToScrape,
  filterByDenylist,
} from "./subreddit-filter";
import { redditCorpusConfigSchema } from "../../config/schema";

// ─── isSafeSubredditName ─────────────────────────────────────────────────────

describe("isSafeSubredditName", () => {
  it("accepts alphanumeric names", () => {
    expect(isSafeSubredditName("freelance")).toBe(true);
    expect(isSafeSubredditName("smallbusiness")).toBe(true);
    expect(isSafeSubredditName("ADHD")).toBe(true);
    expect(isSafeSubredditName("SomebodyMakeThis")).toBe(true);
    expect(isSafeSubredditName("AppIdeas")).toBe(true);
  });

  it("accepts names with underscores", () => {
    expect(isSafeSubredditName("small_business")).toBe(true);
    expect(isSafeSubredditName("legal_advice")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isSafeSubredditName("")).toBe(false);
  });

  it("rejects names with slashes (SSRF path injection)", () => {
    expect(isSafeSubredditName("foo/bar")).toBe(false);
    expect(isSafeSubredditName("../../etc/passwd")).toBe(false);
  });

  it("rejects names with dots", () => {
    expect(isSafeSubredditName("foo.bar")).toBe(false);
    expect(isSafeSubredditName("evil.com")).toBe(false);
  });

  it("rejects names with query/fragment characters", () => {
    expect(isSafeSubredditName("foo?bar=1")).toBe(false);
    expect(isSafeSubredditName("foo#baz")).toBe(false);
    expect(isSafeSubredditName("foo%20bar")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isSafeSubredditName("foo bar")).toBe(false);
  });

  it("rejects names exceeding 50 chars", () => {
    expect(isSafeSubredditName("a".repeat(51))).toBe(false);
    expect(isSafeSubredditName("a".repeat(50))).toBe(true);
  });

  it("rejects names with hyphens (conservative guard)", () => {
    // Reddit allows hyphens but we err conservative for SSRF safety.
    // Callers can relax this if needed — the denylist + allowlist are controlled.
    expect(isSafeSubredditName("real-estate")).toBe(false);
  });
});

// ─── sanitizeSubredditList ───────────────────────────────────────────────────

describe("sanitizeSubredditList", () => {
  it("keeps safe names and drops unsafe ones", () => {
    const input = ["freelance", "foo/bar", "smallbusiness", "evil.com"];
    const result = sanitizeSubredditList(input);
    expect(result).toEqual(["freelance", "smallbusiness"]);
  });

  it("returns empty array for empty input", () => {
    expect(sanitizeSubredditList([])).toEqual([]);
  });

  it("returns empty array when all names are unsafe", () => {
    expect(sanitizeSubredditList(["foo/bar", "evil.com", "x y"])).toEqual([]);
  });
});

// ─── buildDenylistSet + isDenylisted ─────────────────────────────────────────

describe("buildDenylistSet", () => {
  it("lower-cases all entries for case-insensitive matching", () => {
    const set = buildDenylistSet(["ClaudeCode", "ChatGPT", "VIBECODING"]);
    expect(set.has("claudecode")).toBe(true);
    expect(set.has("chatgpt")).toBe(true);
    expect(set.has("vibecoding")).toBe(true);
  });

  it("drops unsafe names silently", () => {
    const set = buildDenylistSet(["ClaudeCode", "foo/bar", "evil.com"]);
    expect(set.size).toBe(1);
    expect(set.has("claudecode")).toBe(true);
  });
});

describe("isDenylisted", () => {
  const denylistSet = buildDenylistSet([
    "ClaudeCode",
    "ChatGPT",
    "vibecoding",
    "Bitcoin",
  ]);

  it("matches exact lower-case names", () => {
    expect(isDenylisted("vibecoding", denylistSet)).toBe(true);
  });

  it("matches mixed-case corpus variants (the key bug to prevent)", () => {
    // Corpus has "ClaudeCode", "claudecode", "CLAUDECODE" — all must be caught.
    expect(isDenylisted("ClaudeCode", denylistSet)).toBe(true);
    expect(isDenylisted("claudecode", denylistSet)).toBe(true);
    expect(isDenylisted("CLAUDECODE", denylistSet)).toBe(true);
    expect(isDenylisted("CHATGPT", denylistSet)).toBe(true);
    expect(isDenylisted("Bitcoin", denylistSet)).toBe(true);
    expect(isDenylisted("BITCOIN", denylistSet)).toBe(true);
  });

  it("does not match legitimate subs", () => {
    expect(isDenylisted("freelance", denylistSet)).toBe(false);
    expect(isDenylisted("smallbusiness", denylistSet)).toBe(false);
    expect(isDenylisted("Entrepreneur", denylistSet)).toBe(false);
  });
});

// ─── resolveSubredditsToScrape ───────────────────────────────────────────────

describe("resolveSubredditsToScrape", () => {
  const baseConfig = redditCorpusConfigSchema.parse({
    allowlist: ["freelance", "smallbusiness", "Entrepreneur"],
    denylist: ["ClaudeCode", "vibecoding", "Bitcoin"],
    includeSubscriptions: false,
  });

  it("returns the curated allowlist when subscriptions not included", () => {
    const result = resolveSubredditsToScrape(baseConfig, [
      "ClaudeCode",
      "vibecoding",
      "personalfinance",
    ]);
    // subscriptions ignored (includeSubscriptions: false)
    expect(result).toContain("freelance");
    expect(result).toContain("smallbusiness");
    expect(result).toContain("Entrepreneur");
    expect(result).not.toContain("ClaudeCode");
    expect(result).not.toContain("personalfinance");
  });

  it("merges subscriptions into allowlist when includeSubscriptions is true", () => {
    const cfg = { ...baseConfig, includeSubscriptions: true };
    const result = resolveSubredditsToScrape(cfg, ["personalfinance", "gamedev"]);
    expect(result).toContain("freelance");
    expect(result).toContain("personalfinance");
    expect(result).toContain("gamedev");
  });

  it("drops denylisted subs from subscriptions when includeSubscriptions is true", () => {
    const cfg = { ...baseConfig, includeSubscriptions: true };
    const result = resolveSubredditsToScrape(cfg, [
      "personalfinance",
      "ClaudeCode", // on denylist
      "vibecoding", // on denylist
    ]);
    expect(result).toContain("personalfinance");
    expect(result).not.toContain("ClaudeCode");
    expect(result).not.toContain("vibecoding");
  });

  it("does not duplicate subs present in both allowlist and subscriptions", () => {
    const cfg = { ...baseConfig, includeSubscriptions: true };
    const result = resolveSubredditsToScrape(cfg, ["freelance", "gamedev"]);
    const freelanceCount = result.filter((s) => s === "freelance").length;
    expect(freelanceCount).toBe(1);
  });

  it("drops denylisted subs from the allowlist itself", () => {
    const cfg = redditCorpusConfigSchema.parse({
      // allowlist contains a sub that is also in denylist — denylist wins
      allowlist: ["freelance", "ClaudeCode"],
      denylist: ["ClaudeCode"],
      includeSubscriptions: false,
    });
    const result = resolveSubredditsToScrape(cfg, []);
    expect(result).toContain("freelance");
    expect(result).not.toContain("ClaudeCode");
  });

  it("drops unsafe subreddit names from allowlist", () => {
    const cfg = redditCorpusConfigSchema.parse({
      allowlist: ["freelance", "foo/bar", "evil.com"],
      denylist: [],
      includeSubscriptions: false,
    });
    const result = resolveSubredditsToScrape(cfg, []);
    expect(result).toContain("freelance");
    expect(result).not.toContain("foo/bar");
    expect(result).not.toContain("evil.com");
  });

  it("drops unsafe subreddit names from subscriptions", () => {
    const cfg = redditCorpusConfigSchema.parse({
      allowlist: [],
      denylist: [],
      includeSubscriptions: true,
    });
    const result = resolveSubredditsToScrape(cfg, ["freelance", "foo/bar"]);
    expect(result).toContain("freelance");
    expect(result).not.toContain("foo/bar");
  });
});

// ─── filterByDenylist ────────────────────────────────────────────────────────

describe("filterByDenylist", () => {
  const denylistSet = buildDenylistSet(["ClaudeCode", "vibecoding"]);

  it("removes denylisted subs and keeps the rest", () => {
    const input = ["freelance", "ClaudeCode", "smallbusiness", "vibecoding"];
    const result = filterByDenylist(input, denylistSet);
    expect(result).toEqual(["freelance", "smallbusiness"]);
  });

  it("handles mixed-case subreddit names", () => {
    const input = ["CLAUDECODE", "freelance", "VibeCoding"];
    const result = filterByDenylist(input, denylistSet);
    expect(result).toEqual(["freelance"]);
  });

  it("returns all items when none are denylisted", () => {
    const input = ["freelance", "smallbusiness"];
    const result = filterByDenylist(input, denylistSet);
    expect(result).toEqual(["freelance", "smallbusiness"]);
  });

  it("returns empty array when all are denylisted", () => {
    const input = ["ClaudeCode", "vibecoding"];
    const result = filterByDenylist(input, denylistSet);
    expect(result).toEqual([]);
  });
});

// ─── Config schema defaults ──────────────────────────────────────────────────

describe("redditCorpusConfigSchema defaults", () => {
  it("parses with no overrides and produces non-empty allowlist and denylist", () => {
    const cfg = redditCorpusConfigSchema.parse({});
    expect(cfg.allowlist.length).toBeGreaterThan(0);
    expect(cfg.denylist.length).toBeGreaterThan(0);
    expect(cfg.includeSubscriptions).toBe(false);
  });

  it("default allowlist contains expected end-user subs", () => {
    const cfg = redditCorpusConfigSchema.parse({});
    expect(cfg.allowlist).toContain("freelance");
    expect(cfg.allowlist).toContain("smallbusiness");
    expect(cfg.allowlist).toContain("Entrepreneur");
    expect(cfg.allowlist).toContain("sysadmin");
    expect(cfg.allowlist).toContain("legaladvice");
    expect(cfg.allowlist).toContain("SomebodyMakeThis");
  });

  it("default denylist contains all major echo-chamber subs", () => {
    const cfg = redditCorpusConfigSchema.parse({});
    const lower = cfg.denylist.map((s) => s.toLowerCase());
    expect(lower).toContain("claudecode");
    expect(lower).toContain("vibecoding");
    expect(lower).toContain("chatgpt");
    expect(lower).toContain("anthropic");
    expect(lower).toContain("deepseek");
    expect(lower).toContain("bitcoin");
    expect(lower).toContain("ethereum");
    expect(lower).toContain("cryptocurrency");
    expect(lower).toContain("cryptotechnology");
  });

  it("default denylist does NOT appear in default allowlist", () => {
    const cfg = redditCorpusConfigSchema.parse({});
    const denySet = new Set(cfg.denylist.map((s) => s.toLowerCase()));
    for (const sub of cfg.allowlist) {
      expect(denySet.has(sub.toLowerCase())).toBe(false);
    }
  });

  it("allows overriding allowlist and denylist", () => {
    const cfg = redditCorpusConfigSchema.parse({
      allowlist: ["mycustomsub"],
      denylist: ["spammysub"],
      includeSubscriptions: true,
    });
    expect(cfg.allowlist).toEqual(["mycustomsub"]);
    expect(cfg.denylist).toEqual(["spammysub"]);
    expect(cfg.includeSubscriptions).toBe(true);
  });
});
