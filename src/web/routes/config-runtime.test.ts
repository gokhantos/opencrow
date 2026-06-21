/**
 * Unit tests for the runtime-config route's pure validation/transform logic.
 *
 * Covers the zod partial schemas (accept partials, reject unknown/invalid keys)
 * and the effective-value mappers (config subtree -> scheme key names). No DB.
 *
 * Lane: *.test.ts — run with `bun run test:unit`
 */
import { describe, it, expect } from "bun:test";
import { z } from "zod";

// Re-declare the schemas under test by importing the route module's exported
// mappers and re-creating the validation shape they enforce. The mappers are
// exported; the schemas are internal, so we assert behaviour through small
// local mirrors kept in lockstep with config-runtime.ts.
import { effectiveServer, effectiveSandbox } from "./config-runtime";

const serverOverrideSchema = z
  .object({
    webHost: z.string().min(1).max(253),
    webPort: z.number().int().min(1).max(65535),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    browserEnabled: z.boolean(),
  })
  .partial()
  .strict();

const sandboxOverrideSchema = z
  .object({
    toolsSandbox: z.enum(["off", "best-effort", "required"]),
    devToolsAllowNetwork: z.boolean(),
    allowUnsandboxedDevTools: z.boolean(),
  })
  .partial()
  .strict();

describe("serverOverrideSchema", () => {
  it("accepts an empty patch", () => {
    expect(serverOverrideSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    const r = serverOverrideSchema.safeParse({ webPort: 8080 });
    expect(r.success).toBe(true);
  });

  it("accepts a full body", () => {
    const r = serverOverrideSchema.safeParse({
      webHost: "0.0.0.0",
      webPort: 48080,
      logLevel: "debug",
      browserEnabled: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an out-of-range port", () => {
    expect(serverOverrideSchema.safeParse({ webPort: 70000 }).success).toBe(false);
    expect(serverOverrideSchema.safeParse({ webPort: 0 }).success).toBe(false);
  });

  it("rejects a non-integer port", () => {
    expect(serverOverrideSchema.safeParse({ webPort: 80.5 }).success).toBe(false);
  });

  it("rejects an unknown log level", () => {
    expect(serverOverrideSchema.safeParse({ logLevel: "trace" }).success).toBe(false);
  });

  it("rejects an empty host", () => {
    expect(serverOverrideSchema.safeParse({ webHost: "" }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = serverOverrideSchema.safeParse({ webPort: 8080, bogus: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects a wrong-typed browserEnabled", () => {
    expect(serverOverrideSchema.safeParse({ browserEnabled: "yes" }).success).toBe(false);
  });
});

describe("sandboxOverrideSchema", () => {
  it("accepts an empty patch", () => {
    expect(sandboxOverrideSchema.safeParse({}).success).toBe(true);
  });

  it("accepts the three valid sandbox modes", () => {
    for (const mode of ["off", "best-effort", "required"]) {
      expect(sandboxOverrideSchema.safeParse({ toolsSandbox: mode }).success).toBe(true);
    }
  });

  it("rejects an unknown sandbox mode", () => {
    expect(sandboxOverrideSchema.safeParse({ toolsSandbox: "loose" }).success).toBe(false);
  });

  it("accepts the dangerous boolean flags", () => {
    const r = sandboxOverrideSchema.safeParse({
      devToolsAllowNetwork: true,
      allowUnsandboxedDevTools: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      sandboxOverrideSchema.safeParse({ toolsSandbox: "off", extra: true }).success,
    ).toBe(false);
  });

  it("rejects wrong-typed flags", () => {
    expect(
      sandboxOverrideSchema.safeParse({ devToolsAllowNetwork: "yes" }).success,
    ).toBe(false);
  });
});

describe("effectiveServer", () => {
  it("maps the config subtree onto scheme key names", () => {
    const config = {
      web: { host: "1.2.3.4", port: 9090 },
      logLevel: "warn" as const,
      browser: { enabled: true },
    };
    // The mapper only reads the four fields; cast through unknown to satisfy
    // the broad config type without constructing a full OpenCrowConfig.
    const out = effectiveServer(config as never);
    expect(out).toEqual({
      webHost: "1.2.3.4",
      webPort: 9090,
      logLevel: "warn",
      browserEnabled: true,
    });
  });
});

describe("effectiveSandbox", () => {
  it("maps the tools subtree onto scheme key names", () => {
    const config = {
      tools: {
        sandbox: "required" as const,
        devToolsAllowNetwork: true,
        allowUnsandboxedDevTools: false,
      },
    };
    const out = effectiveSandbox(config as never);
    expect(out).toEqual({
      toolsSandbox: "required",
      devToolsAllowNetwork: true,
      allowUnsandboxedDevTools: false,
    });
  });
});
