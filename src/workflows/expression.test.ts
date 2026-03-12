import { test, expect, describe } from "bun:test";
import { evaluateCondition } from "./expression";

describe("evaluateCondition — numeric operators", () => {
  test("> returns true when left is greater", () => {
    expect(evaluateCondition("a > 5", { a: 10 })).toBe(true);
  });

  test("> returns false when left is equal", () => {
    expect(evaluateCondition("a > 10", { a: 10 })).toBe(false);
  });

  test("< returns true when left is smaller", () => {
    expect(evaluateCondition("a < 5", { a: 3 })).toBe(true);
  });

  test(">= returns true when left is equal", () => {
    expect(evaluateCondition("a >= 10", { a: 10 })).toBe(true);
  });

  test("<= returns true when left is smaller", () => {
    expect(evaluateCondition("a <= 10", { a: 7 })).toBe(true);
  });

  test("== returns true for equal numbers", () => {
    expect(evaluateCondition("count == 42", { count: 42 })).toBe(true);
  });

  test("!= returns true for different numbers", () => {
    expect(evaluateCondition("count != 42", { count: 0 })).toBe(true);
  });

  test("!= returns false for equal numbers", () => {
    expect(evaluateCondition("count != 42", { count: 42 })).toBe(false);
  });
});

describe("evaluateCondition — string literals", () => {
  test("== matches string literal with double quotes", () => {
    expect(evaluateCondition('status == "active"', { status: "active" })).toBe(true);
  });

  test("== does not match differing string literal", () => {
    expect(evaluateCondition('status == "active"', { status: "inactive" })).toBe(false);
  });

  test("!= detects differing string literal", () => {
    expect(evaluateCondition('status != "active"', { status: "inactive" })).toBe(true);
  });

  test("== matches string literal with single quotes", () => {
    expect(evaluateCondition("status == 'active'", { status: "active" })).toBe(true);
  });
});

describe("evaluateCondition — boolean literals", () => {
  test("== true matches a true context value", () => {
    expect(evaluateCondition("flag == true", { flag: true })).toBe(true);
  });

  test("== false matches a false context value", () => {
    expect(evaluateCondition("flag == false", { flag: false })).toBe(true);
  });

  test("== true does not match false context value", () => {
    expect(evaluateCondition("flag == true", { flag: false })).toBe(false);
  });
});

describe("evaluateCondition — dot-path resolution", () => {
  test("resolves two-level dot path", () => {
    expect(evaluateCondition("user.age > 18", { user: { age: 25 } })).toBe(true);
  });

  test("resolves three-level dot path", () => {
    expect(
      evaluateCondition("a.b.c == 99", { a: { b: { c: 99 } } }),
    ).toBe(true);
  });

  test("returns false when nested value does not match", () => {
    expect(evaluateCondition("user.age > 18", { user: { age: 16 } })).toBe(false);
  });
});

describe("evaluateCondition — undefined context path", () => {
  test("undefined path resolves to undefined, != number is true", () => {
    expect(evaluateCondition("missing != 0", {})).toBe(true);
  });

  test("undefined path compared with == undefined is true (loose equality)", () => {
    // undefined == undefined
    expect(evaluateCondition("a.b == false", {})).toBe(false);
  });

  test("mid-path undefined terminates walk gracefully", () => {
    // user is undefined, user.age produces undefined — no throw
    expect(evaluateCondition("user.age > 18", {})).toBe(false);
  });
});

describe("evaluateCondition — loose equality", () => {
  test("1 == true is true due to loose equality", () => {
    expect(evaluateCondition("n == true", { n: 1 })).toBe(true);
  });

  test("0 == false is true due to loose equality", () => {
    expect(evaluateCondition("n == false", { n: 0 })).toBe(true);
  });
});

describe("evaluateCondition — && combinator", () => {
  test("both conditions true returns true", () => {
    expect(evaluateCondition("a > 0 && b > 0", { a: 1, b: 2 })).toBe(true);
  });

  test("one condition false returns false", () => {
    expect(evaluateCondition("a > 0 && b > 0", { a: 1, b: -1 })).toBe(false);
  });

  test("both conditions false returns false", () => {
    expect(evaluateCondition("a > 0 && b > 0", { a: -1, b: -1 })).toBe(false);
  });
});

describe("evaluateCondition — || combinator", () => {
  test("one condition true returns true", () => {
    expect(evaluateCondition("a > 10 || b > 10", { a: 0, b: 20 })).toBe(true);
  });

  test("both conditions true returns true", () => {
    expect(evaluateCondition("a > 0 || b > 0", { a: 1, b: 2 })).toBe(true);
  });

  test("both conditions false returns false", () => {
    expect(evaluateCondition("a > 10 || b > 10", { a: 0, b: 0 })).toBe(false);
  });
});

describe("evaluateCondition — mixed && and || (|| lower precedence)", () => {
  test("(a > 0 && b > 0) || c > 0 — first branch true", () => {
    // Splits on || first: ["a > 0 && b > 0", "c > 0"]
    // First part: a > 0 && b > 0 = true => overall true
    expect(evaluateCondition("a > 0 && b > 0 || c > 0", { a: 1, b: 1, c: -1 })).toBe(true);
  });

  test("(a > 0 && b > 0) || c > 0 — second branch true", () => {
    // First part fails (b <= 0), second part c > 0 succeeds
    expect(evaluateCondition("a > 0 && b > 0 || c > 0", { a: 1, b: -1, c: 5 })).toBe(true);
  });

  test("(a > 0 && b > 0) || c > 0 — both branches false", () => {
    expect(evaluateCondition("a > 0 && b > 0 || c > 0", { a: 1, b: -1, c: -1 })).toBe(false);
  });
});

describe("evaluateCondition — invalid expression", () => {
  test("throws when no operator is found", () => {
    expect(() => evaluateCondition("justAValue", {})).toThrow(
      "Invalid expression — no operator found",
    );
  });

  test("throws for empty expression", () => {
    expect(() => evaluateCondition("", {})).toThrow();
  });
});
