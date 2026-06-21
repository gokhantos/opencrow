import { z } from "zod";

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
  model: z.string().default("claude-sonnet-4-6"),
  systemPrompt: z
    .string()
    .default("You are OpenCrow, a helpful personal AI assistant. Be concise and direct."),
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
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
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
  provider: z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic", "opencode"]).optional(),
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

/**
 * Safe-by-default denylist for the agent bash tool. These are matched by
 * `isCommandBlocked` in src/tools/bash.ts against each shell segment's first
 * token (basename-aware) or as a literal prefix. Keep entries lowercase.
 *
 * This is defense-in-depth alongside the regex-based dangerous-command hook in
 * src/agent/hooks.ts; operators can extend it via config but should not need to
 * remove entries for normal use.
 */
export const DEFAULT_BLOCKED_COMMANDS: readonly string[] = [
  // Privilege escalation
  "sudo",
  "su",
  "doas",
  "pkexec",
  // Catastrophic deletes / disk operations
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf $home",
  "dd",
  "mkfs",
  "fdisk",
  "shred",
  // Fork bomb
  ":(){",
  // Permission widening
  "chmod 777",
  "chmod -r 777",
  // System control
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "systemctl",
  // Remote execution / network shells (lateral movement, exfiltration)
  "ssh",
  "scp",
  "sftp",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  // Writes to sensitive paths (matched as a literal segment prefix)
  "tee /etc",
  "tee ~/.ssh",
  // NOTE: pipe-to-shell installers (curl … | sh, wget … | bash) and redirects
  // into sensitive paths are caught by the regex-based dangerous-command check
  // in src/agent/hooks.ts, because isCommandBlocked splits on shell
  // metacharacters and so cannot see across a pipe.
];

/**
 * Default agent workspace. Bash and runShell are confined here rather than the
 * whole home directory, so the agent cannot read/modify arbitrary user files
 * (~/.ssh, dotfiles, etc.) by default. Operators can widen this in config.
 */
export const DEFAULT_AGENT_WORKSPACE = "$HOME/.opencrow/workspace";

export const toolsConfigSchema = z.object({
  allowedDirectories: z.array(z.string()).default([DEFAULT_AGENT_WORKSPACE]),
  blockedCommands: z.array(z.string()).default([...DEFAULT_BLOCKED_COMMANDS]),
  /**
   * Enable regex-based dangerous-command blocking on the bash tool. Safe by
   * default: both the bash tool and the SDK PreToolUse hook treat `undefined`
   * as ON, and the top-level config default sets it to `true` explicitly. Set
   * to `false` only to opt out.
   */
  dangerousCommandBlocking: z.boolean().optional(),
  /**
   * OS-level sandbox for shell execution (bash tool + dev-tool exec path).
   * The sandbox — not the string blocklists — is the real boundary that stops
   * an LLM (fed untrusted scraped content) from reading/exfiltrating arbitrary
   * on-disk files. Modes:
   *   - "off":         never wrap (legacy behavior).
   *   - "best-effort": wrap when a mechanism (sandbox-exec / bwrap) is
   *                    available; otherwise log a loud warning and run unwrapped.
   *   - "required":    fail closed — refuse to run any shell command if no
   *                    sandbox mechanism is available.
   * Default "best-effort" keeps dev environments (no sandbox binary) working
   * while hardening Docker/macOS deployments automatically.
   */
  sandbox: z.enum(["off", "best-effort", "required"]).default("best-effort"),
  /**
   * Allow the dev-tool exec path (run_tests / validate_code) to reach the
   * network from inside the sandbox. Default FALSE: the test/lint command bodies
   * are fully agent-controllable (package.json scripts.test, .eslintrc) so even
   * a perfect filesystem sandbox would let an injected payload exfiltrate over
   * the network if egress were open. Operators who genuinely need test runners
   * to fetch dependencies can opt in per deployment.
   *
   * REMOTE-FETCH RISK: turning this on does NOT just enable a vendored-dependency
   * install. The dev tools shell out to `npx`/`bunx`, which will FETCH and EXECUTE
   * arbitrary remote packages on demand (e.g. an attacker-authored
   * package.json scripts.test of `npx some-evil-pkg` or a config that pulls a
   * plugin). With this flag on, that code runs in an environment that has BOTH
   * network egress AND read+write access to the workspace — i.e. a full
   * fetch-then-exec-then-exfiltrate path even with a perfect filesystem sandbox.
   * Strongly prefer vendoring dependencies (commit node_modules / use an offline
   * cache) and leaving this FALSE; only enable it for trusted workspaces.
   */
  devToolsAllowNetwork: z.boolean().default(false),
  /**
   * Opt-in escape hatch that lets the dev-tool exec path (run_tests AND
   * validate_code's lint/typecheck/test steps) run even
   * when the OS sandbox is NOT active — i.e. sandbox mode "off", or
   * "best-effort" on a host with no sandbox mechanism.
   *
   * Default FALSE = FAIL CLOSED. These tools inherently execute
   * workspace-authored, attacker-controllable code: test/lint/typecheck run
   * package.json scripts, eslint.config.mjs, tsconfig `extends`, biome config,
   * etc.; git status/diff can execute code via a workspace .git/config's
   * pager/hooks/aliases/core.fsmonitor. The OS sandbox — not the bypassable
   * string blocklists — is the boundary that contains that code. When it is not
   * in effect we refuse rather than silently execute arbitrary code on the host.
   * Operators who knowingly accept that risk (e.g. a trusted dev box with no
   * sandbox binary) can set this true to restore the old behavior.
   */
  allowUnsandboxedDevTools: z.boolean().default(false),
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

/**
 * Global browser-tooling toggle. Historically `OPENCROW_BROWSER_ENABLED` was
 * written to `config.browser.enabled` by the env loader but had no schema field,
 * so the schema parse silently dropped it (per-agent `mcpServers.browser` is the
 * runtime switch). The field is defined here so the value can survive the parse
 * and be DB-driven via the `config/server` override (`browserEnabled`). Default
 * false matches the prior behavior (env only ever set it true).
 */
export const browserConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({ enabled: false });

export const cronConfigSchema = z.object({
  defaultTimeoutSeconds: z.number().int().min(1).default(300),
  tickIntervalMs: z.number().int().min(1000).default(10000),
  maxConcurrency: z.number().int().min(1).max(16).default(4),
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
  url: z.string().default("postgres://opencrow:opencrow@127.0.0.1:5432/opencrow"),
  max: z.number().int().min(1).max(100).default(20),
});

export const qdrantConfigSchema = z.object({
  url: z.string().url().default("http://127.0.0.1:6333"),
  apiKey: z.string().optional(),
  collection: z.string().default("opencrow_memory"),
});

export const embeddingsConfigSchema = z
  .object({
    provider: z.enum(["openrouter", "ollama"]).default("openrouter"),
    /** Base URL of an OpenAI-compatible embeddings API. Defaults per provider. */
    baseUrl: z.string().optional(),
    /**
     * Embedding vector dimensions. SINGLE SOURCE OF TRUTH for the vector size —
     * embeddings.ts reads it (never hardcodes) and the Qdrant collection is
     * created/asserted against it (see indexer/qdrant ensureCollection). Changing
     * this requires a full re-index, not just a config flip: the stored vectors
     * and the collection dimension must match.
     */
    dimensions: z.number().int().min(32).max(4096).default(512),
    /** OpenRouter model to use */
    openrouterModel: z.string().default("text-embedding-3-small"),
    /** Generic model name (any provider). Falls back to openrouterModel. */
    model: z.string().optional(),
    /** Max texts per API batch */
    batchSize: z.number().int().min(1).default(64),
  })
  .default({
    provider: "openrouter",
    dimensions: 512,
    openrouterModel: "text-embedding-3-small",
    batchSize: 64,
  });

/**
 * Selectable memory storage backend. `qdrant` is the live default (Postgres +
 * Qdrant + FTS); `mem0` is reserved for the planned phase-2 backend and is not
 * implemented yet — the backend factory throws if it is selected.
 */
export const memoryBackendKindSchema = z.enum(["qdrant", "mem0"]).default("qdrant");

export const memorySearchConfigSchema = z.object({
  backend: memoryBackendKindSchema,
  autoIndex: z.boolean().default(true),
  shared: z.boolean().default(true),
  // mem0 backend only: the shared `user_id` used for the scraped-signal pool
  // when `shared` is true. Distinct from SIGE's sige-global/sige-ideas userIds.
  // Ignored by the qdrant backend.
  mem0SharedUserId: z.string().default("opencrow-shared"),
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
    model: z.string().default("claude-haiku-4-5"),
    minMessages: z.number().int().min(2).default(4),
    maxPerConversation: z.number().int().min(1).default(3),
    maxRecentInPrompt: z.number().int().min(0).default(10),
    debounceSec: z.number().int().min(0).default(300),
  })
  .default({
    model: "claude-haiku-4-5",
    minMessages: 4,
    maxPerConversation: 3,
    maxRecentInPrompt: 10,
    debounceSec: 300,
  });

export const heartbeatSpecSchema = z.object({
  enabled: z.boolean().optional(),
  // Bounded: pingChildren waits max(per-spec pingTimeoutMs) for the whole cycle,
  // so one oversized value would stretch every child's hung-detection window and
  // (via the orchestrator's pingInFlight mutex) suppress subsequent ticks. Cap it.
  pingTimeoutMs: z.number().int().min(100).max(60_000).optional(),
  hungStrikesMax: z.number().int().min(1).max(10).optional(),
});

export const processSpecSchema = z.object({
  name: z.string().min(1),
  entry: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  restartPolicy: z.enum(["always", "on-failure", "never"]).default("always"),
  maxRestarts: z.number().int().min(0).default(10),
  restartWindowSec: z.number().int().min(10).default(300),
  heartbeat: heartbeatSpecSchema.optional(),
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
    scraperIds: z.array(z.string()).default([]),
  })
  .default({
    entry: "src/entries/scraper.ts",
    restartPolicy: "always",
    scraperIds: [],
  });

// ─── Reddit corpus de-bias ───────────────────────────────────────────────────
// Controls WHICH subreddits the reddit scraper fetches, applying a curated
// end-user/vertical-pain allowlist and an echo-chamber+crypto denylist at
// ingestion time. This is orthogonal to the existing echoChamberDownweight
// lever (which re-ranks already-ingested posts) — this gate drops echo-chamber
// content BEFORE it reaches the DB.
//
// allowlist  — scraped unconditionally (curated end-user pain subs).
// denylist   — dropped at ingestion from EVERY path (home feed, subreddit
//              feeds, subscriptions). Case-insensitive.
// includeSubscriptions — when true, the account's own subscriptions are
//              merged into the allowlist AFTER denylist filtering. Default
//              false (subscriptions are the echo chamber; use the curated list).
const DEFAULT_REDDIT_ALLOWLIST = [
  "freelance",
  "smallbusiness",
  "Entrepreneur",
  "gamedev",
  "personalfinance",
  "productivity",
  "ADHD",
  "parenting",
  "restaurateurs",
  "RealEstate",
  "nonprofit",
  "Accounting",
  "sysadmin",
  "msp",
  "legaladvice",
  "Etsy",
  "ecommerce",
  "smallbusinessUK",
  "Construction",
  "dentistry",
  "nursing",
  "teachers",
  "freelanceWriters",
  "weddingplanning",
  "SomebodyMakeThis",
  "AppIdeas",
  "Lightbulb",
] as const;

const DEFAULT_REDDIT_DENYLIST = [
  "vibecoding",
  "ClaudeCode",
  "ClaudeAI",
  "ChatGPT",
  "Anthropic",
  "DeepSeek",
  "PromptEngineering",
  "VibeCodeDevs",
  "aiagents",
  "midjourney",
  "openclaw",
  "LocalLLaMA",
  "MachineLearning",
  "ArtificialInteligence",
  "OpenAI",
  "singularity",
  "ChatGPTCoding",
  "cursor",
  "ChatGPTPro",
  "CryptoCurrency",
  "Bitcoin",
  "ethereum",
  "defi",
  "CryptoTechnology",
  "CryptoMarkets",
] as const;

export const redditCorpusConfigSchema = z
  .object({
    // Curated list of end-user/vertical-pain subreddits to scrape explicitly.
    allowlist: z.array(z.string()).default([...DEFAULT_REDDIT_ALLOWLIST]),
    // Echo-chamber + crypto subs to drop at ingestion (all paths, case-insensitive).
    denylist: z.array(z.string()).default([...DEFAULT_REDDIT_DENYLIST]),
    // When true, the account's own subscriptions are merged AFTER denylist
    // filtering. Default false — subscriptions are the echo chamber.
    includeSubscriptions: z.boolean().default(false),
  })
  .default({
    allowlist: [...DEFAULT_REDDIT_ALLOWLIST],
    denylist: [...DEFAULT_REDDIT_DENYLIST],
    includeSubscriptions: false,
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
      scraperIds: [],
    },
  });

export const memoryEvictionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  ttlDays: z.number().int().min(1).default(90),
  intervalMinutes: z.number().int().min(5).default(60),
  batchSize: z.number().int().min(10).default(500),
});

