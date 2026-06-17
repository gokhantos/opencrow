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
  provider: z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic"]).optional(),
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

export const embeddingsConfigSchema = z
  .object({
    provider: z.enum(["openrouter", "ollama"]).default("openrouter"),
    /** Base URL of an OpenAI-compatible embeddings API. Defaults per provider. */
    baseUrl: z.string().optional(),
    /** Embedding vector dimensions */
    dimensions: z.number().int().min(32).max(4096).default(4096),
    /** OpenRouter model to use */
    openrouterModel: z.string().default("qwen/qwen3-embedding-8b"),
    /** Generic model name (any provider). Falls back to openrouterModel. */
    model: z.string().optional(),
    /** Max texts per API batch */
    batchSize: z.number().int().min(1).default(64),
  })
  .default({
    provider: "openrouter",
    dimensions: 4096,
    openrouterModel: "qwen/qwen3-embedding-8b",
    batchSize: 64,
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
    scraperIds: z.array(z.string()).default([]),
  })
  .default({
    entry: "src/entries/scraper.ts",
    restartPolicy: "always",
    scraperIds: [],
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

export const sigeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mem0: z.object({
    baseUrl: z.string().url().default("http://127.0.0.1:8050"),
    userId: z.string().default("sige-global"),
  }).default({
    baseUrl: "http://127.0.0.1:8050",
    userId: "sige-global",
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
  provider: z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic"]).default("anthropic"),
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
        nonObviousness: z
          .number()
          .default(GIANT_DEFAULT_WEIGHTS.nonObviousness),
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
  })
  .default({
    overGenerate: true,
    seedsPerIntersection: 5,
    maxCandidates: 40,
    multiSegment: true,
    sigeDivergent: false,
  });

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
    // Pluggable external search-volume / trends vendor. Default OFF (stubbed).
    externalTrends: z.boolean().default(false),
    // Minimum matched rows before demand evidence is considered corroborated;
    // below this the artifact takes the absence penalty (low score/confidence).
    minMatches: z.number().int().min(1).default(2),
  })
  .default({
    enabled: true,
    redditIntent: true,
    fundingSignal: true,
    externalTrends: false,
    minMatches: 2,
  });

// Cross-family default jury for the hardened SIGE judge. These models are ONLY
// instantiated when smart.sigeValuation is ON; any provider without a key is
// gracefully skipped at runtime. The mix is intentionally multi-family so the
// independent judge does not share a model lineage with the generators.
export const SIGE_DEFAULT_JUDGE_MODELS: readonly { provider: string; model: string }[] =
  [
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
    { provider: "alibaba", model: "qwen3.5-plus" },
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
    // Enable the expensive deep-reasoning tier of the judge.
    deepTier: z.boolean().default(true),
  })
  .default({
    independentJudge: true,
    judgeModels: SIGE_DEFAULT_JUDGE_MODELS.map((m) => ({ ...m })),
    dissentWeight: 0.15,
    convergenceVetoThreshold: 0.85,
    deepTier: true,
  });

export const smartConfigSchema = z.object({
  // External-service / expensive-LLM gates: default OFF so the pipeline's
  // default runtime path and existing tests are unchanged.
  sigeValuation: z.boolean().default(false),
  knowledgeGraphRetrieval: z.boolean().default(false),
  deepSearchReranker: z.boolean().default(false),
  signalFacets: z.boolean().default(false),
  // Importance/relevance SCORING + CALIBRATION + retrieval filtering for
  // scraped signals. Layered on top of signalFacets; default OFF.
  signalRanking: z.boolean().default(false),
  // Retrieval filter floor for ranked-signal importance buckets.
  signalImportanceFloor: z
    .enum(["noise", "low", "medium", "high"])
    .default("low"),
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
});

const SMART_IDEAS_DEFAULTS = {
  sigeValuation: false,
  knowledgeGraphRetrieval: false,
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
  },
  demand: {
    enabled: true,
    redditIntent: true,
    fundingSignal: true,
    externalTrends: false,
    minMatches: 2,
  },
  sige: {
    independentJudge: true,
    judgeModels: SIGE_DEFAULT_JUDGE_MODELS.map((m) => ({ ...m })),
    dissentWeight: 0.15,
    convergenceVetoThreshold: 0.85,
    deepTier: true,
  },
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
  tools: toolsConfigSchema.default({
    allowedDirectories: [DEFAULT_AGENT_WORKSPACE],
    blockedCommands: [...DEFAULT_BLOCKED_COMMANDS],
    dangerousCommandBlocking: true,
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
export type CronConfig = z.infer<typeof cronConfigSchema>;
export type MemorySearchConfig = z.infer<typeof memorySearchConfigSchema>;
export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type QdrantConfig = z.infer<typeof qdrantConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;
export type InternalApiConfig = z.infer<typeof internalApiConfigSchema>;
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
export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;
export type RateLimitPerSenderConfig = z.infer<typeof rateLimitPerSenderSchema>;
export type MemoryEvictionConfig = z.infer<typeof memoryEvictionConfigSchema>;
export type SigeConfig = z.infer<typeof sigeConfigSchema>;
export type SmartIdeasConfig = z.infer<typeof smartConfigSchema>;
export type GiantConfig = z.infer<typeof giantConfigSchema>;
export type GenerateWideConfig = z.infer<typeof generateWideConfigSchema>;
export type DemandConfig = z.infer<typeof demandConfigSchema>;
export type SigeHardeningConfig = z.infer<typeof sigeHardeningConfigSchema>;
export type IdeasPipelineConfig = z.infer<typeof ideasPipelineConfigSchema>;
export type PipelinesConfig = z.infer<typeof pipelinesConfigSchema>;
