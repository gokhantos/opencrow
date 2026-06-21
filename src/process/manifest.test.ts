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

  test("sige disables IPC hung-detection; web/cron keep default detection", () => {
    const config = makeConfig({
      processes: { static: [] },
      sige: { enabled: true } as OpenCrowConfig["sige"],
    });
    const specs = resolveManifest(config, []);
    const sige = specs.find((s) => s.name === "sige");
    expect(sige?.heartbeat?.enabled).toBe(false);
    expect(specs.find((s) => s.name === "web")?.heartbeat).toBeUndefined();
    expect(specs.find((s) => s.name === "cron")?.heartbeat).toBeUndefined();
  });

  test("registers ingestion with IPC hung-detection disabled by default", () => {
    // Ingestion is a first-class domain, independent of `sige`. It defaults ON
    // (config.ingestion.enabled !== false) and runs even without a sige section.
    const config = makeConfig({ processes: { static: [] } });
    const specs = resolveManifest(config, []);
    const ingestion = specs.find((s) => s.name === "ingestion");
    expect(ingestion).toBeDefined();
    expect(ingestion?.entry).toBe("src/entries/ingestion.ts");
    expect(ingestion?.heartbeat?.enabled).toBe(false);
  });

  test("omits ingestion when config.ingestion.enabled === false", () => {
    const config = makeConfig({
      processes: { static: [] },
      ingestion: { enabled: false } as OpenCrowConfig["ingestion"],
    });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "ingestion")).toBe(false);
  });

  test("includes ingestion when config.ingestion.enabled === true", () => {
    const config = makeConfig({
      processes: { static: [] },
      ingestion: { enabled: true } as OpenCrowConfig["ingestion"],
    });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "ingestion")).toBe(true);
  });

  test("runs ingestion INDEPENDENTLY of the sige idea engine", () => {
    // Decoupled: ingestion keeps the shared corpus fresh whether or not SIGE is
    // enabled (or even present). The `sige` process is gated only on sige.enabled.
    const sigeDisabled = makeConfig({
      processes: { static: [] },
      sige: { enabled: false } as OpenCrowConfig["sige"],
    });
    const sigeDisabledSpecs = resolveManifest(sigeDisabled, []);
    expect(sigeDisabledSpecs.some((s) => s.name === "sige")).toBe(false);
    expect(sigeDisabledSpecs.some((s) => s.name === "ingestion")).toBe(true);

    const sigeEnabled = makeConfig({
      processes: { static: [] },
      sige: { enabled: true } as OpenCrowConfig["sige"],
    });
    const sigeEnabledSpecs = resolveManifest(sigeEnabled, []);
    expect(sigeEnabledSpecs.some((s) => s.name === "sige")).toBe(true);
    expect(sigeEnabledSpecs.some((s) => s.name === "ingestion")).toBe(true);
  });

  test("omits ingestion when explicitly disabled even with sige enabled", () => {
    const config = makeConfig({
      processes: { static: [] },
      sige: { enabled: true } as OpenCrowConfig["sige"],
      ingestion: { enabled: false } as OpenCrowConfig["ingestion"],
    });
    const specs = resolveManifest(config, []);
    // sige itself still runs so manual sessions execute via its poll loop.
    expect(specs.some((s) => s.name === "sige")).toBe(true);
    // The autonomous extraction loop must NOT be spawned.
    expect(specs.some((s) => s.name === "ingestion")).toBe(false);
  });

  test("runs ingestion even when the sige section is absent", () => {
    const config = makeConfig({ processes: { static: [] } });
    const specs = resolveManifest(config, []);
    expect(specs.some((s) => s.name === "sige")).toBe(false);
    expect(specs.some((s) => s.name === "ingestion")).toBe(true);
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