export const rateLimitPerSenderSchema = z.object({
  maxBurst: z.number().int().min(1).max(1000).default(5),
  sustainedPerMinute: z.number().int().min(1).max(3600).default(10),
});

export const rateLimitConfigSchema = z
  .object({
    perSender: rateLimitPerSenderSchema.default({
      maxBurst: 5,
      sustainedPerMinute: 10,
    }),
  })
  .optional();

// ─── Ingestion (data ingestion → mem0) ─────────────────────────────────────────
//
// Data ingestion is SHARED infrastructure, NOT a SIGE-only concern: the mem0
// knowledge it populates is read by BOTH the generation pipeline (graph-reasoning
// in the synthesizer) AND SIGE. It is therefore a first-class top-level domain,
// independent of `config.sige`. The continuous extraction loop (the `ingestion`
// process) reads scraped Postgres rows on a timer and writes them to mem0 with
// credibility scoring + dedup.
//
// It is an LLM-bound loop that burns mem0 quota with no operator in the loop.
// Default ON so existing deployments are unchanged. Set `enabled: false` to stop
// the autonomous loop entirely; SIGE and the pipeline keep running and read
// whatever corpus already exists.
//
// `mem0` is ingestion's OWN connection config (same shape/defaults as sige.mem0).
// Both point at the same shared mem0 instance — that is intentional; the duplicate
// is the connection config, not the instance, so ingestion has zero dependency on
// the `sige` domain.
export const ingestionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mem0: z
      .object({
        baseUrl: z.string().url().default("http://127.0.0.1:8050"),
        userId: z.string().default("sige-global"),
        // Shared bearer token sent on every /v1/memories/* request to the mem0
        // sidecar (which has no upstream auth). Optional so a tokenless dev run
        // still boots. Sourced from env in the loader (reuses OPENCROW_INTERNAL_TOKEN).
        apiToken: z.string().optional(),
      })
      .default({
        baseUrl: "http://127.0.0.1:8050",
        userId: "sige-global",
      }),
    // How many records may be ingested per calendar day (cost ceiling). Runtime-
    // tunable at finer grain via the `maxRecordsPerDay` config_override.
    maxRecordsPerDay: z.number().int().min(1).default(3_000),
    // Rows fetched per source per cycle.
    batchSize: z.number().int().min(1).default(20),
    // Gap between ingestion cycles (run-then-reschedule).
    pollIntervalMs: z.number().int().min(1_000).default(5 * 60 * 1_000),
    // Minimum trimmed content length to pass the quality gate.
    minContentLength: z.number().int().min(1).default(40),
  })
  .default({
    enabled: true,
    mem0: { baseUrl: "http://127.0.0.1:8050", userId: "sige-global" },
    maxRecordsPerDay: 3_000,
    batchSize: 20,
    pollIntervalMs: 5 * 60 * 1_000,
    minContentLength: 40,
  });

