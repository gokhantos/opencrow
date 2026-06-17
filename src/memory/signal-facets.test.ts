import { describe, expect, test } from "bun:test";
import {
  parseSignalFacets,
  parseSignalFacetsBatch,
  shouldRankSignal,
  signalFacetsSchema,
} from "./signal-facets";

describe("signalFacetsSchema", () => {
  test("applies defaults for an empty object", () => {
    const result = signalFacetsSchema.parse({});
    expect(result).toEqual({
      problemType: "",
      targetAudience: "",
      jtbd: "",
      sentiment: "neutral",
      entities: [],
      importance: "low",
      relevanceToIdeas: 0.5,
      category: "",
    });
  });

  test("rejects an invalid sentiment value", () => {
    const result = signalFacetsSchema.safeParse({ sentiment: "angry" });
    expect(result.success).toBe(false);
  });

  test("rejects an invalid importance bucket", () => {
    const result = signalFacetsSchema.safeParse({ importance: "critical" });
    expect(result.success).toBe(false);
  });

  test("rejects a relevanceToIdeas outside [0,1]", () => {
    expect(signalFacetsSchema.safeParse({ relevanceToIdeas: 1.5 }).success).toBe(
      false,
    );
    expect(signalFacetsSchema.safeParse({ relevanceToIdeas: -0.1 }).success).toBe(
      false,
    );
  });

  test("caps entities at 20 and strings at their max length", () => {
    const tooMany = signalFacetsSchema.safeParse({
      entities: Array.from({ length: 21 }, (_, i) => `e${i}`),
    });
    expect(tooMany.success).toBe(false);
  });
});

describe("parseSignalFacets", () => {
  test("parses a clean JSON object including ranking fields", () => {
    const text = `{"problemType":"slow builds","targetAudience":"iOS devs","jtbd":"ship faster","sentiment":"negative","entities":["Xcode","Bun"],"importance":"high","relevanceToIdeas":0.8,"category":"devtools"}`;
    expect(parseSignalFacets(text)).toEqual({
      problemType: "slow builds",
      targetAudience: "iOS devs",
      jtbd: "ship faster",
      sentiment: "negative",
      entities: ["Xcode", "Bun"],
      importance: "high",
      relevanceToIdeas: 0.8,
      category: "devtools",
    });
  });

  test("defaults ranking fields when absent", () => {
    const result = parseSignalFacets(`{"problemType":"x"}`);
    expect(result?.importance).toBe("low");
    expect(result?.relevanceToIdeas).toBe(0.5);
    expect(result?.category).toBe("");
  });

  test("extracts JSON embedded in surrounding prose", () => {
    const text = `Here you go:\n{"problemType":"x","sentiment":"positive"}\nThanks!`;
    const result = parseSignalFacets(text);
    expect(result?.problemType).toBe("x");
    expect(result?.sentiment).toBe("positive");
    expect(result?.entities).toEqual([]);
  });

  test("returns null when no JSON object is present", () => {
    expect(parseSignalFacets("no json here")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseSignalFacets("{ broken: ,}")).toBeNull();
  });

  test("normalizes unknown sentiment to neutral", () => {
    const result = parseSignalFacets(`{"sentiment":"furious"}`);
    expect(result?.sentiment).toBe("neutral");
  });

  test("lowercases and accepts uppercased sentiment", () => {
    const result = parseSignalFacets(`{"sentiment":"NEGATIVE"}`);
    expect(result?.sentiment).toBe("negative");
  });

  test("normalizes unknown importance to low", () => {
    const result = parseSignalFacets(`{"importance":"extreme"}`);
    expect(result?.importance).toBe("low");
  });

  test("lowercases and accepts uppercased importance", () => {
    const result = parseSignalFacets(`{"importance":"HIGH"}`);
    expect(result?.importance).toBe("high");
  });

  test("clamps out-of-range relevanceToIdeas into [0,1]", () => {
    expect(parseSignalFacets(`{"relevanceToIdeas":2}`)?.relevanceToIdeas).toBe(1);
    expect(parseSignalFacets(`{"relevanceToIdeas":-3}`)?.relevanceToIdeas).toBe(
      0,
    );
  });

  test("coerces a string relevanceToIdeas and defaults non-numeric", () => {
    expect(parseSignalFacets(`{"relevanceToIdeas":"0.42"}`)?.relevanceToIdeas).toBe(
      0.42,
    );
    expect(parseSignalFacets(`{"relevanceToIdeas":"abc"}`)?.relevanceToIdeas).toBe(
      0.5,
    );
    expect(parseSignalFacets(`{"relevanceToIdeas":null}`)?.relevanceToIdeas).toBe(
      0.5,
    );
  });

  test("coerces non-string scalar fields to empty strings", () => {
    const result = parseSignalFacets(
      `{"problemType":123,"targetAudience":null,"jtbd":true,"category":42}`,
    );
    expect(result?.problemType).toBe("");
    expect(result?.targetAudience).toBe("");
    expect(result?.jtbd).toBe("");
    expect(result?.category).toBe("");
  });

  test("filters non-string and blank entities, trims the rest", () => {
    const result = parseSignalFacets(
      `{"entities":["  Stripe ", 42, "", null, "Plaid"]}`,
    );
    expect(result?.entities).toEqual(["Stripe", "Plaid"]);
  });

  test("trims whitespace from string fields", () => {
    const result = parseSignalFacets(`{"problemType":"  padded  "}`);
    expect(result?.problemType).toBe("padded");
  });
});

