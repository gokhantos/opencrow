import { z } from "zod";
import { marketPipelineConfigSchema } from "../sources/markets/config";

export const telegramConfigSchema = z.object({
  botToken: z.string().optional(),
  allowedUserIds: z.array(z.number()).default([]),
});

export const whatsappConfigSchema = z.object({
  phoneNumber: z.string().optional(),
  allowedNumbers: z.array(z.string()).default([]),
  allowedGroups: z.array(z.string()).default([]),
  defaultAgent: z.string().default("opencrow"),
});

export const retryConfigSchema = z
  .object({
    attempts: z.number().int().min(1).default(3),
    minDelayMs: z.number().int().min(100).default(500),
    maxDelayMs: z.number().int().min(1000).default(30000),
    jitter: z.number().min(0).max(1).default(0.15),
  })
  .default({ attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.15 });

export const compactionConfigSchema = z
  .object({
    maxContextTokens: z.number().int().default(180_000),
    targetHistoryTokens: z.number().int().default(80_000),
    summaryMaxTokens: z.number().int().default(2048),
    stripToolResultsAfterTurns: z.number().int().default(3),
  })
  .default({
    maxContextTokens: 180_000,
    targetHistoryTokens: 60_000,
    summaryMaxTokens: 2048,
    stripToolResultsAfterTurns: 3,
  });

export const failoverConfigSchema = z
  .object({
    fallbackModels: z.array(z.string()).default([]),
    tokenCooldownMs: z.number().int().default(60_000),
  })
  .default({ fallbackModels: [], tokenCooldownMs: 60_000 })
  .optional();

export const agentConfigSchema = z.object({
  model: z.string().default("claude-opus-4-6"),
  systemPrompt: z
    .string()
    .default(
      "You are OpenCrow, a helpful personal AI assistant. Be concise and direct.",
    ),
  retry: retryConfigSchema,
  compaction: compactionConfigSchema,
  failover: failoverConfigSchema,
});

export const toolFilterSchema = z.object({
  mode: z.enum(["all", "allowlist", "blocklist"]).default("all"),
  tools: z.array(z.string()).default([]),
});

export const subagentConfigSchema = z.object({
  allowAgents: z.array(z.string()).default([]),
  maxChildren: z.number().int().min(1).default(5),
});

export const modelParamsSchema = z.object({
  /** Thinking mode: 'adaptive' (model decides), 'enabled' (fixed budget), 'disabled' */
  thinkingMode: z.enum(["adaptive", "enabled", "disabled"]).default("enabled"),
  /** Fixed thinking budget in tokens (only used when thinkingMode='enabled') */
  thinkingBudget: z.number().int().min(1024).default(128_000),
  /** Effort level: how hard the model works on reasoning */
  effort: z.enum(["low", "medium", "high", "max"]).default("max"),
  /** Enable 1M context window beta (Sonnet 4/4.5 only) */
  extendedContext: z.boolean().default(false),
  /** Max spend per query in USD */
  maxBudgetUsd: z.number().min(0.01).optional(),
});

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().optional(),
  provider: z.enum(["openrouter", "agent-sdk", "alibaba"]).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().int().min(1).optional(),
  modelParams: modelParamsSchema.optional(),
  toolFilter: toolFilterSchema.optional(),
  subagents: subagentConfigSchema.optional(),
  mcpServers: z
    .object({
      browser: z.boolean().optional(),
      github: z.boolean().optional(),
      context7: z.boolean().optional(),
      sequentialThinking: z.boolean().optional(),
      dbhub: z.boolean().optional(),
      filesystem: z.boolean().optional(),
      git: z.boolean().optional(),
      qdrant: z.boolean().optional(),
      braveSearch: z.boolean().optional(),
      firecrawl: z.boolean().optional(),
      serena: z.boolean().optional(),
    })
    .optional(),
  hooks: z
    .object({
      auditLog: z.boolean().optional(),
      notifications: z.boolean().optional(),
      sessionTracking: z.boolean().optional(),
      subagentTracking: z.boolean().optional(),
      promptLogging: z.boolean().optional(),
      dangerousCommandBlocking: z.boolean().optional(),
    })
    .optional(),
  telegramBotToken: z.string().optional(),
  reasoning: z.boolean().optional(),
  stateless: z.boolean().optional(),
  maxInputLength: z.number().int().min(1).optional(),
  maxHistoryMessages: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(64).optional(),
  /** Number of own assistant messages to keep in group history (rest are dropped). */
  keepAssistantMessages: z.number().int().min(0).optional(),
  skills: z.array(z.string()).default([]),
});

export const toolsConfigSchema = z.object({
  allowedDirectories: z.array(z.string()).default(["$HOME"]),
  blockedCommands: z.array(z.string()).default([]),
  maxBashTimeout: z.number().int().default(600_000),
  maxFileSize: z.number().int().default(10_485_760),
  maxIterations: z.number().int().default(200),
});