export const sigeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mem0: z
    .object({
      baseUrl: z.string().url().default("http://127.0.0.1:8050"),
      userId: z.string().default("sige-global"),
      // Dedicated userId for idea-outcome memories (separate namespace from raw
      // signals so per-segment metadata filters stay clean).
      ideasUserId: z.string().default("sige-ideas"),
      // Shared bearer token sent on every /v1/memories/* request to the mem0
      // sidecar (which has no upstream auth; GHSA-jfv9-68m5-gjjr). Optional so a
      // tokenless dev run still boots — the sidecar then rejects with 503 and SIGE
      // degrades gracefully via the client circuit breaker. Sourced from env in
      // the loader (reuses OPENCROW_INTERNAL_TOKEN, already shared with mem0).
      apiToken: z.string().optional(),
    })
    .default({
      baseUrl: "http://127.0.0.1:8050",
      userId: "sige-global",
      ideasUserId: "sige-ideas",
    }),
  // Read-only Bolt connection to the SAME Neo4j instance mem0 writes its graph
  // store to (no ETL). Powers the multi-hop "opportunity paths" graph-reasoning
  // directive. Default OFF — no driver is loaded and no connection is dialed
  // until enabled. The password is NOT here: it is resolved via
  // getSecret("NEO4J_PASSWORD") so it never lands in config/logs.
  neo4j: z
    .object({
      enabled: z.boolean().default(false),
      boltUrl: z.string().default("bolt://127.0.0.1:7687"),
      user: z.string().default("neo4j"),
      queryTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),
    })
    .default({
      enabled: false,
      boltUrl: "bolt://127.0.0.1:7687",
      user: "neo4j",
      queryTimeoutMs: 5_000,
    }),
  simulation: z
    .object({
      expertRounds: z.number().int().min(1).max(10).default(4),
      socialAgentCount: z.number().int().min(10).max(500).default(50),
      socialRounds: z.number().int().min(1).max(20).default(5),
      maxConcurrentAgents: z.number().int().min(1).max(20).default(10),
      alpha: z.number().min(0).max(1).default(0.6),
    })
    .default({
      expertRounds: 4,
      socialAgentCount: 50,
      socialRounds: 5,
      maxConcurrentAgents: 10,
      alpha: 0.6,
    }),
  incentives: z
    .object({
      diversityWeight: z.number().min(0).max(1).default(0.15),
      buildingWeight: z.number().min(0).max(1).default(0.1),
      surpriseWeight: z.number().min(0).max(1).default(0.1),
      accuracyPenaltyWeight: z.number().min(0).max(1).default(0.05),
      socialViabilityWeight: z.number().min(0).max(1).default(0.2),
      memoryRewardWeight: z.number().min(0).max(1).default(0.1),
      coalitionStabilityWeight: z.number().min(0).max(1).default(0.1),
      signalCredibilityWeight: z.number().min(0).max(1).default(0.1),
    })
    .default({
      diversityWeight: 0.15,
      buildingWeight: 0.1,
      surpriseWeight: 0.1,
      accuracyPenaltyWeight: 0.05,
      socialViabilityWeight: 0.2,
      memoryRewardWeight: 0.1,
      coalitionStabilityWeight: 0.1,
      signalCredibilityWeight: 0.1,
    }),
  provider: z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic", "opencode"]).default("anthropic"),
  model: z.string().default("claude-sonnet-4-6"),
  agentModel: z.string().default("claude-sonnet-4-6"),
  workflow: z
    .object({
      topology: z
        .enum(["pipeline", "feedback_loop", "star", "parallel", "hybrid"])
        .default("pipeline"),
      maxFeedbackIterations: z.number().int().min(1).max(10).default(3),
      convergenceThreshold: z.number().min(0).max(1).default(0.85),
    })
    .default({
      topology: "pipeline",
      maxFeedbackIterations: 3,
      convergenceThreshold: 0.85,
    }),
});

// Default weights for the 7 GIANT rubric axes. They are non-compensatory
// inputs into a weighted geometric mean; the values intentionally sum to 1.0
// but are not normalized here (the aggregation math owns that). Each axis is
// scored 0..5; acuteProblem/whyNow are hard gates and demand is evidence-gated.
export const GIANT_DEFAULT_WEIGHTS = {
  acuteProblem: 0.22,
  whyNow: 0.18,
  demand: 0.18,
  nonObviousness: 0.15,
  defensibility: 0.12,
  marketShape: 0.08,
  founderFit: 0.07,
} as const;

// The single shared GIANT optimization target. Default: compute + store in
// SHADOW mode (log would-kill decisions, never drop). Enforcement of hard gates
// is opt-in via enforceGates so the live pipeline keeps producing ideas while
// kill-logs are reviewed.
export const giantConfigSchema = z
  .object({
    // Compute + store GIANT scores for every idea.
    enabled: z.boolean().default(true),
    // SHADOW mode by default: log would-kill decisions but do NOT drop gated
    // ideas. Set true to actually enforce the hard gates / evidence gate.
    enforceGates: z.boolean().default(false),
    // Per-axis weights for the weighted geometric mean. Optional + fully
    // defaulted so existing config stays backward-compatible.
    weights: z
      .object({
        acuteProblem: z.number().default(GIANT_DEFAULT_WEIGHTS.acuteProblem),
        whyNow: z.number().default(GIANT_DEFAULT_WEIGHTS.whyNow),
        demand: z.number().default(GIANT_DEFAULT_WEIGHTS.demand),
        nonObviousness: z.number().default(GIANT_DEFAULT_WEIGHTS.nonObviousness),
        defensibility: z.number().default(GIANT_DEFAULT_WEIGHTS.defensibility),
        marketShape: z.number().default(GIANT_DEFAULT_WEIGHTS.marketShape),
        founderFit: z.number().default(GIANT_DEFAULT_WEIGHTS.founderFit),
      })
      .default({ ...GIANT_DEFAULT_WEIGHTS }),
  })
  .default({
    enabled: true,
    enforceGates: false,
    weights: { ...GIANT_DEFAULT_WEIGHTS },
  });

// Phase 1 "generate-wide": widen the candidate pool BEFORE selection so
// downstream selectors have a diverse, evidence-tethered set to rank instead of
// a single idea per intersection. All fields are defaulted -> backward-compatible.
// The default path keeps producing ideas (overGenerate/multiSegment ON); the
// optional SIGE divergent merge stays OFF. maxCandidates caps total cost.
export const generateWideConfigSchema = z
  .object({
    // Verbalized-sampling over-generation: ask for several distinct seeds per
    // intersection (instead of exactly one) then dedupe/select downstream.
    overGenerate: z.boolean().default(true),
    // How many distinct seeds to request per intersection when overGenerating.
    seedsPerIntersection: z.number().int().min(1).max(12).default(5),
    // Hard ceiling on the widened candidate pool so cost stays bounded.
    maxCandidates: z.number().int().min(8).max(120).default(40),
    // Force segment spread (consumer/b2b_saas/devtools/...) so the pool is not
    // 100% consumer-mobile mode collapse.
    multiSegment: z.boolean().default(true),
    // Flag-gated merge of the SIGE divergent-generation pool. OFF by default.
    sigeDivergent: z.boolean().default(false),
    // Over-generation is split into chunks of this many intersections, one chat
    // call each, so no single call asks for ~30 dense ideas (which timed out at
    // 210s). Each chunk stays in the proven ~5k-output / ~90s regime.
    chunkSize: z.number().int().min(1).max(20).default(2),
  })
  .default({
    overGenerate: true,
    seedsPerIntersection: 5,
    maxCandidates: 40,
    multiSegment: true,
    sigeDivergent: false,
    chunkSize: 2,
  });

// Stage 2 "broad-shallow ideation" (Funnel Breadth Redesign). Ideate cheaply over
// MANY candidate themes (one one-line sketch each, batched on a small/cheap model)
// then diversity-select a few for deep-development. FULLY REVERSIBLE: `enabled`
// false → the synthesizer keeps today's narrow top-10 neck. Defaults are
// conservative so cost stays bounded (candidateCount × one cheap line, batched).
export const shallowIdeationConfigSchema = z
  .object({
    // Master switch. Default OFF for a first ship — flip to broaden the funnel
    // without a code change. See the design doc §4 (reversibility is the hard
    // requirement; default-on is the judgment call, left OFF here).
    enabled: z.boolean().default(false),
    // How many candidate themes to ideate over (raises the ≤10 neck). ~30.
    candidateCount: z.number().int().min(4).max(120).default(30),
    // Candidates per cheap-model sketch call (batching keeps the call count low).
    batchSize: z.number().int().min(1).max(50).default(10),
    // Optional cheap-model id override. Empty → resolve via model-routing
    // (`sige.fast-agent`, Haiku-class). NEVER the deep `pipeline.generator`.
    model: z.string().default(""),
  })
  .default({
    enabled: false,
    candidateCount: 30,
    batchSize: 10,
    model: "",
  });
export type ShallowIdeationConfig = z.infer<typeof shallowIdeationConfigSchema>;

