import { describe, expect, test } from "bun:test";
import {
  MODEL_ROUTING_DEFAULTS,
  MODEL_ROUTING_KEYS,
  modelRouteSchema,
} from "./model-routing";

describe("model-routing constants", () => {
  test("defines 8 process keys", () => {
    expect(MODEL_ROUTING_KEYS.length).toBe(8);
    expect(MODEL_ROUTING_KEYS).toContain("signal.facets");
    expect(MODEL_ROUTING_KEYS).toContain("agent-templates");
  });

  test("every key has a default route", () => {
    for (const key of MODEL_ROUTING_KEYS) {
      const def = MODEL_ROUTING_DEFAULTS[key];
      expect(typeof def.provider).toBe("string");
      expect(def.model.length).toBeGreaterThan(0);
    }
  });

  test("signal.facets default is alibaba/deepseek-v4-flash", () => {
    expect(MODEL_ROUTING_DEFAULTS["signal.facets"]).toEqual({
      provider: "alibaba",
      model: "deepseek-v4-flash",
    });
  });

  test("modelRouteSchema rejects unknown provider", () => {
    const r = modelRouteSchema.safeParse({ provider: "bogus", model: "x" });
    expect(r.success).toBe(false);
  });

  test("modelRouteSchema accepts opencode", () => {
    const r = modelRouteSchema.safeParse({ provider: "opencode", model: "deepseek-v4-flash" });
    expect(r.success).toBe(true);
  });
});