export const webConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(48080),
  host: z.string().default("127.0.0.1"),
});

export const internalApiConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(48081),
  host: z.string().default("127.0.0.1"),
});

export const cronConfigSchema = z.object({
  defaultTimeoutSeconds: z.number().int().min(1).default(300),
  tickIntervalMs: z.number().int().min(1000).default(10000),
});

export const monitorThresholdsSchema = z
  .object({
    processHeartbeatStaleSec: z.number().int().min(10).default(60),
    errorCountWindow: z.number().int().min(1).default(20),
    errorRatePercent: z.number().min(0).max(100).default(10),
    errorWindowMinutes: z.number().int().min(1).default(5),
    diskUsagePercent: z.number().min(0).max(100).default(90),
    memoryUsagePercent: z.number().min(0).max(100).default(90),
    cronConsecutiveFailures: z.number().int().min(1).default(3),
  })
  .default({
    processHeartbeatStaleSec: 60,
    errorCountWindow: 20,
    errorRatePercent: 10,
    errorWindowMinutes: 5,
    diskUsagePercent: 90,
    memoryUsagePercent: 90,
    cronConsecutiveFailures: 3,
  });

export const monitorConfigSchema = z
  .object({
    checkIntervalMs: z.number().int().min(30_000).default(120_000),
    alertCooldownMs: z.number().int().min(60_000).default(1_800_000),
    thresholds: monitorThresholdsSchema,
  })
  .default({
    checkIntervalMs: 120_000,
    alertCooldownMs: 1_800_000,
    thresholds: {
      processHeartbeatStaleSec: 60,
      errorCountWindow: 20,
      errorRatePercent: 10,
      errorWindowMinutes: 5,
      diskUsagePercent: 90,
      memoryUsagePercent: 90,
      cronConsecutiveFailures: 3,
    },
  });

export const postgresConfigSchema = z.object({
  url: z
    .string()
    .default("postgres://opencrow:opencrow@127.0.0.1:5432/opencrow"),
  max: z.number().int().min(1).max(100).default(20),
});

export const qdrantConfigSchema = z.object({
  url: z.string().url().default("http://127.0.0.1:6333"),
  apiKey: z.string().optional(),
  collection: z.string().default("opencrow_memory"),
});

export const memorySearchConfigSchema = z.object({
  autoIndex: z.boolean().default(true),
  shared: z.boolean().default(true),
  vectorWeight: z.number().min(0).max(1).default(0.7),
  textWeight: z.number().min(0).max(1).default(0.3),
  defaultLimit: z.number().int().min(1).default(5),
  minScore: z.number().min(0).max(1).default(0.3),
  chunkTokens: z.number().int().min(100).default(400),
  chunkOverlap: z.number().int().min(0).default(80),
  temporalDecayHalfLifeDays: z.number().min(0).default(30),
  mmrLambda: z.number().min(0).max(1).default(0.7),
  qdrant: qdrantConfigSchema.default({
    url: "http://127.0.0.1:6333",
    collection: "opencrow_memory",
  }),
});

export const observationsConfigSchema = z
  .object({
    model: z.string().default("claude-haiku-4-5-20251001"),
    minMessages: z.number().int().min(2).default(4),
    maxPerConversation: z.number().int().min(1).default(3),
    maxRecentInPrompt: z.number().int().min(0).default(10),
    debounceSec: z.number().int().min(0).default(300),
  })
  .default({
    model: "claude-haiku-4-5-20251001",
    minMessages: 4,
    maxPerConversation: 3,
    maxRecentInPrompt: 10,
    debounceSec: 300,
  });

export const processSpecSchema = z.object({
  name: z.string().min(1),
  entry: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  restartPolicy: z.enum(["always", "on-failure", "never"]).default("always"),
  maxRestarts: z.number().int().min(0).default(10),
  restartWindowSec: z.number().int().min(10).default(300),
});

export const agentProcessesConfigSchema = z
  .object({
    entry: z.string().default("src/entries/agent.ts"),
    restartPolicy: z.enum(["always", "on-failure", "never"]).default("always"),
  })
  .default({
    entry: "src/entries/agent.ts",
    restartPolicy: "always",
  });

export const scraperProcessesConfigSchema = z
  .object({
    entry: z.string().default("src/entries/scraper.ts"),
    restartPolicy: z.enum(["always", "on-failure", "never"]).default("always"),
    scraperIds: z
      .array(z.string())
      .default([
        "hackernews",
        "huggingface",
        "reddit",
        "github",
        "producthunt",
        "arxiv",
        "scholar",
        "news",
        "x-bookmarks",
        "x-autolike",
        "x-autofollow",
        "x-timeline",
        "google-trends",
        "appstore",
        "playstore",
        "defillama",
        "dexscreener",
      ]),
  })
  .default({
    entry: "src/entries/scraper.ts",
    restartPolicy: "always",
    scraperIds: [
      "hackernews",
      "huggingface",
      "reddit",
      "github",
      "producthunt",
      "arxiv",
      "scholar",
      "news",
      "x-bookmarks",
      "x-autolike",
      "x-autofollow",
      "x-timeline",
      "google-trends",
      "appstore",
      "playstore",
      "defillama",
      "dexscreener",
    ],
  });