// Phase 2 "demand-side grounding": give every idea an external truth source so
// the GIANT demand / why-now axes score on CITED buyer-intent extracted
// deterministically from EXISTING scraped tables (reddit_posts / news_articles)
// instead of LLM guesses. Fully defaulted -> backward-compatible. The core
// reddit-intent + funding-news probes default ON (no external/paid calls); the
// externalTrends probe (paid search-volume vendors) defaults OFF / stubbed.
export const demandConfigSchema = z
  .object({
    // Master switch for the demand-grounding stage. Default ON.
    enabled: z.boolean().default(true),
    // Reddit buyer-intent probe over existing reddit_posts. Default ON.
    redditIntent: z.boolean().default(true),
    // Funding-mention probe over existing news_articles. Default ON.
    fundingSignal: z.boolean().default(true),
    // Low-star (<=2★) review-complaint probe over existing appstore_reviews +
    // playstore_reviews. Internal-DB only, no external call. Default ON.
    reviewComplaint: z.boolean().default(true),
    // Hacker News buyer-intent probe over existing hn_stories. Default ON.
    hnIntent: z.boolean().default(true),
    // X/Twitter buyer-intent probe over existing x_scraped_tweets. Internal-DB
    // only, same buyer-intent semantics as reddit. Default ON (Lever 4).
    xIntent: z.boolean().default(true),
    // Lever 1 — WEAK-INTENT gate: count a marker-less but high-engagement row
    // that names the idea as WEAK (discounted) demand in the reddit/HN/X probes.
    // The full relevance gate + an engagement floor still apply. Default ON.
    weakIntent: z.boolean().default(true),
    // Multiplier applied to a WEAK (marker-less) row's engagement count so it
    // can't masquerade as strong buyer-intent. Default 0.35; bounds 0..1.
    weakIntentFactor: z.number().min(0).max(1).default(0.35),
    // Engagement-weighted count (1 + log1p(score+comments)) a marker-less row
    // must reach to qualify as weak evidence — guards dead, zero-engagement
    // keyword mentions. Default 1.5 (≈ 1 upvote/comment of signal); bounds ≥ 1.
    weakIntentMinEngagement: z.number().min(1).default(1.5),
    // Lever 3 — FUZZY LEXICAL MATCHING (stem + word-boundary + curated synonyms)
    // so idea variants/synonyms match the corpus. Default ON; false restores the
    // legacy literal-substring matcher per probe.
    fuzzyMatch: z.boolean().default(true),
    // Use keyword-matching ph_products to DISCOUNT whitespace via supplyDensity
    // (supply, not demand — never affects the demand score). Default ON.
    phSupply: z.boolean().default(true),
    // Pluggable external search-volume / trends vendor. Default OFF (stubbed).
    externalTrends: z.boolean().default(false),
    // Minimum matched rows before demand evidence is considered corroborated;
    // below this the artifact takes the absence penalty (low score/confidence).
    minMatches: z.number().int().min(1).default(2),
    // RELEVANCE GATE: minimum number of DISTINCT idea keywords that must co-occur
    // in a single scraped document before it counts as demand evidence. The DB
    // keyword-filter (OR) is only a cheap candidate prefilter; this in-code gate
    // ensures the document is actually ABOUT the idea (not just sharing one
    // generic word like "tracking"/"restaurant"). 2 = a phrase match, or two
    // distinct idea terms, is required. Bias toward missing over inflating.
    minKeywordHits: z.number().int().min(1).default(2),
  })
  .default({
    enabled: true,
    redditIntent: true,
    fundingSignal: true,
    reviewComplaint: true,
    hnIntent: true,
    xIntent: true,
    weakIntent: true,
    weakIntentFactor: 0.35,
    weakIntentMinEngagement: 1.5,
    fuzzyMatch: true,
    phSupply: true,
    externalTrends: false,
    minMatches: 2,
    minKeywordHits: 2,
  });

// Cross-family default jury for the hardened SIGE judge. These models are ONLY
// instantiated when smart.sigeValuation is ON; any provider without a key is
// gracefully skipped at runtime. The mix is intentionally multi-family so the
// independent judge does not share a model lineage with the generators.
export const SIGE_DEFAULT_JUDGE_MODELS: readonly { provider: string; model: string }[] = [
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
  { provider: "alibaba", model: "qwen3.7-plus" },
];

// Phase-3 SIGE hardening: an independent, anonymized, multi-family judge with
// first-class dissent weighting and a convergence veto. Fully defaulted so the
// flags only take effect once smart.sigeValuation is turned ON.
export const sigeHardeningConfigSchema = z
  .object({
    // Score candidates with a judge separated from the generators (different
    // model family, anonymized inputs) instead of mean-pooling proposer scores.
    independentJudge: z.boolean().default(true),
    // Cross-family jury used by the independent judge. Each entry maps to
    // chat() options.provider/model; missing keys are skipped gracefully.
    judgeModels: z
      .array(
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      )
      .default(SIGE_DEFAULT_JUDGE_MODELS.map((m) => ({ ...m }))),
    // Weight applied to the first-class dissent term so contrarian/red-team
    // signal is not averaged away by conformity.
    dissentWeight: z.number().default(0.15),
    // Convergence-veto gate: when computeMetaGameHealth convergenceRate exceeds
    // this threshold the round is treated as collapsed (sycophancy) and vetoed.
    convergenceVetoThreshold: z.number().default(0.85),
    // What a fired convergence-veto actually DOES. "log" (default) only records
    // the collapse-prone audit signal; "widen" additionally discards the
    // collapsed SIGE consensus so downstream selection falls back to the
    // independent critique/originality ordering instead of over-trusting it.
    convergenceVetoAction: z.enum(["log", "widen"]).default("log"),
    // Enable the expensive deep-reasoning tier of the judge.
    deepTier: z.boolean().default(true),
  })
  .default({
    independentJudge: true,
    judgeModels: SIGE_DEFAULT_JUDGE_MODELS.map((m) => ({ ...m })),
    dissentWeight: 0.15,
    convergenceVetoThreshold: 0.85,
    convergenceVetoAction: "log",
    deepTier: true,
  });

// Phase 4 "warm the cold taste loop": bootstrap the taste/calibration loop
// WITHOUT waiting for human labels. Anti-exemplars (an "AVOID these generic
// archetypes" block) and synthetic golden-set positive exemplars break the
// cold-start; cheap auto-proxy labels seed the calibration loop; optional GIANT
// axis-weight calibration learns low-weight nudges. Fully defaulted ->
// backward-compatible. The safe levers (antiExemplars/syntheticGolden/
// autoProxyLabels) default ON; calibrateGiantWeights defaults OFF until enough
// labels accrue and NEVER overrides the rubric spine.
export const tasteConfigSchema = z
  .object({
    // "AVOID these generic archetypes" few-shot block built from low-GIANT /
    // known-generic ideas. The higher-leverage, anti-mode-collapse-safe lever.
    antiExemplars: z.boolean().default(true),
    // Derive positive exemplars from the BEST existing scored ideas when there
    // are too few human-validated ideas; real human labels replace these.
    syntheticGolden: z.boolean().default(true),
    // Write cheap bootstrap labels into idea_feedback (actor "proxy:<reason>")
    // to seed the calibration loop. Human labels always outweigh proxy labels.
    autoProxyLabels: z.boolean().default(true),
    // Learn low-weight per-axis GIANT weight nudges from feedback. Gated, never
    // overrides the rubric spine; default OFF until enough labels exist.
    calibrateGiantWeights: z.boolean().default(false),
    // Few-shot exemplar count. Kept LOW + rotated across runs to avoid
    // collapsing generation toward the seeds (mode collapse).
    exemplarCount: z.number().int().min(1).max(12).default(4),
    // Minimum human-validated ideas before synthetic golden exemplars are
    // dropped in favor of real ones.
    goldenMinHumanLabels: z.number().int().min(0).default(10),
  })
  .default({
    antiExemplars: true,
    syntheticGolden: true,
    autoProxyLabels: true,
    calibrateGiantWeights: false,
    exemplarCount: 4,
    goldenMinHumanLabels: 10,
  });

