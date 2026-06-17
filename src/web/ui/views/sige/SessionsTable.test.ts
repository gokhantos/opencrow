import { describe, expect, test } from "bun:test";
import { AUTONOMOUS_SEED_LABEL, truncate } from "./SessionsTable";

// Regression: autonomous (origin="auto") sessions have seedInput === null.
// truncate() must not crash on null (previously did: "can't access property
// 'length', $ is null" → dashboard error boundary).
describe("truncate", () => {
  test("renders the autonomous label for null/undefined/empty seeds", () => {
    expect(truncate(null, 120)).toBe(AUTONOMOUS_SEED_LABEL);
    expect(truncate(undefined, 120)).toBe(AUTONOMOUS_SEED_LABEL);
    expect(truncate("", 120)).toBe(AUTONOMOUS_SEED_LABEL);
  });

  test("returns short strings unchanged", () => {
    expect(truncate("AI tools for small law firms", 120)).toBe(
      "AI tools for small law firms",
    );
  });

  test("truncates long strings with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = truncate(long, 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(11);
  });
});