export const processesConfigSchema = z
  .object({
    static: z.array(processSpecSchema).default([]),
    agentProcesses: agentProcessesConfigSchema,
    scraperProcesses: scraperProcessesConfigSchema,
  })
  .default({
    static: [],
    agentProcesses: {
      entry: "src/entries/agent.ts",
      restartPolicy: "always",
    },
    scraperProcesses: {
      entry: "src/entries/scraper.ts",
      restartPolicy: "always",
      scraperIds: [
        "hackernews",
        "huggingface",
        "reddit",
        "github",
        "producthunt",
        "arxiv",
        "scholar",
        "news",
        "x-bookmarks",
        "x-autolike",
        "x-autofollow",
        "x-timeline",
        "google-trends",
        "appstore",
        "playstore",
        "defillama",
        "dexscreener",
      ],
    },
  });

export const opencrowConfigSchema = z.object({
  agent: agentConfigSchema.default({
    model: "claude-opus-4-6",
    systemPrompt:
      "You are OpenCrow, a helpful personal AI assistant. Be concise and direct.",
    retry: { attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.15 },
    compaction: {
      maxContextTokens: 180_000,
      targetHistoryTokens: 60_000,
      summaryMaxTokens: 2048,
      stripToolResultsAfterTurns: 3,
    },
  }),
  agents: z.array(agentDefinitionSchema).default([]),
  channels: z
    .object({
      telegram: telegramConfigSchema.default({
        allowedUserIds: [],
      }),
      whatsapp: whatsappConfigSchema.default({
        allowedNumbers: [],
        allowedGroups: [],
        defaultAgent: "opencrow",
      }),
    })
    .default({
      telegram: { allowedUserIds: [] },
      whatsapp: {
        allowedNumbers: [],
        allowedGroups: [],
        defaultAgent: "opencrow",
      },
    }),
  web: webConfigSchema.default({
    port: 48080,
    host: "0.0.0.0",
  }),
  internalApi: internalApiConfigSchema.default({
    port: 48081,
    host: "127.0.0.1",
  }),
  tools: toolsConfigSchema.default({
    allowedDirectories: ["$HOME"],
    blockedCommands: [],
    maxBashTimeout: 600_000,
    maxFileSize: 10_485_760,
    maxIterations: 200,
  }),
  cron: cronConfigSchema.default({
    defaultTimeoutSeconds: 300,
    tickIntervalMs: 10000,
  }),
  postgres: postgresConfigSchema.default({
    url: "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow",
    max: 20,
  }),
  memorySearch: memorySearchConfigSchema.default({
    autoIndex: true,
    shared: true,
    vectorWeight: 0.7,
    textWeight: 0.3,
    defaultLimit: 5,
    minScore: 0.3,
    chunkTokens: 400,
    chunkOverlap: 80,
    temporalDecayHalfLifeDays: 30,
    mmrLambda: 0.7,
    qdrant: {
      url: "http://127.0.0.1:6333",
      collection: "opencrow_memory",
    },
  }),
  observations: observationsConfigSchema,
  market: marketPipelineConfigSchema.default({
    questdbIlpUrl: "tcp::addr=127.0.0.1:9009",
    questdbHttpUrl: "http://127.0.0.1:9000",
    exchange: "binance",
    marketTypes: ["spot", "futures"],
    symbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  }),
  monitor: monitorConfigSchema,
  processes: processesConfigSchema,
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type OpenCrowConfig = z.infer<typeof opencrowConfigSchema>;
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export type WhatsAppConfig = z.infer<typeof whatsappConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type RetryConfig = z.infer<typeof retryConfigSchema>;
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;
export type FailoverConfig = z.infer<typeof failoverConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;
export type CronConfig = z.infer<typeof cronConfigSchema>;
export type MemorySearchConfig = z.infer<typeof memorySearchConfigSchema>;
export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type QdrantConfig = z.infer<typeof qdrantConfigSchema>;
export type InternalApiConfig = z.infer<typeof internalApiConfigSchema>;
export type MarketPipelineConfig = z.infer<typeof marketPipelineConfigSchema>;
export type ObservationsConfig = z.infer<typeof observationsConfigSchema>;
export type ProcessSpec = z.infer<typeof processSpecSchema>;
export type ProcessesConfig = z.infer<typeof processesConfigSchema>;
export type AgentProcessesConfig = z.infer<typeof agentProcessesConfigSchema>;
export type ScraperProcessesConfig = z.infer<
  typeof scraperProcessesConfigSchema
>;
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export type MonitorThresholds = z.infer<typeof monitorThresholdsSchema>;
export type ModelParams = z.infer<typeof modelParamsSchema>;