// Phase 5 "autonomous SIGE": cadence-driven seedless idea generation.
// Every field defaults to the safe/off value so that with no config change
// the system behaves byte-for-byte as before. Master switch is `enabled: false`.
export const sigeAutoConfigSchema = z
  .object({
    /** Master switch. Must be false (default) until Phase D staged enablement. */
    enabled: z.boolean().default(false),
    /** Max full expert-game runs per discovery cycle. Hard-capped at 8. */
    maxDeepFrontiers: z.number().int().min(1).max(8).default(1),
    /** Max frontier clusters formed in the broad-pool phase. Hard-capped at 8.
     *  Decoupled from maxDeepFrontiers: always discover the full pool for
     *  diversity, even when only deep-developing 1 frontier. */
    broadFrontierCap: z.number().int().min(1).max(8).default(8),
    /** Max cheap broad-pool candidates from Round-1 generation. Hard-capped at 200. */
    broadPoolSize: z.number().int().min(1).max(200).default(50),
    /** Auto-tick cadence. 'daily' = 86.4M ms; 'manual' = never auto-ticks. */
    cadence: z.enum(["daily", "manual"]).default("daily"),
    /** Concurrent deep-game slots. Locked at 1 via schema (forward-compat only). */
    maxConcurrent: z.number().int().min(1).max(1).default(1),
    /** Write back autonomous top-ideas to Mem0. Default false avoids feedback-loop risk. */
    memoryWriteback: z.boolean().default(false),
    /**
     * RESERVED — not yet enforced; placeholder for a future per-run token-cost
     * abort. No recordTokenUsage / abort wiring exists today: setting this field
     * does NOT cap spending. Do not rely on it as a cost guard.
     */
    perRunCostCeilingUsd: z.number().min(0).default(0),
    /**
     * Semantic (embedding-based) frontier clustering. When ON, the broad
     * divergent pool is clustered by embedding cosine similarity instead of
     * lexical n-gram title overlap, so distinct themes form even when titles
     * share no words (the lexical clusterer collapses those into one residual
     * frontier, starving the diversity-select step). Fallback-safe: flag OFF —
     * or no embedder / embed failure — reverts to the lexical path exactly.
     */
    semanticFrontiers: z
      .object({
        enabled: z.boolean().default(true),
        /** Cosine floor for joining an existing semantic cluster. */
        similarityThreshold: z.number().min(0).max(1).default(0.62),
      })
      .default({ enabled: true, similarityThreshold: 0.62 }),
  })
  .default({
    enabled: false,
    maxDeepFrontiers: 1,
    broadFrontierCap: 8,
    broadPoolSize: 50,
    cadence: "daily",
    maxConcurrent: 1,
    memoryWriteback: false,
    perRunCostCeilingUsd: 0,
    semanticFrontiers: { enabled: true, similarityThreshold: 0.62 },
  });
export type SigeAutoConfig = z.infer<typeof sigeAutoConfigSchema>;

// Phase 6 "outcome memory": write idea verdicts back to mem0 and/or read them
// at synthesis time to guide the next generation round. Both behavior flags now
// default ON to activate the REINFORCE/AVOID learning loop against the populated
// graph — see the per-field comments for the rationale of each flip.
export const outcomeMemoryConfigSchema = z
  .object({
    // Write idea verdict sentences back to mem0 after persistence/proxy-labels.
    // Default ON: this is the WRITE half of the learning loop — without it no
    // outcome memories ever accumulate, so the READ half has nothing to inject.
    // Best-effort + circuit-broken (writeOutcomeMemories swallows failures), so a
    // down mem0 sidecar degrades to a no-op rather than breaking the run.
    writeBack: z.boolean().default(true),
    // Read outcome memories at synthesis time and inject as GUIDANCE.
    // Default ON: this is the READ half — it injects learned REINFORCE/AVOID
    // guidance into the synthesis prompt. Read-only and degrades to "" on any
    // mem0 failure (fetchOutcomeMemoryBlock never throws), so the default path is
    // byte-identical when mem0 is empty or unavailable.
    readAtSynthesis: z.boolean().default(true),
    // Max REINFORCE bullets injected into the synthesis prompt.
    reinforceCap: z.number().int().min(1).max(20).default(5),
    // Max AVOID bullets injected into the synthesis prompt.
    avoidCap: z.number().int().min(1).max(20).default(5),
    // mem0 search limit per verdict bucket (3 parallel queries).
    searchLimit: z.number().int().min(1).max(50).default(12),
  })
  .default({
    writeBack: true,
    readAtSynthesis: true,
    reinforceCap: 5,
    avoidCap: 5,
    searchLimit: 12,
  });
export type OutcomeMemoryConfig = z.infer<typeof outcomeMemoryConfigSchema>;

// Multi-hop graph reasoning: a bounded "opportunity paths" directive traversed
// from the live Neo4j graph (the mem0 graph store) and injected at Pass-1 seed
// discovery as GUIDANCE. Default OFF — gated together with sige.neo4j.enabled so
// neither flag alone constructs a client; degrades to "" on any failure, leaving
// the default seed prompt byte-identical. The traversal caps below are bound as
// $params into the read-only Cypher (no code change to tune).
export const graphReasoningConfigSchema = z
  .object({
    // Master switch for the feature. Read-only + degrade-to-empty, but kept OFF
    // by default until the live graph is validated.
    enabled: z.boolean().default(false),
    // Max hops (path length) in a returned opportunity path. Default 2: on the
    // current (undirected, hub-heavy) graph, 3-hop traversal is too slow and
    // times out; bump only with an index + perf validation.
    maxHops: z.number().int().min(2).max(6).default(2),
    // Max paths rendered into the directive (also the query LIMIT).
    maxPaths: z.number().int().min(1).max(20).default(8),
    // How many seed (pain) nodes to expand from.
    searchLimit: z.number().int().min(1).max(100).default(25),
    // Lower degree bound on the seed node (skips one-off leaf noise).
    minDegree: z.number().int().min(1).max(1000).default(3),
    // Upper degree bound on EVERY path node. Default 200: excludes the mega-hubs
    // (app_store 750 / play_store 565 / sige-global 1163 — also stoplisted) while
    // keeping legitimate popular-app nodes (facebook ~120, roblox ~154). 60 was
    // too low and filtered out all real paths.
    maxDegree: z.number().int().min(1).max(5000).default(200),
  })
  .default({
    enabled: false,
    maxHops: 2,
    maxPaths: 8,
    searchLimit: 25,
    minDegree: 3,
    maxDegree: 200,
  });
export type GraphReasoningConfig = z.infer<typeof graphReasoningConfigSchema>;

// Layer C "incumbent exclusion": drop / down-rank collector signals that
// prominently name a top-N charted (or high-review-count) app. PURE-logic + safe,
// so it defaults ON (matching adaptiveCollection). Disabling it reverts the
// collectors to the prior raw-popularity behavior.
export const incumbentExclusionConfigSchema = z
  .object({
    // Master switch. Default ON — pure de-bias, no external calls.
    enabled: z.boolean().default(true),
    // How many top-charted apps to treat as incumbents.
    topN: z.number().int().min(1).max(1000).default(100),
  })
  .default({
    enabled: true,
    topN: 100,
  });
export type IncumbentExclusionConfig = z.infer<typeof incumbentExclusionConfigSchema>;

// Layer B "competability / moat gate": penalize ideas whose market sits behind a
// moat a small/solo builder cannot overcome (the inverse of GIANT defensibility).
// Computed in the same Pass-3 critique LLM call. SHADOW mode by default
// (enforceGate=false) — mirrors giant.enforceGates so it ships safely and only
// LOGS would-reject decisions until explicitly enforced.
// The BUILDER PROFILE the competability gate is evaluated FOR. The LLM still
// scores RAW, profile-independent moats; this profile is applied as a pure,
// deterministic discount at decision time. The DEFAULT (solo bootstrapper) is the
// IDENTITY transform — zero discount — so the gate behaves exactly as before.
export const builderProfileConfigSchema = z
  .object({
    // Sustained capital the builder can deploy. "bootstrap" is the baseline.
    capital: z.enum(["none", "bootstrap", "seed", "funded"]).default("bootstrap"),
    // Team headcount; heads above 1 discount the logistics moat (capped).
    teamSize: z.number().int().min(1).max(1000).default(1),
    // Domains the builder has expertise in; a text match discounts the dominant
    // moat for that idea. Empty (default) never matches. Bounded (count + length)
    // so a pathological config can't bloat the scoring prompt.
    expertiseDomains: z.array(z.string().max(80)).max(50).default([]),
    // Appetite for entering a regulated market; "high" discounts the regulated moat.
    regulatoryAppetite: z.enum(["none", "low", "high"]).default("low"),
    // Appetite for running physical ops; "high" discounts the logistics moat.
    opsAppetite: z.enum(["none", "low", "high"]).default("low"),
  })
  .default({
    capital: "bootstrap",
    teamSize: 1,
    expertiseDomains: [],
    regulatoryAppetite: "low",
    opsAppetite: "low",
  });
