import { test, expect, describe } from "bun:test";
import { resolveManifest } from "./manifest";
import type { OpenCrowConfig } from "../config/schema";
import type { ResolvedAgent } from "../agents/types";

const defaultAgentProcesses = { entry: "src/entries/agent.ts", restartPolicy: "always" as const };
const defaultScraperProcesses = { entry: "src/entries/scraper.ts", restartPolicy: "always" as const, scraperIds: [] as string[] };

type ConfigOverrides = Omit<Partial<OpenCrowConfig>, "processes"> & {
  processes?: Partial<OpenCrowConfig["processes"]> | undefined;
};

function makeConfig(overrides: ConfigOverrides = {}): OpenCrowConfig {
  const defaultProcesses = {
    static: [],
    agentProcesses: defaultAgentProcesses,
    scraperProcesses: defaultScraperProcesses,
  };
  const base: OpenCrowConfig = {
    agent: {
      model: "claude-opus-4-6",
      systemPrompt: "test",
      retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.15 },
      compaction: {
        maxContextTokens: 180000,
        targetHistoryTokens: 60000,
        summaryMaxTokens: 2048,
        stripToolResultsAfterTurns: 3,
      },
    },
    agents: [],
    channels: {
      telegram: { allowedUserIds: [] },
    },
    web: { port: 48080, host: "0.0.0.0" },
    internalApi: { port: 48081, host: "127.0.0.1" },
    tools: {
      allowedDirectories: ["$HOME"],
      blockedCommands: [],
      maxBashTimeout: 600000,
      maxFileSize: 10485760,
      maxIterations: 200,
    },
    cron: { defaultTimeoutSeconds: 300, tickIntervalMs: 10000 },
    postgres: { url: "postgres://test:test@localhost/test", max: 20 },
    logLevel: "info",
    processes: defaultProcesses,
    ...overrides,
    ...(overrides.processes !== undefined
      ? { processes: overrides.processes as OpenCrowConfig["processes"] }
      : {}),
  } as OpenCrowConfig;
  return base;
}

function makeAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    default: false,
    provider: "agent-sdk",
    model: "claude-opus-4-6",
    systemPrompt: "test prompt",
    toolFilter: { mode: "all", tools: [] },
    subagents: { allowAgents: [], maxChildren: 5 },
    mcpServers: {},
    skills: [],
    category: "coding" as const,
    ...overrides,
  };
}

describe("resolveManifest", () => {
  test("returns empty when processes not configured", () => {
    const config = makeConfig({ processes: undefined });
    expect(resolveManifest(config, [])).toEqual([]);
  });

  test("includes static processes", () => {
    const config = makeConfig({
      processes: {
        static: [
          {
            name: "custom",
            entry: "custom.ts",
            restartPolicy: "always",
            maxRestarts: 10,
            restartWindowSec: 300,
          },
        ],
      },
    });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "custom")).toBe(true);
  });

  test("includes builtin cron process", () => {
    const config = makeConfig({ processes: { static: [] } });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "cron")).toBe(true);
  });

  test("always includes web process", () => {
    const config = makeConfig({ processes: { static: [] } });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "web")).toBe(true);
  });

  test("includes market process when market section present", () => {
    const config = makeConfig({
      market: {
        questdbIlpUrl: "",
        questdbHttpUrl: "",
        exchange: "binance",
        marketTypes: [],
        symbols: [],
      },
      processes: { static: [] },
    });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "market")).toBe(true);
  });

  test("excludes market process when market section absent", () => {
    const config = makeConfig({ market: undefined, processes: { static: [] } });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "market")).toBe(false);
  });

  test("spawns agent processes for agents with telegram tokens", () => {
    const config = makeConfig({
      processes: {
        static: [],
        agentProcesses: { entry: "src/entries/agent.ts", restartPolicy: "always" },
      },
    });
    const agents = [
      makeAgent({ id: "bot1", telegramBotToken: "token-123" }),
      makeAgent({ id: "bot2" }),
    ];
    const specs = resolveManifest(config, agents);
    expect(specs.some((s) => s.name === "agent:bot1")).toBe(true);
    expect(specs.some((s) => s.name === "agent:bot2")).toBe(false);
  });

  test("spawns agent process for WhatsApp default agent", () => {
    const config = makeConfig({
      channels: {
        telegram: { allowedUserIds: [] },
        whatsapp: { allowedNumbers: [], allowedGroups: [], defaultAgent: "wa-agent" },
      },
      processes: {
        static: [],
        agentProcesses: { entry: "src/entries/agent.ts", restartPolicy: "always" },
      },
    });
    const agents = [makeAgent({ id: "wa-agent" })];
    const specs = resolveManifest(config, agents);
    expect(specs.some((s) => s.name === "agent:wa-agent")).toBe(true);
  });

  test("skips agent processes when agentProcesses section absent", () => {
    const config = makeConfig({ processes: { static: [] } });
    const agents = [makeAgent({ id: "bot1", telegramBotToken: "token-123" })];
    const specs = resolveManifest(config, agents);
    expect(specs.some((s) => s.name === "agent:bot1")).toBe(false);
  });

  test("spawns scraper processes", () => {
    const config = makeConfig({
      processes: {
        static: [],
        scraperProcesses: {
          entry: "src/entries/scraper.ts",
          restartPolicy: "always",
          scraperIds: ["hackernews", "reddit"],
        },
      },
    });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "scraper:hackernews")).toBe(true);
    expect(specs.some((s) => s.name === "scraper:reddit")).toBe(true);
  });

  test("skips scraper processes when scraperProcesses section absent", () => {
    const config = makeConfig({ processes: { static: [] } });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name.startsWith("scraper:"))).toBe(false);
  });

  test("scraper processes have correct env", () => {
    const config = makeConfig({
      processes: {
        static: [],
        scraperProcesses: {
          entry: "src/entries/scraper.ts",
          restartPolicy: "always",
          scraperIds: ["github"],
        },
      },
    });
    const specs = resolveManifest(config, []);
    const github = specs.find((s) => s.name === "scraper:github");
    expect(github?.env?.OPENCROW_SCRAPER_ID).toBe("github");
  });

  test("agent processes have correct env", () => {
    const config = makeConfig({
      processes: {
        static: [],
        agentProcesses: { entry: "src/entries/agent.ts", restartPolicy: "always" },
      },
    });
    const agents = [makeAgent({ id: "my-bot", telegramBotToken: "tok" })];
    const specs = resolveManifest(config, agents);
    const bot = specs.find((s) => s.name === "agent:my-bot");
    expect(bot?.env?.OPENCROW_AGENT_ID).toBe("my-bot");
  });
});
