import { describe, expect, test } from "bun:test";
import { resolveGeneratorRoute } from "./generator-route";
import type { ModelRoute } from "../../store/model-routing";

const ROUTE: ModelRoute = { provider: "alibaba", model: "glm-5.2" };

describe("resolveGeneratorRoute", () => {
  test("uses the route for BOTH when config has neither", () => {
    expect(resolveGeneratorRoute({}, ROUTE)).toEqual(ROUTE);
  });

  test("uses the route for BOTH when config sets only model (the bug)", () => {
    // Regression: a bare config.model (e.g. the old hardcoded
    // claude-sonnet-4-6) must NOT be mixed with the route's alibaba provider —
    // that sent claude-sonnet-4-6 to Alibaba → "Model not exist".
    expect(resolveGeneratorRoute({ model: "claude-sonnet-4-6" }, ROUTE)).toEqual(ROUTE);
  });

  test("uses the route for BOTH when config sets only provider", () => {
    expect(resolveGeneratorRoute({ provider: "anthropic" }, ROUTE)).toEqual(ROUTE);
  });

  test("honors an explicit (model + provider) pair from config", () => {
    const pair = resolveGeneratorRoute(
      { model: "claude-sonnet-4-6", provider: "anthropic" },
      ROUTE,
    );
    expect(pair).toEqual({ model: "claude-sonnet-4-6", provider: "anthropic" });
  });
});