export type BuilderProfileConfig = z.infer<typeof builderProfileConfigSchema>;

export const competabilityConfigSchema = z
  .object({
    // Compute + store the competability scorecard for every idea. Default ON.
    enabled: z.boolean().default(true),
    // SHADOW mode by default: log would-reject decisions but do NOT drop ideas.
    // Set true to actually enforce the competability gate. Mirrors
    // giant.enforceGates discipline so deploys don't silently start rejecting.
    enforceGate: z.boolean().default(false),
    // Overall "small builder can win" score (0..5) below which an idea is
    // hard-rejected when enforcing.
    rejectThreshold: z.number().min(0).max(5).default(2),
    // Soft-penalty band ceiling: overall in [rejectThreshold, this] is logged /
    // lightly penalized but not rejected.
    softPenaltyThreshold: z.number().min(0).max(5).default(2.5),
    // Top-N incumbents the cheap heuristic pre-filter checks idea text against.
    topNIncumbents: z.number().int().min(1).max(1000).default(100),
    // HARD per-dimension veto. A RAW (objective, profile-INDEPENDENT) moat score
    // at or above hardVetoThreshold on ANY hardVetoDimensions dimension is fatal
    // — the idea is hard-rejected regardless of overall and of builder-profile
    // discounts. Like enforceGate, it only ACTS when the gate is enforcing
    // (shadow/log-only otherwise). Default ON; default threshold 4; default
    // dimensions = all four uncompetable-for-a-solo-builder moats.
    hardVeto: z.boolean().default(true),
    hardVetoThreshold: z.number().int().min(1).max(5).default(4),
    hardVetoDimensions: z
      .array(z.enum(["regulated", "capital", "logistics", "networkEffect"]))
      // .min(1): an empty array would silently disable the veto — disabling must
      // go through the explicit `hardVeto: false` flag, not a footgun empty list.
      .min(1)
      .default(["regulated", "capital", "logistics", "networkEffect"]),
    // The builder the gate is evaluated for. Default = solo bootstrapper =
    // identity transform, so the gate behaves exactly as before.
    builderProfile: builderProfileConfigSchema,
  })
  .default({
    enabled: true,
    enforceGate: false,
    rejectThreshold: 2,
    softPenaltyThreshold: 2.5,
    topNIncumbents: 100,
    hardVeto: true,
    hardVetoThreshold: 4,
    hardVetoDimensions: ["regulated", "capital", "logistics", "networkEffect"],
    builderProfile: {
      capital: "bootstrap",
      teamSize: 1,
      expertiseDomains: [],
      regulatoryAppetite: "low",
      opsAppetite: "low",
    },
  });
export type CompetabilityConfig = z.infer<typeof competabilityConfigSchema>;

// WITHIN-RUN diversity / monoculture guard. The de-bias layers + competability
// gate can over-correct and collapse a run's kept set into ONE archetype (e.g.
// only B2B dev/vertical SaaS). This soft guard caps any single bucket's share of
// the kept set so one archetype/category cannot dominate. Default ON, pure-logic
// (no external calls) — COMPLEMENTS the across-run saturatedThemes dedup. Fully
// defaulted -> backward-compatible.
export const diversityGuardConfigSchema = z
  .object({
    // Master switch. Default ON — pure de-bias, no external calls.
    enabled: z.boolean().default(true),
    // Share ceiling (0..1) any single bucket may occupy in the kept set when
    // diverse alternatives exist. ~0.5 => no archetype exceeds half the set.
    maxBucketShare: z.number().min(0).max(1).default(0.5),
    // Which candidate field defines a bucket. Archetype is the canonical
    // monoculture axis; category is the free-text fallback.
    bucketBy: z.enum(["archetype", "category"]).default("archetype"),
    // SIGNAL/SEED guard: caps how many ideas a SINGLE source signal (seed) may
    // spawn, on TOP of the archetype/category cap above. Attacks "one seed, many
    // reskins" — the archetype guard alone lets one signal seed many ideas that
    // happen to land in different archetypes. Composed AFTER the bucket guard.
    signalGuard: z.boolean().default(true),
    // Share ceiling (0..1) any single source signal may occupy in the kept set.
    // ~0.34 => one signal seeds at most ⌈maxIdeas·0.34⌉ ideas (2 of 5, 3 of 8).
    maxSignalShare: z.number().min(0).max(1).default(0.34),
  })
  .default({
    enabled: true,
    maxBucketShare: 0.5,
    bucketBy: "archetype",
    signalGuard: true,
    maxSignalShare: 0.34,
  });
export type DiversityGuardConfig = z.infer<typeof diversityGuardConfigSchema>;

// STAGE 1 — broad stratified intake. Caps how much any single
// (source kind × signalType) bucket may occupy in the collector candidate
// pool, so one hot source/signalType cannot monopolize the seeds feeding
// BOTH funnels. Pure selection; default ON, fully reversible.
export const stratifiedIntakeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Max candidates any single `${kind}:${signalType}` bucket may contribute.
    perBucketCap: z.number().int().min(1).max(100).default(8),
    // Hard ceiling on the stratified pool size returned to the funnel.
    totalCap: z.number().int().min(1).max(500).default(90),
    // Per-source raw fetch window (total rows pulled before ranking/stratifying);
    // split ~30/70 top/midtier for windowed sources.
    fetchLimit: z.number().int().min(10).max(500).default(100),
    // What the stratified bucket key is keyed on.
    //  - "signalCategory" (default, hybrid): enriched rows bucket on their
    //    LLM-extracted theme (`${category}:${table}`); un-enriched rows fall
    //    back to the legacy source/sub-source key (`${signalType}:${table}`),
    //    so low enrichment coverage degrades to ~today's source stratification
    //    rather than collapsing into one bucket.
    //  - "signalType" (legacy): every row buckets on the exact pre-theme key
    //    (`${table}:${signalType}`). Reversible escape hatch.
    bucketBy: z.enum(["signalType", "signalCategory"]).default("signalCategory"),
  })
  .default({
    enabled: true,
    perBucketCap: 8,
    totalCap: 90,
    fetchLimit: 100,
    bucketBy: "signalCategory",
  });
export type StratifiedIntakeConfig = z.infer<typeof stratifiedIntakeConfigSchema>;

// MAIN-pipeline independent jury. `quality_score` is otherwise a pure
// pass-through of the giant composite emitted by the SAME LLM that wrote the
// idea (Pass-3 self-critique) — a self-serving grade with no independent check.
// This runs the existing cross-family jury (jury.ts) on the MAIN (non-SIGE)
// path and blends its verdict into quality under a ONE-SIDED min-lean rule: the
// jury may only PENALIZE a self-inflated idea, never inflate one. It costs LLM
// calls, so the flag cleanly disables it; it shares the SIGE `judgeModels`
// panel definition (no duplication) and is a graceful no-op when no judge key
// is configured. The SIGE valuation path runs its OWN jury, so exactly one jury
// pass runs per run (the pipeline gates this off when SIGE valuation is on).
export const independentJuryConfigSchema = z
  .object({
    // Master switch. Default ON. Disabling skips the jury LLM calls entirely.
    enabled: z.boolean().default(true),
    // Min-lean penalty weight λ. The maximum fraction of the (giant − jury) gap
    // a UNANIMOUS jury can close; a split jury penalizes proportionally less.
    // 0 disables the pull (no penalty); 1 pulls fully to a confident jury.
    penaltyWeight: z.number().min(0).max(1).default(0.7),
  })
  .default({
    enabled: true,
    penaltyWeight: 0.7,
  });
export type IndependentJuryConfig = z.infer<typeof independentJuryConfigSchema>;

