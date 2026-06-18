import { test, expect, describe, beforeEach } from "bun:test";
import { matchRule, regexCache, type RoutingRule } from "./routing-rules";

const rule = (
  matchType: RoutingRule["matchType"],
  matchValue: string,
): RoutingRule => ({
  id: "r1",
  channel: "test",
  matchType,
  matchValue,
  agentId: "agent-1",
  priority: 1,
  enabled: true,
  notes: null,
  createdAt: 0,
  updatedAt: 0,
});

describe("matchRule", () => {
  describe('matchType "chat"', () => {
    test("exact chatId match returns true", () => {
      expect(matchRule(rule("chat", "chat-123"), "chat-123", "user-456")).toBe(true);
    });

    test("different chatId returns false", () => {
      expect(matchRule(rule("chat", "chat-123"), "chat-999", "user-456")).toBe(false);
    });
  });

  describe('matchType "user"', () => {
    test("exact senderId match returns true", () => {
      expect(matchRule(rule("user", "user-456"), "chat-123", "user-456")).toBe(true);
    });

    test("different senderId returns false", () => {
      expect(matchRule(rule("user", "user-456"), "chat-123", "user-999")).toBe(false);
    });
  });

  describe('matchType "group"', () => {
    test("exact chatId match returns true", () => {
      expect(matchRule(rule("group", "group-789"), "group-789", "user-456")).toBe(true);
    });
  });

  describe('matchType "pattern"', () => {
    test("regex matches chatId returns true", () => {
      expect(matchRule(rule("pattern", "^chat-\\d+$"), "chat-123", "user-456")).toBe(true);
    });

    test("regex does not match chatId returns false", () => {
      expect(matchRule(rule("pattern", "^chat-\\d+$"), "room-abc", "user-456")).toBe(false);
    });

    test("invalid regex returns false without throwing", () => {
      expect(() =>
        matchRule(rule("pattern", "[invalid(regex"), "chat-123", "user-456"),
      ).not.toThrow();
      expect(matchRule(rule("pattern", "[invalid(regex"), "chat-123", "user-456")).toBe(false);
    });
  });

  describe("unknown matchType", () => {
    test("returns false", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(matchRule(rule("unknown" as any, "anything"), "chat-123", "user-456")).toBe(false);
    });
  });

  describe("pattern — length cap (> 200 chars)", () => {
    test("a pattern matchValue longer than 200 chars returns false", () => {
      const longPattern = "a".repeat(201);
      expect(matchRule(rule("pattern", longPattern), "aaa", "user-1")).toBe(false);
    });

    test("a pattern matchValue exactly at 200 chars is accepted (boundary)", () => {
      // 200 'a' characters form a valid regex — within the 200-char limit so
      // it compiles. The pattern itself requires exactly 200 'a's to match.
      const borderPattern = "a".repeat(200);
      const inputThatMatches = "a".repeat(200);
      expect(matchRule(rule("pattern", borderPattern), inputThatMatches, "user-1")).toBe(true);
    });

    test("pattern exactly 201 chars is rejected even when regex itself is valid", () => {
      // A valid regex that would match if compiled, but exceeds the 200-char cap
      const tooLong = "^" + "a?".repeat(100);
      expect(tooLong.length).toBe(201);
      expect(matchRule(rule("pattern", tooLong), "aaaa", "user-1")).toBe(false);
    });
  });

  describe("pattern — catastrophic backtracking heuristic", () => {
    test("(a+)+ is rejected by isLikelyCatastrophic and returns false", () => {
      expect(matchRule(rule("pattern", "(a+)+"), "aaaa", "user-1")).toBe(false);
    });

    test("(a+)+$ is rejected and returns false", () => {
      expect(matchRule(rule("pattern", "(a+)+$"), "aaaa", "user-1")).toBe(false);
    });

    test("([a-z]+)* is rejected (nested quantifier with *)", () => {
      expect(matchRule(rule("pattern", "([a-z]+)*"), "abc", "user-1")).toBe(false);
    });

    test("a safe pattern like (a+) without outer quantifier is NOT rejected", () => {
      // This is safe — no outer quantifier on the group
      expect(matchRule(rule("pattern", "(a+)b"), "aaab", "user-1")).toBe(true);
    });
  });

  describe("pattern — regex cache reuse", () => {
    // Clear only the cache entries we create so other tests aren't affected.
    const CACHE_TEST_PATTERN = "^cache-test-\\d+$";

    beforeEach(() => {
      regexCache.delete(CACHE_TEST_PATTERN);
    });

    test("first call compiles and stores the pattern in regexCache", () => {
      expect(regexCache.has(CACHE_TEST_PATTERN)).toBe(false);
      matchRule(rule("pattern", CACHE_TEST_PATTERN), "cache-test-42", "user-1");
      expect(regexCache.has(CACHE_TEST_PATTERN)).toBe(true);
      expect(regexCache.get(CACHE_TEST_PATTERN)).toBeInstanceOf(RegExp);
    });

    test("second call with the same pattern reuses the cached RegExp (no re-compilation)", () => {
      // First call — populates the cache
      matchRule(rule("pattern", CACHE_TEST_PATTERN), "cache-test-1", "user-1");
      const cachedAfterFirst = regexCache.get(CACHE_TEST_PATTERN);

      // Second call — must return the identical RegExp instance
      matchRule(rule("pattern", CACHE_TEST_PATTERN), "cache-test-2", "user-1");
      const cachedAfterSecond = regexCache.get(CACHE_TEST_PATTERN);

      // Same object reference proves no re-compilation
      expect(cachedAfterSecond).toBe(cachedAfterFirst);
    });

    test("a rejected (too-long) pattern is stored as null and not retried", () => {
      const longPattern = "b".repeat(201);
      regexCache.delete(longPattern);

      matchRule(rule("pattern", longPattern), "bbb", "user-1");
      // Cache must record null (rejected) — present but null
      expect(regexCache.has(longPattern)).toBe(true);
      expect(regexCache.get(longPattern)).toBeNull();

      // Second call must NOT change the cache entry (still null)
      matchRule(rule("pattern", longPattern), "bbb", "user-1");
      expect(regexCache.get(longPattern)).toBeNull();

      regexCache.delete(longPattern); // tidy up
    });
  });
});
