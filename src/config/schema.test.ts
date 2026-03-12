import { test, expect, describe } from "bun:test";
import {
  retryConfigSchema,
  compactionConfigSchema,
  toolFilterSchema,
  agentDefinitionSchema,
  toolsConfigSchema,
  webConfigSchema,
  cronConfigSchema,
  modelParamsSchema,
  opencrowConfigSchema,
} from "./schema";

describe("retryConfigSchema", () => {
  test("valid full input parses correctly", () => {
    const result = retryConfigSchema.parse({
      attempts: 5,
      minDelayMs: 200,
      maxDelayMs: 5000,
      jitter: 0.1,
    });
    expect(result.attempts).toBe(5);
    expect(result.minDelayMs).toBe(200);
    expect(result.maxDelayMs).toBe(5000);
    expect(result.jitter).toBe(0.1);
  });

  test("defaults are applied when empty object passed", () => {
    const result = retryConfigSchema.parse({});
    expect(result.attempts).toBe(3);
    expect(result.minDelayMs).toBe(500);
    expect(result.maxDelayMs).toBe(30000);
    expect(result.jitter).toBe(0.15);
  });

  test("attempts must be >= 1", () => {
    expect(() => retryConfigSchema.parse({ attempts: 0 })).toThrow();
  });

  test("minDelayMs must be >= 100", () => {
    expect(() => retryConfigSchema.parse({ minDelayMs: 99 })).toThrow();
  });

  test("maxDelayMs must be >= 1000", () => {
    expect(() => retryConfigSchema.parse({ maxDelayMs: 999 })).toThrow();
  });
});

describe("compactionConfigSchema", () => {
  test("defaults are applied correctly when empty object passed", () => {
    const result = compactionConfigSchema.parse({});
    expect(result.maxContextTokens).toBe(180_000);
    expect(result.summaryMaxTokens).toBe(2048);
    expect(result.stripToolResultsAfterTurns).toBe(3);
  });

  test("valid input parses correctly", () => {
    const result = compactionConfigSchema.parse({
      maxContextTokens: 100_000,
      targetHistoryTokens: 40_000,
      summaryMaxTokens: 1024,
      stripToolResultsAfterTurns: 5,
    });
    expect(result.maxContextTokens).toBe(100_000);
    expect(result.targetHistoryTokens).toBe(40_000);
    expect(result.summaryMaxTokens).toBe(1024);
    expect(result.stripToolResultsAfterTurns).toBe(5);
  });
});

describe("toolFilterSchema", () => {
  test("default mode is 'all'", () => {
    const result = toolFilterSchema.parse({});
    expect(result.mode).toBe("all");
  });

  test("valid mode 'allowlist' parses", () => {
    const result = toolFilterSchema.parse({ mode: "allowlist" });
    expect(result.mode).toBe("allowlist");
  });

  test("valid mode 'blocklist' parses", () => {
    const result = toolFilterSchema.parse({ mode: "blocklist" });
    expect(result.mode).toBe("blocklist");
  });

  test("invalid mode is rejected", () => {
    expect(() => toolFilterSchema.parse({ mode: "whitelist" })).toThrow();
  });
});

describe("agentDefinitionSchema", () => {
  test("minimal valid input parses correctly", () => {
    const result = agentDefinitionSchema.parse({ id: "test", name: "Test" });
    expect(result.id).toBe("test");
    expect(result.name).toBe("Test");
  });

  test("empty id is rejected", () => {
    expect(() => agentDefinitionSchema.parse({ id: "", name: "Test" })).toThrow();
  });

  test("empty name is rejected", () => {
    expect(() => agentDefinitionSchema.parse({ id: "test", name: "" })).toThrow();
  });

  test("valid provider 'openrouter' parses", () => {
    const result = agentDefinitionSchema.parse({
      id: "test",
      name: "Test",
      provider: "openrouter",
    });
    expect(result.provider).toBe("openrouter");
  });

  test("valid provider 'agent-sdk' parses", () => {
    const result = agentDefinitionSchema.parse({
      id: "test",
      name: "Test",
      provider: "agent-sdk",
    });
    expect(result.provider).toBe("agent-sdk");
  });

  test("invalid provider is rejected", () => {
    expect(() =>
      agentDefinitionSchema.parse({ id: "test", name: "Test", provider: "openai" }),
    ).toThrow();
  });

  test("skills defaults to empty array", () => {
    const result = agentDefinitionSchema.parse({ id: "test", name: "Test" });
    expect(result.skills).toEqual([]);
  });
});

describe("toolsConfigSchema", () => {
  test("defaults are applied correctly", () => {
    const result = toolsConfigSchema.parse({});
    expect(result.allowedDirectories).toEqual(["$HOME"]);
    expect(result.blockedCommands).toEqual([]);
    expect(result.maxBashTimeout).toBe(600_000);
    expect(result.maxFileSize).toBe(10_485_760);
    expect(result.maxIterations).toBe(200);
  });

  test("maxBashTimeout accepts a valid number", () => {
    const result = toolsConfigSchema.parse({ maxBashTimeout: 120_000 });
    expect(result.maxBashTimeout).toBe(120_000);
  });
});

describe("webConfigSchema", () => {
  test("default port is 48080", () => {
    const result = webConfigSchema.parse({});
    expect(result.port).toBe(48080);
  });

  test("port 0 is rejected (out of range)", () => {
    expect(() => webConfigSchema.parse({ port: 0 })).toThrow();
  });

  test("port 70000 is rejected (out of range)", () => {
    expect(() => webConfigSchema.parse({ port: 70000 })).toThrow();
  });
});

describe("cronConfigSchema", () => {
  test("defaults are applied correctly", () => {
    const result = cronConfigSchema.parse({});
    expect(result.defaultTimeoutSeconds).toBe(300);
    expect(result.tickIntervalMs).toBe(10000);
    expect(result.maxConcurrency).toBe(4);
  });

  test("tickIntervalMs minimum is 1000", () => {
    expect(() => cronConfigSchema.parse({ tickIntervalMs: 999 })).toThrow();
  });
});

describe("modelParamsSchema", () => {
  test("default thinkingMode is 'enabled'", () => {
    const result = modelParamsSchema.parse({});
    expect(result.thinkingMode).toBe("enabled");
  });

  test("default thinkingBudget is 128000", () => {
    const result = modelParamsSchema.parse({});
    expect(result.thinkingBudget).toBe(128_000);
  });

  test("thinkingBudget minimum is 1024", () => {
    expect(() => modelParamsSchema.parse({ thinkingBudget: 1023 })).toThrow();
  });
});

describe("opencrowConfigSchema", () => {
  test("empty object {} parses with all defaults filled", () => {
    const result = opencrowConfigSchema.parse({});
    expect(result.logLevel).toBe("info");
    expect(result.web.port).toBe(48080);
    expect(result.cron.tickIntervalMs).toBe(10000);
    expect(result.tools.maxBashTimeout).toBe(600_000);
    expect(result.agents).toEqual([]);
  });

  test("logLevel default is 'info'", () => {
    const result = opencrowConfigSchema.parse({});
    expect(result.logLevel).toBe("info");
  });

  test("invalid logLevel is rejected", () => {
    expect(() => opencrowConfigSchema.parse({ logLevel: "verbose" })).toThrow();
  });
});