// SEED-DIVERSITY: attacks generation-seed MONOCULTURE at the SOURCE (the
// collectors), upstream of the within-run diversityGuard. Three levers:
//   1. focusRotation — rotate WHICH review categories seed the run (keep a
//      high-opportunity head, rotate the tail by a per-run seed, avoid
//      recently-anchored categories) instead of always the same lowest-rated set.
//   2. painThemesLeadSummary — lead the pain seed with the SPECIFIC LLM-extracted
//      pain themes so a concrete recurring complaint (not the bare store-category
//      name) is the primary pain seed reaching the generator prompt.
//   3. echoChamberDownweight — down-weight (not drop) AI-builder-meta capability
//      signals so the funnel isn't dominated by "build an AI agent" echo chamber.
// All levers default ON, pure-logic (no external calls). Fully defaulted ->
// backward-compatible.
export const seedDiversityConfigSchema = z
  .object({
    // Master switch for all three levers. Default ON.
    enabled: z.boolean().default(true),
    // Lever 1: rotate focus categories across runs (vs. always the lowest-rated).
    focusRotation: z.boolean().default(true),
    // Total focus categories to feed clusterReviews.
    focusSpread: z.number().int().min(1).max(40).default(8),
    // How many of those come from the genuine high-opportunity head (lowest
    // avgRating / most acute complaint ratio). The remainder are rotated.
    highOpportunitySlice: z.number().int().min(0).max(40).default(4),
    // How many recent generated_ideas.category rows to treat as "anchored" and
    // de-prioritize in the rotated tail.
    recentAnchorLookback: z.number().int().min(0).max(500).default(40),
    // Lever 2: lead pains.summary with specific LLM pain themes.
    painThemesLeadSummary: z.boolean().default(true),
    // Max specific pain themes rendered ahead of the category aggregate.
    maxLeadingPainThemes: z.number().int().min(1).max(50).default(15),
    // Lever 3: down-weight AI-builder-meta capability signals.
    echoChamberDownweight: z.boolean().default(true),
    // Multiplier applied to a meta signal's rank score (REDUCE, not eliminate).
    echoChamberFactor: z.number().min(0).max(1).default(0.5),
  })
  .default({
    enabled: true,
    focusRotation: true,
    focusSpread: 8,
    highOpportunitySlice: 4,
    recentAnchorLookback: 40,
    painThemesLeadSummary: true,
    maxLeadingPainThemes: 15,
    echoChamberDownweight: true,
    echoChamberFactor: 0.5,
  });
export type SeedDiversityConfig = z.infer<typeof seedDiversityConfigSchema>;

export const smartConfigSchema = z.object({
  // External-service / expensive-LLM gates: default OFF so the pipeline's
  // default runtime path and existing tests are unchanged.
  sigeValuation: z.boolean().default(false),
  // Default ON: read-only retrieval that injects mem0 graph FACTS into synthesis.
  // The graph is now populated, so this leverages it with no autonomous feedback
  // loop. Retrieved facts are sanitize + untrusted-fenced before they reach the
  // prompt (graphEvidence), and deepSearch degrades to the model-only path on any
  // mem0 failure — so the flip adds grounding, not a new failure or injection mode.
  knowledgeGraphRetrieval: z.boolean().default(true),
  deepSearchReranker: z.boolean().default(false),
  signalFacets: z.boolean().default(false),
  // Importance/relevance SCORING + CALIBRATION + retrieval filtering for
  // scraped signals. Layered on top of signalFacets; default OFF.
  signalRanking: z.boolean().default(false),
  // Retrieval filter floor for ranked-signal importance buckets.
  signalImportanceFloor: z.enum(["noise", "low", "medium", "high"]).default("low"),
  // Pure-logic improvements: safe, default ON (they change default idea
  // output by design but add no external calls).
  adaptiveCollection: z.boolean().default(true), // velocity/credibility/corroboration ordering
  validatedExemplars: z.boolean().default(true), // positive few-shot
  chainOfEvidence: z.boolean().default(true), // signal-ID binding + verify
  rerankTopK: z.number().int().min(4).max(50).default(6),
  rerankFetchK: z.number().int().min(10).max(100).default(30),
  // The GIANT shared optimization target. Compute + store in SHADOW mode by
  // default (enforceGates=false). Fully defaulted -> backward-compatible.
  giant: giantConfigSchema,
  // Phase 1 "generate-wide": over-generation + multi-segment spread + optional
  // SIGE divergent merge. Fully defaulted -> backward-compatible.
  generateWide: generateWideConfigSchema,
  // Phase 2 "demand-side grounding": cited, deterministic buyer-intent evidence
  // per idea. Fully defaulted -> backward-compatible.
  demand: demandConfigSchema,
  // Phase 3 SIGE hardening: independent multi-family judge, first-class dissent,
  // convergence veto. Only active when sigeValuation is ON. Fully defaulted ->
  // backward-compatible.
  sige: sigeHardeningConfigSchema,
  // Phase 4 "warm the cold taste loop": anti-exemplars, synthetic golden-set
  // bootstrap, auto-proxy labels, optional GIANT axis-weight calibration.
  // Fully defaulted -> backward-compatible.
  taste: tasteConfigSchema,
  // Phase 5 "autonomous SIGE": seedless autonomous idea generation driven by
  // SIGE breadth + depth stages. Default OFF — no behavior change until enabled.
  sigeAuto: sigeAutoConfigSchema,
  // Phase 6 "outcome memory": verdict write-back + synthesis-time guidance via
  // mem0. Both flags now default ON — the REINFORCE/AVOID learning loop is live.
  outcomeMemory: outcomeMemoryConfigSchema,
  // Multi-hop graph reasoning: bounded "opportunity paths" directive at Pass-1.
  // Default OFF (gated together with sige.neo4j.enabled). Fully defaulted ->
  // backward-compatible.
  graphReasoning: graphReasoningConfigSchema,
  // Layer C "incumbent exclusion": drop/down-rank collector signals that name a
  // top-N incumbent. Pure-logic + safe — default ON. Fully defaulted ->
  // backward-compatible.
  incumbentExclusion: incumbentExclusionConfigSchema,
  // Layer B "competability gate": penalize ideas behind a small-builder-fatal
  // moat. SHADOW mode by default (enforceGate=false). Fully defaulted ->
  // backward-compatible.
  competability: competabilityConfigSchema,
  // WITHIN-RUN diversity guard: cap any single archetype/category's share of the
  // kept set so the funnel can't collapse into one monoculture. Default ON,
  // pure-logic. Fully defaulted -> backward-compatible.
  diversityGuard: diversityGuardConfigSchema,
  // SEED diversity: attack generation-seed monoculture at the collectors
  // (focus-category rotation + specific-pain-theme lead + echo-chamber
  // down-weight). Default ON, pure-logic. Fully defaulted -> backward-compatible.
  seedDiversity: seedDiversityConfigSchema,
  // MAIN-pipeline independent jury: blend a cross-family jury verdict into
  // quality_score under a one-sided min-lean penalty so quality is not a pure
  // self-grade. Default ON; gracefully no-ops without a judge key. Fully
  // defaulted -> backward-compatible.
  independentJury: independentJuryConfigSchema,
  // Stage 2 "broad-shallow ideation": cheap one-line sketch over many candidate
  // themes → diversity-select a few. Default OFF (reversible). Fully defaulted ->
  // backward-compatible: when off, the synthesizer keeps today's narrow neck.
  shallowIdeation: shallowIdeationConfigSchema,
  // Stage 3 deep-develop count: how many DIVERSE sketches the synthesizer
  // deep-develops when shallowIdeation is on (the new neck width). ~5-6.
  deepDevelopCount: z.number().int().min(1).max(20).default(6),
  // STAGE 1 — broad stratified intake: balanced cross-bucket collector pool.
  // Default ON, pure-logic, fully reversible. Fully defaulted ->
  // backward-compatible.
  stratifiedIntake: stratifiedIntakeConfigSchema,
  // Outer deadline for the entire synthesis runStep (Pass-1 intersections +
  // Pass-2 deep-develop + Pass-3 critique + competability + demand + jury).
  // The per-call 210 s LLM timeout (createCallDeadline) already bounds
  // individual hangs; this caps the TOTAL step so a legitimately-slow but
  // progressing run with a capable/slow model (e.g. deepseek-v4-pro, ~12 min)
  // is not killed by the generic 12-min DEFAULT_STEP_DEADLINE_MS.
  // Default: 25 min. Min: 5 min. Max: 60 min.
  synthesisDeadlineMs: z.number().int().min(300_000).max(3_600_000).default(1_500_000),
});

