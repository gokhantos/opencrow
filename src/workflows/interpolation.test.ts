import { test, expect, describe } from "bun:test";
import { interpolate, interpolateObject } from "./interpolation";

describe("interpolate — single placeholder", () => {
  test("replaces placeholder with object field value", () => {
    const outputs = new Map<string, unknown>([["node1", { result: "hello" }]]);
    expect(interpolate("{{node1.result}}", outputs)).toBe("hello");
  });

  test("replaces placeholder mid-string", () => {
    const outputs = new Map<string, unknown>([["n", { name: "world" }]]);
    expect(interpolate("Hello {{n.name}}!", outputs)).toBe("Hello world!");
  });
});

describe("interpolate — multiple placeholders", () => {
  test("replaces all placeholders in one template", () => {
    const outputs = new Map<string, unknown>([
      ["a", { x: "foo" }],
      ["b", { y: "bar" }],
    ]);
    expect(interpolate("{{a.x}} and {{b.y}}", outputs)).toBe("foo and bar");
  });

  test("replaces repeated placeholder correctly", () => {
    const outputs = new Map<string, unknown>([["n", { v: "ok" }]]);
    expect(interpolate("{{n.v}}-{{n.v}}", outputs)).toBe("ok-ok");
  });
});

describe("interpolate — missing node ID", () => {
  test("returns empty string when node ID is not in outputs", () => {
    const outputs = new Map<string, unknown>();
    expect(interpolate("{{missing.field}}", outputs)).toBe("");
  });

  test("returns empty string when node ID maps to null", () => {
    const outputs = new Map<string, unknown>([["n", null]]);
    expect(interpolate("{{n.field}}", outputs)).toBe("");
  });

  test("returns empty string when node ID maps to undefined", () => {
    const outputs = new Map<string, unknown>([["n", undefined]]);
    expect(interpolate("{{n.field}}", outputs)).toBe("");
  });
});

describe("interpolate — string value", () => {
  test("field 'output' returns the raw string", () => {
    const outputs = new Map<string, unknown>([["n", "raw text"]]);
    expect(interpolate("{{n.output}}", outputs)).toBe("raw text");
  });

  test("field other than 'output' returns empty string", () => {
    const outputs = new Map<string, unknown>([["n", "raw text"]]);
    expect(interpolate("{{n.something}}", outputs)).toBe("");
  });

  test("field 'result' (not 'output') returns empty string", () => {
    const outputs = new Map<string, unknown>([["n", "some value"]]);
    expect(interpolate("{{n.result}}", outputs)).toBe("");
  });
});

describe("interpolate — object value field lookup", () => {
  test("returns string field value directly", () => {
    const outputs = new Map<string, unknown>([["n", { title: "My Title" }]]);
    expect(interpolate("{{n.title}}", outputs)).toBe("My Title");
  });

  test("returns empty string for undefined field on object", () => {
    const outputs = new Map<string, unknown>([["n", { other: "x" }]]);
    expect(interpolate("{{n.missing}}", outputs)).toBe("");
  });

  test("returns empty string for null field on object", () => {
    const outputs = new Map<string, unknown>([["n", { title: null }]]);
    expect(interpolate("{{n.title}}", outputs)).toBe("");
  });

  test("JSON.stringifies field value that is an object", () => {
    const outputs = new Map<string, unknown>([
      ["n", { meta: { a: 1, b: 2 } }],
    ]);
    expect(interpolate("{{n.meta}}", outputs)).toBe(JSON.stringify({ a: 1, b: 2 }));
  });

  test("JSON.stringifies field value that is an array", () => {
    const outputs = new Map<string, unknown>([["n", { items: [1, 2, 3] }]]);
    expect(interpolate("{{n.items}}", outputs)).toBe("[1,2,3]");
  });

  test("JSON.stringifies field value that is a number", () => {
    // number field: not string, not object — falls through to String(value) on the *outer* value,
    // but here the field value is a number so typeof fieldVal !== "string" → JSON.stringify
    const outputs = new Map<string, unknown>([["n", { count: 42 }]]);
    expect(interpolate("{{n.count}}", outputs)).toBe("42");
  });
});

describe("interpolate — no placeholders", () => {
  test("returns template unchanged when no placeholders present", () => {
    const outputs = new Map<string, unknown>();
    expect(interpolate("no placeholders here", outputs)).toBe("no placeholders here");
  });

  test("returns empty string template unchanged", () => {
    const outputs = new Map<string, unknown>();
    expect(interpolate("", outputs)).toBe("");
  });
});

describe("interpolateObject — nested objects", () => {
  test("interpolates string values in a flat object", () => {
    const outputs = new Map<string, unknown>([["n", { val: "hi" }]]);
    const result = interpolateObject({ greeting: "{{n.val}}" }, outputs);
    expect(result).toEqual({ greeting: "hi" });
  });

  test("interpolates string values in a nested object", () => {
    const outputs = new Map<string, unknown>([["n", { val: "deep" }]]);
    const result = interpolateObject({ outer: { inner: "{{n.val}}" } }, outputs);
    expect(result).toEqual({ outer: { inner: "deep" } });
  });

  test("interpolates multiple keys independently", () => {
    const outputs = new Map<string, unknown>([
      ["a", { x: "A" }],
      ["b", { y: "B" }],
    ]);
    const result = interpolateObject({ first: "{{a.x}}", second: "{{b.y}}" }, outputs);
    expect(result).toEqual({ first: "A", second: "B" });
  });
});

describe("interpolateObject — arrays", () => {
  test("interpolates string elements in an array", () => {
    const outputs = new Map<string, unknown>([["n", { v: "x" }]]);
    const result = interpolateObject(["{{n.v}}", "{{n.v}}"], outputs);
    expect(result).toEqual(["x", "x"]);
  });

  test("interpolates strings inside objects nested within an array", () => {
    const outputs = new Map<string, unknown>([["n", { label: "item" }]]);
    const result = interpolateObject([{ name: "{{n.label}}" }], outputs);
    expect(result).toEqual([{ name: "item" }]);
  });
});

describe("interpolateObject — non-string passthrough", () => {
  test("passes through numbers unchanged", () => {
    const outputs = new Map<string, unknown>();
    expect(interpolateObject(42, outputs)).toBe(42);
  });

  test("passes through booleans unchanged", () => {
    const outputs = new Map<string, unknown>();
    expect(interpolateObject(true, outputs)).toBe(true);
  });

  test("passes through null unchanged", () => {
    const outputs = new Map<string, unknown>();
    expect(interpolateObject(null, outputs)).toBeNull();
  });

  test("passes through number values in object without modification", () => {
    const outputs = new Map<string, unknown>();
    const result = interpolateObject({ count: 7 }, outputs);
    expect(result).toEqual({ count: 7 });
  });
});

describe("interpolateObject — top-level string", () => {
  test("interpolates a bare string", () => {
    const outputs = new Map<string, unknown>([["n", { v: "direct" }]]);
    expect(interpolateObject("{{n.v}}", outputs)).toBe("direct");
  });
});
