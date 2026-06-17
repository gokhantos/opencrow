import { describe, expect, test } from "bun:test";
import {
  parseSignalFacets,
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
    });
  });

  test("rejects an invalid sentiment value", () => {
    const result = signalFacetsSchema.safeParse({ sentiment: "angry" });
    expect(result.success).toBe(false);
  });

  test("caps entities at 20 and strings at their max length", () => {
    const tooMany = signalFacetsSchema.safeParse({
      entities: Array.from({ length: 21 }, (_, i) => `e${i}`),
    });
    expect(tooMany.success).toBe(false);
  });
});

describe("parseSignalFacets", () => {
  test("parses a clean JSON object", () => {
    const text = `{"problemType":"slow builds","targetAudience":"iOS devs","jtbd":"ship faster","sentiment":"negative","entities":["Xcode","Bun"]}`;
    expect(parseSignalFacets(text)).toEqual({
      problemType: "slow builds",
      targetAudience: "iOS devs",
      jtbd: "ship faster",
      sentiment: "negative",
      entities: ["Xcode", "Bun"],
    });
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

  test("coerces non-string scalar fields to empty strings", () => {
    const result = parseSignalFacets(
      `{"problemType":123,"targetAudience":null,"jtbd":true}`,
    );
    expect(result?.problemType).toBe("");
    expect(result?.targetAudience).toBe("");
    expect(result?.jtbd).toBe("");
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