const SMART_IDEAS_DEFAULTS = {
  sigeValuation: false,
  knowledgeGraphRetrieval: true,
  deepSearchReranker: false,
  signalFacets: false,
  signalRanking: false,
  signalImportanceFloor: "low",
  adaptiveCollection: true,
  validatedExemplars: true,
  chainOfEvidence: true,
  rerankTopK: 6,
  rerankFetchK: 30,
  giant: {
    enabled: true,
    enforceGates: false,
    weights: { ...GIANT_DEFAULT_WEIGHTS },
  },
  generateWide: {
    overGenerate: true,
    seedsPerIntersection: 5,
    maxCandidates: 40,
    multiSegment: true,
    sigeDivergent: false,
    chunkSize: 2,
  },
  demand: {
    enabled: true,
    redditIntent: true,
    fundingSignal: true,
    reviewComplaint: true,
    hnIntent: true,
    xIntent: true,
    weakIntent: true,
    weakIntentFactor: 0.35,
    weakIntentMinEngagement: 1.5,
    fuzzyMatch: true,
    phSupply: true,
    externalTrends: false,
    minMatches: 2,
    minKeywordHits: 2,
  },
  sige: {
    independentJudge: true,
    judgeModels: SIGE_DEFAULT_JUDGE_MODELS.map((m) => ({ ...m })),
    dissentWeight: 0.15,
    convergenceVetoThreshold: 0.85,
    convergenceVetoAction: "log",
    deepTier: true,
  },
  taste: {
    antiExemplars: true,
    syntheticGolden: true,
    autoProxyLabels: true,
    calibrateGiantWeights: false,
    exemplarCount: 4,
    goldenMinHumanLabels: 10,
  },
  sigeAuto: {
    enabled: false,
    maxDeepFrontiers: 1,
    broadFrontierCap: 8,
    broadPoolSize: 50,
    cadence: "daily",
    maxConcurrent: 1,
    memoryWriteback: false,
    perRunCostCeilingUsd: 0,
    semanticFrontiers: { enabled: true, similarityThreshold: 0.62 },
  },
  outcomeMemory: {
    writeBack: true,
    readAtSynthesis: true,
    reinforceCap: 5,
    avoidCap: 5,
    searchLimit: 12,
  },
  graphReasoning: {
    enabled: false,
    maxHops: 2,
    maxPaths: 8,
    searchLimit: 25,
    minDegree: 3,
    maxDegree: 200,
  },
  incumbentExclusion: {
    enabled: true,
    topN: 100,
  },
  competability: {
    enabled: true,
    enforceGate: false,
    rejectThreshold: 2,
    softPenaltyThreshold: 2.5,
    topNIncumbents: 100,
    hardVeto: true,
    hardVetoThreshold: 4,
    hardVetoDimensions: [
      "regulated",
      "capital",
      "logistics",
      "networkEffect",
    ] as ("regulated" | "capital" | "logistics" | "networkEffect")[],
    builderProfile: {
      capital: "bootstrap",
      teamSize: 1,
      expertiseDomains: [] as string[],
      regulatoryAppetite: "low",
      opsAppetite: "low",
    },
  },
  diversityGuard: {
    enabled: true,
    maxBucketShare: 0.5,
    bucketBy: "archetype",
    signalGuard: true,
    maxSignalShare: 0.34,
  },
  seedDiversity: {
    enabled: true,
    focusRotation: true,
    focusSpread: 8,
    highOpportunitySlice: 4,
    recentAnchorLookback: 40,
    painThemesLeadSummary: true,
    maxLeadingPainThemes: 15,
    echoChamberDownweight: true,
    echoChamberFactor: 0.5,
  },
  independentJury: {
    enabled: true,
    penaltyWeight: 0.7,
  },
  shallowIdeation: {
    enabled: false,
    candidateCount: 30,
    batchSize: 10,
    model: "",
  },
  deepDevelopCount: 6,
  stratifiedIntake: {
    enabled: true,
    perBucketCap: 8,
    totalCap: 90,
    fetchLimit: 100,
    bucketBy: "signalCategory",
  },
  // 25 min: generous outer bound for the multi-LLM synthesis step.
  synthesisDeadlineMs: 1_500_000,
} as const;

export const ideasPipelineConfigSchema = z
  .object({
    smart: smartConfigSchema.default({ ...SMART_IDEAS_DEFAULTS }),
  })
  .default({
    smart: { ...SMART_IDEAS_DEFAULTS },
  });

export const pipelinesConfigSchema = z
  .object({
    ideas: ideasPipelineConfigSchema.default({
      smart: { ...SMART_IDEAS_DEFAULTS },
    }),
  })
  .default({
    ideas: { smart: { ...SMART_IDEAS_DEFAULTS } },
  });

export const opencrowConfigSchema = z.object({
  agent: agentConfigSchema.default({
    model: "claude-sonnet-4-6",
    systemPrompt: "You are OpenCrow, a helpful personal AI assistant. Be concise and direct.",
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
      whatsapp: whatsappConfigSchema.optional(),
    })
    .default({
      telegram: { allowedUserIds: [] },
    }),
  web: webConfigSchema.default({
    port: 48080,
    host: "0.0.0.0",
  }),
  internalApi: internalApiConfigSchema.default({
    port: 48081,
    host: "127.0.0.1",
  }),
  browser: browserConfigSchema.default({ enabled: false }),
  tools: toolsConfigSchema.default({
    allowedDirectories: [DEFAULT_AGENT_WORKSPACE],
    blockedCommands: [...DEFAULT_BLOCKED_COMMANDS],
    dangerousCommandBlocking: true,
    sandbox: "best-effort",
    devToolsAllowNetwork: false,
    allowUnsandboxedDevTools: false,
    maxBashTimeout: 600_000,
    maxFileSize: 10_485_760,
    maxIterations: 200,
  }),
  cron: cronConfigSchema.default({
    defaultTimeoutSeconds: 300,
    tickIntervalMs: 10000,
    maxConcurrency: 4,
  }),
  postgres: postgresConfigSchema.default({
    url: "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow",
    max: 20,
  }),
  embeddings: embeddingsConfigSchema,
  memorySearch: memorySearchConfigSchema.optional(),
  observations: observationsConfigSchema,
  monitor: monitorConfigSchema,
  processes: processesConfigSchema,
  rateLimit: rateLimitConfigSchema,
  memoryEviction: memoryEvictionConfigSchema.optional(),
  sige: sigeConfigSchema.optional(),
  // Data ingestion → mem0. Top-level (shared infra), independent of `sige`.
  ingestion: ingestionConfigSchema,
  // Reddit corpus de-bias: curated allowlist + echo-chamber/crypto denylist.
  redditCorpus: redditCorpusConfigSchema,
  pipelines: pipelinesConfigSchema.default({
    ideas: { smart: { ...SMART_IDEAS_DEFAULTS } },
  }),
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
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export type CronConfig = z.infer<typeof cronConfigSchema>;
export type MemorySearchConfig = z.infer<typeof memorySearchConfigSchema>;
export type MemoryBackendKind = z.infer<typeof memoryBackendKindSchema>;
export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type QdrantConfig = z.infer<typeof qdrantConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;
export type InternalApiConfig = z.infer<typeof internalApiConfigSchema>;
export type ObservationsConfig = z.infer<typeof observationsConfigSchema>;
export type ProcessSpec = z.infer<typeof processSpecSchema>;
export type ProcessesConfig = z.infer<typeof processesConfigSchema>;
export type AgentProcessesConfig = z.infer<typeof agentProcessesConfigSchema>;
export type ScraperProcessesConfig = z.infer<typeof scraperProcessesConfigSchema>;
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export type MonitorThresholds = z.infer<typeof monitorThresholdsSchema>;
export type ModelParams = z.infer<typeof modelParamsSchema>;
export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;
export type RateLimitPerSenderConfig = z.infer<typeof rateLimitPerSenderSchema>;
export type MemoryEvictionConfig = z.infer<typeof memoryEvictionConfigSchema>;
export type SigeConfig = z.infer<typeof sigeConfigSchema>;
export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;
export type SmartIdeasConfig = z.infer<typeof smartConfigSchema>;
export type GiantConfig = z.infer<typeof giantConfigSchema>;
export type GenerateWideConfig = z.infer<typeof generateWideConfigSchema>;
export type DemandConfig = z.infer<typeof demandConfigSchema>;
export type SigeHardeningConfig = z.infer<typeof sigeHardeningConfigSchema>;
export type TasteConfig = z.infer<typeof tasteConfigSchema>;
export type IdeasPipelineConfig = z.infer<typeof ideasPipelineConfigSchema>;
export type PipelinesConfig = z.infer<typeof pipelinesConfigSchema>;
export type RedditCorpusConfig = z.infer<typeof redditCorpusConfigSchema>;
// SigeAutoConfig and OutcomeMemoryConfig are also exported directly from their
// schema declarations above.
