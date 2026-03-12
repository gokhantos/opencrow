import { describe, test, expect } from "bun:test";
import { createRateLimiter } from "./rate-limiter";

describe("createRateLimiter", () => {
  test("allows requests up to burst capacity", () => {
    const limiter = createRateLimiter({ maxTokens: 3, refillPerSecond: 0 });
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(true);
    limiter.dispose();
  });

  test("rejects requests beyond burst capacity", () => {
    const limiter = createRateLimiter({ maxTokens: 2, refillPerSecond: 0 });
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(false);
    limiter.dispose();
  });

  test("tracks different keys independently", () => {
    const limiter = createRateLimiter({ maxTokens: 1, refillPerSecond: 0 });
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user2")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(false);
    expect(limiter.tryConsume("user2")).toBe(false);
    limiter.dispose();
  });

  test("new key starts with full burst capacity", () => {
    const limiter = createRateLimiter({ maxTokens: 5, refillPerSecond: 0 });
    // Drain user1
    for (let i = 0; i < 5; i++) limiter.tryConsume("user1");
    expect(limiter.tryConsume("user1")).toBe(false);
    // user2 is brand new — should have full 5 tokens
    expect(limiter.tryConsume("user2")).toBe(true);
    limiter.dispose();
  });

  test("refills tokens over time", async () => {
    // 10 tokens/sec => 1 token per 100ms
    const limiter = createRateLimiter({ maxTokens: 2, refillPerSecond: 10 });
    // Drain all tokens
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(true);
    expect(limiter.tryConsume("user1")).toBe(false);

    // Wait 150ms — should have refilled ~1.5 tokens (at least 1)
    await new Promise((r) => setTimeout(r, 150));

    expect(limiter.tryConsume("user1")).toBe(true);
    limiter.dispose();
  });

  test("refill does not exceed maxTokens", async () => {
    // Very fast refill
    const limiter = createRateLimiter({ maxTokens: 3, refillPerSecond: 1000 });
    limiter.tryConsume("user1"); // consume 1
    await new Promise((r) => setTimeout(r, 50));
    // Even after refill, tokens capped at 3, so 3 more requests are allowed
    let allowed = 0;
    for (let i = 0; i < 4; i++) {
      if (limiter.tryConsume("user1")) allowed++;
    }
    expect(allowed).toBe(3);
    limiter.dispose();
  });

  test("dispose clears all state without throwing", () => {
    const limiter = createRateLimiter({ maxTokens: 5, refillPerSecond: 1 });
    limiter.tryConsume("user1");
    expect(() => limiter.dispose()).not.toThrow();
  });
});
