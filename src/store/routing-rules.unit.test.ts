import { test, expect, describe } from "bun:test";
import { matchRule, type RoutingRule } from "./routing-rules";

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
});