describe("parseSignalFacetsBatch", () => {
  test("maps each expected id to its parsed facets", () => {
    const text = `{
      "a": {"problemType":"slow CI","importance":"high","relevanceToIdeas":0.9,"category":"devtools"},
      "b": {"problemType":"meme","importance":"noise","relevanceToIdeas":0.0}
    }`;
    const result = parseSignalFacetsBatch(text, ["a", "b"]);
    expect(result.get("a")?.problemType).toBe("slow CI");
    expect(result.get("a")?.importance).toBe("high");
    expect(result.get("a")?.relevanceToIdeas).toBe(0.9);
    expect(result.get("b")?.importance).toBe("noise");
    expect(result.get("b")?.relevanceToIdeas).toBe(0);
  });

  test("returns null for ids missing from the model output", () => {
    const text = `{"a": {"problemType":"x"}}`;
    const result = parseSignalFacetsBatch(text, ["a", "b"]);
    expect(result.get("a")?.problemType).toBe("x");
    expect(result.get("b")).toBeNull();
  });

  test("ignores extra ids the model invented", () => {
    const text = `{"a": {"problemType":"x"}, "ghost": {"problemType":"y"}}`;
    const result = parseSignalFacetsBatch(text, ["a"]);
    expect([...result.keys()]).toEqual(["a"]);
    expect(result.get("a")?.problemType).toBe("x");
  });

  test("maps every id to null when no JSON object is present", () => {
    const result = parseSignalFacetsBatch("nothing here", ["a", "b"]);
    expect(result.get("a")).toBeNull();
    expect(result.get("b")).toBeNull();
  });

  test("maps every id to null on malformed JSON", () => {
    const result = parseSignalFacetsBatch("{ broken: ,}", ["a"]);
    expect(result.get("a")).toBeNull();
  });

  test("maps an id to null when its entry is explicitly null", () => {
    const text = `{"a": null, "b": {"problemType":"ok"}}`;
    const result = parseSignalFacetsBatch(text, ["a", "b"]);
    expect(result.get("a")).toBeNull();
    expect(result.get("b")?.problemType).toBe("ok");
  });

  test("maps an id to null when its entry fails validation", () => {
    const text = `{"a": "not an object", "b": {"problemType":"ok"}}`;
    const result = parseSignalFacetsBatch(text, ["a", "b"]);
    expect(result.get("a")).toBeNull();
    expect(result.get("b")?.problemType).toBe("ok");
  });

  test("returns a null-seeded map for an empty id list", () => {
    const result = parseSignalFacetsBatch(`{"a": {"problemType":"x"}}`, []);
    expect(result.size).toBe(0);
  });
});

describe("shouldRankSignal", () => {
  test("ranks everything by default (no thresholds)", () => {
    expect(shouldRankSignal()).toBe(true);
    expect(shouldRankSignal({})).toBe(true);
    expect(shouldRankSignal({ engagement: 0, velocity: 0 })).toBe(true);
  });

  test("ranks everything when thresholds are all zero", () => {
    expect(
      shouldRankSignal(
        { engagement: 0 },
        { minEngagement: 0, minVelocity: 0 },
      ),
    ).toBe(true);
  });

  test("passes when engagement meets the floor", () => {
    expect(shouldRankSignal({ engagement: 50 }, { minEngagement: 10 })).toBe(
      true,
    );
  });

  test("fails when engagement is below the floor and is the only datum", () => {
    expect(shouldRankSignal({ engagement: 3 }, { minEngagement: 10 })).toBe(
      false,
    );
  });

  test("passes on velocity even when engagement is below floor", () => {
    expect(
      shouldRankSignal(
        { engagement: 1, velocity: 5 },
        { minEngagement: 10, minVelocity: 2 },
      ),
    ).toBe(true);
  });

  test("is permissive when no metrics are present but a floor is set", () => {
    expect(shouldRankSignal({}, { minEngagement: 100 })).toBe(true);
  });

  test("ranks a high-velocity item with unknown engagement", () => {
    expect(shouldRankSignal({ velocity: 20 }, { minVelocity: 5 })).toBe(true);
  });

  test("rejects a low-velocity item with unknown engagement", () => {
    expect(shouldRankSignal({ velocity: 1 }, { minVelocity: 5 })).toBe(false);
  });
});
