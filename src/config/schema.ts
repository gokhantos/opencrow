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

// ─── App Store keyword-gap scanner ─────────────────────────────────────────
// Standalone scanner feature (independent of the SIGE ideas pipeline, like
// `ingestion`/`redditCorpus` above): scans App Store keywords for volume/
// difficulty gaps against the app's current ranking, optionally seeding from
// autocomplete expansion. Fully Zod-defaulted so `parse({})` is safe. The
// feature is ON by default — set `enabled: false` to turn off the scan loop.
//
// Timer-driven, stalest-first, rolling-cap model: the scraper runs this on
// its own independent timer (decoupled from the ~hourly ranking tick — see
// scraper.ts), and each cycle scans the `keywordsPerSweep` globally stalest
// active keywords across the WHOLE corpus (no per-zone rotation/gate — the
// timer interval IS the cadence). `dailyKeywordBudget` is no longer a
// per-cycle spend but a rolling 24h safety ceiling: if the corpus has
// already been scanned that many times in the last 24h, a sweep cycle is
// skipped rather than spending more lookups.
//
// ─── MAX-THROUGHPUT PASS (2026-07-22) ──────────────────────────────────────
// Diagnosis: prior raises (`dailyKeywordBudget`, `minedExploration.dailyQuota`)
// lifted CEILINGS while daily keyword-scan volume stayed flat at ~18k/day —
// live sweep logs showed `effectiveKeywordsPerSweep: 75`,
// `effectiveDelayMs: 1000`, `mineQuotaRemaining: 28,056/30,000` (93% of the
// mined quota unused). The ceilings were never the governor; `keywordsPerSweep`
// / `sweepDelayMs` (this sweep's actual per-cycle batch size + inter-request
// pace, both consumed by `scraper.ts`'s `keywordSweepTick` via
// `sweep-throttle.ts`'s `computeEffectiveSweepRate`) were. Root cause of the
// mined-quota waste specifically: at `keywordsPerSweep` = 75, the hot lane
// (≤50/sweep) plus tier 1 (uncapped; `tier1AutocompleteCap` alone = 50) could
// already exceed the whole batch, crowding the mined lane out of most sweeps
// before its OWN per-sweep cap (`computePerSweepCap` in `keyword-tiering.ts`)
// ever bound.
//
// This pass raises the actual governors: `keywordsPerSweep` 75 -> 600,
// `sweepDelayMs` 1000ms -> 150ms (safe now that this lane is proxy-backed —
// per-request IP rotation via the paid Webshare proxy, `useProxy` below,
// removes the per-IP 429 ceiling that motivated the old conservative pace),
// `minedExploration.dailyQuota` 30,000 -> 100,000 (which also lifts its
// derived per-sweep cap from 21 to 70 mined slots/sweep — see that field's
// own doc comment for the full math), and `dailyKeywordBudget` 60,000 ->
// 150,000 so the raised governors have ceiling headroom to actually operate
// under rather than tripping the safety cap. `useProxy` is also flipped ON
// for `appstoreAppEnrichment` and `appstoreNewbornReobservation` (previously
// the only two remaining appstore lanes still direct-IP by default) for
// consistency with every other high-volume lane.
//
// Projected math (batch-capacity ceiling, same methodology as
// `keywordsPerSweep`'s own doc comment): at 600 keywords/sweep and an assumed
// ~400ms average iTunes latency on top of the 150ms configured delay, one
// sweep takes 600 * 0.55s ≈ 330s, which the `scanIntervalMs` = 60s
// single-flight guard rounds up to a 360s (6-minute) effective cadence — 600
// * 3600 / 360 ≈ 6,000/hour ≈ 144,000/day theoretical ceiling for the
// combined hot+tier1+mined batch if every sweep filled all 600 slots. Real
// daily volume is lower than that ceiling in practice — hot/tier1 are
// self-limiting to their own due-staleness pools (typically well under 600).
//
// ─── CONTINUOUS FETCH (2026-07-23) ──────────────────────────────────────────
// This pass ALSO derived a per-sweep pacing cap on mined exploration from
// `minedExploration.dailyQuota`/`scanIntervalMs` (~70/sweep at the defaults
// above), spreading it evenly across the sweeps a nominal cadence implies.
// Live measurement found that pacing WAS the idle-sweep mechanism: with a
// mined backlog (never-scanned keywords, ~120k of them) that vastly exceeds
// any single sweep's batch, the paced cap left most of a 600-keyword batch
// unfilled once hot+tier1 ran out — the process fetched a small "due" slice
// each cycle, then sat idle until keywords went stale again, rather than
// continuously fetching. `computePerSweepCap` (keyword-tiering.ts) is
// retired; `keyword-gaps.ts`'s `runKeywordSweep` now passes this cycle's own
// batch limit as the mined ceiling, so mined exploration fills the WHOLE
// remaining batch every cycle whenever the backlog supports it (see
// `minedExploration.dailyQuota`'s own doc comment below). The adaptive
// throttle (`sweepRateSafety` below, `sweep-throttle.ts`) is now the primary
// regulator instead of idle gaps: it backs off on a real 429 spike
// (`throttleBackoffFactor`) and recovers gradually once errors clear
// (`throttleRecoveryStep`), so the sustained rate settles just under Apple's
// real ceiling rather than the idle-paced ~18-36k/day observed before this
// retune. Plus the DE storefront lane's own ~8,640/day (chunked, unchanged —
// see `deStorefrontLane`). Against the ~120k-keyword active corpus at the
// time of this pass, throughput beyond a roughly daily full-corpus pass buys
// FASTER RE-OBSERVATION (fresher demand/velocity signal on already-known
// keywords), not more first-time coverage — there is no more "new" corpus to
// discover into once a day's sweep volume clears the corpus size.
export const appstoreKeywordGapConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Gap between sweep cycles (run-then-reschedule), driven by its own
    // timer independent of the ranking tick. Default 1 minute — the floor —
    // so the scanner sweeps as many times per day as the throttle allows.
    // (Each sweep still spaces its per-keyword iTunes calls by
    // `sweepDelayMs`, so `keywordsPerSweep` keywords/sweep fits inside a
    // 1-minute window; a single-flight guard skips the next tick if a sweep
    // runs long — see `sweep-throttle.ts` for the full throughput math.)
    scanIntervalMs: z.number().int().min(60_000).default(60_000),
    // Delay between each keyword's iTunes call WITHIN a sweep. Was a
    // hardcoded 2000ms shared with the ranking scraper's own per-app calls
    // (`REQUEST_DELAY_MS` in scraper.ts) — split out so the sweep's rate can
    // be tuned (and adaptively throttled — see `sweepRateSafety` below)
    // independent of the ranking scraper. MAX-THROUGHPUT PASS (2026-07-22):
    // lowered 1000ms -> 150ms. This lane is now proxy-backed
    // (`useProxy` below, per-request IP rotation via Webshare — see
    // `appstore-proxy.ts`), so the per-IP rate-limit ceiling that motivated
    // the old, conservative 1000ms no longer binds — 150ms is the delay
    // floor's next-cheapest step (schema `min(100)`) that still leaves a
    // visible per-request pace for `sweepRateSafety`'s adaptive throttle to
    // read a meaningful error-rate signal from before backing off further.
    // See `keywordsPerSweep` below for the full daily-volume projection.
    sweepDelayMs: z.number().int().min(100).max(10_000).default(150),
    // How many keyword scans may be spent per rolling 24h window — a safety
    // ceiling, not a per-cycle spend. Enforced against a live count of
    // `appstore_keyword_scans` rows from the last 24h (tier1 + mined + the
    // DE storefront lane below all write through the same table, so all
    // three count toward this one ceiling — see `keyword-store.ts`'s
    // `countScansSince`); a sweep cycle is skipped once the ceiling is
    // reached. MAX-THROUGHPUT PASS (2026-07-22): raised 60,000 -> 150,000
    // (max ceiling 100,000 -> 200,000 to leave headroom above the new
    // default) alongside `keywordsPerSweep` 75->600 and `sweepDelayMs`
    // 1000ms->150ms below and `minedExploration.dailyQuota` 30,000->100,000.
    // This IS a ceiling, not a governor — see those fields' own doc comments
    // for the real per-sweep/per-day math; this value only needs to sit
    // above whatever that math projects so it never becomes the binding
    // constraint. Revisit if `countScansSince` starts approaching 150,000.
    dailyKeywordBudget: z.number().int().min(1).max(200_000).default(150_000),
    // Throughput wave (2026-07-21), item 1: routes this lane's iTunes
    // Search API calls (tier1 + mined SERP scan, AND the DE storefront lane
    // below — both go through `keyword-gaps.ts`'s `fetchTopApps`) through
    // the Webshare rotating proxy when `getAppstoreProxyUrl()` resolves
    // (see `appstore-proxy.ts`). Was default OFF ("this lane has an
    // empirically proven safe direct-fetch rate, no reason to add a proxy
    // hop"). Flipped ON 2026-07-21 (capacity-raise escalation): the proxy is
    // now armed and PAID (per-request rotating IP, not a shared/free tier),
    // so this is a proactive move ahead of raising `minedExploration`'s
    // quota and `deStorefrontLane`'s cadence below — spreading the
    // highest-volume lane's traffic across rotating IPs before it needs to,
    // rather than waiting for 429s to force the flip.
    // REVERTED to direct 2026-07-23: Apple's iTunes JSON search API returns
    // HTTP 403 on Webshare datacenter exit IPs (intermittent — pool is partly
    // Apple-blocklisted), so proxying this lane broke scans (scanned:0/failed:5
    // at the higher rate). Direct is 100% clean (Apple never 403s the box IP)
    // and the adaptive throttle self-regulates against direct 429s. Proxy stays
    // ON only for the bot-sensitive app-pages HTML lane, where it belongs.
    useProxy: z.boolean().default(false),
    // How many of the globally stalest active keywords to scan per sweep
    // cycle — THE per-sweep governor (not `dailyKeywordBudget`/
    // `minedExploration.dailyQuota`, which are safety ceilings a sweep only
    // ever consults, never expands into on their own). MAX-THROUGHPUT PASS
    // (2026-07-22): raised 75 -> 600 (max ceiling 500 -> 1000) together with
    // `sweepDelayMs` 1000ms -> 150ms above, now that the whole lane is
    // proxy-backed (`useProxy` below). Math (same methodology as the prior
    // 75/1000ms revision's comment, updated for the new values): at the same
    // assumed ~400ms average iTunes fetch latency on top of the configured
    // delay, a 600-keyword batch takes 600 * (150ms + 400ms) ≈ 330s, which
    // the interval-aligned single-flight guard (`scanIntervalMs` = 60s
    // floor) rounds up to a 360s (6-minute) effective cadence — comfortably
    // under `keyword-gaps.ts`'s 8-minute `MAX_PASS_DURATION_MS` wall-clock
    // bail guard, so a sweep completes rather than being cut short. That's
    // 600 * 3600 / 360 = 6,000/hour, ≈ 144,000/day THEORETICAL ceiling for
    // this one batch (hot + tier1 + mined combined) if every sweep filled
    // all 600 slots — in practice hot/tier1 are self-limiting (bounded by
    // their own due-staleness pools, typically a small fraction of 600), so
    // real daily volume is governed by whichever pool actually has that many
    // keywords due, not this number alone; see `minedExploration.dailyQuota`
    // below for the mined lane's own (tighter) per-sweep math. Against the
    // corpus (~120k active keywords at the time of this pass) full
    // round-robin coverage is bound by the SLOWEST-refreshing pool, not raw
    // sweep throughput, once volume clears the corpus size roughly daily —
    // beyond that point additional throughput buys faster re-observation
    // (fresher demand/velocity signal), not more first-time coverage.
    // Real-world latency varies — `sweepRateSafety` below backs the rate off
    // automatically if Apple starts throttling.
    keywordsPerSweep: z.number().int().min(1).max(1000).default(600),
    // Priority re-scan lane staleness window (see keyword-tiering.ts): a
    // keyword last scanned longer ago than this (or never scanned) is stale
    // enough to qualify for tier 1. Lifted out of a hardcoded constant
    // (`TIER1_STALE_THRESHOLD_MS` in keyword-tiering.ts, was 24h) into config
    // as part of the 2026-07-21 audit's NOW-tier fixes — halved to a 12h
    // default so tier 1's ~829 protected + 306 signature-hit keywords get
    // ~daily trend/velocity resolution at roughly double the old cadence,
    // and so an operator can retune it without a code change. Halved again
    // to 6h (2026-07-21 capacity-raise escalation, now that the Webshare
    // proxy is armed/paid) so tier 1 gets ~4x/day resolution — the search
    // family has proven headroom (see item 4's budget table) and tier 1 is
    // the highest-value slice of the corpus.
    tier1StaleThresholdMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000),
    // Batch A budget rescue (2026-07-22): tier 1 no longer applies
    // `tier1StaleThresholdMs` flat to the whole pool — `keyword-tiering.ts`'s
    // `computeEffectiveStaleThreshold` bands each keyword's OWN effective
    // threshold by its own recent opportunity (see that module's doc
    // comment). Structural guard, coordinated with that banding: this caps
    // how many `source: 'autocomplete'` keywords the GUARANTEED tier-1 lane
    // may include per sweep — manual/seed/signature-hit stay uncapped.
    // Measured 2026-07-21/22: autocomplete had grown to 83% of the tier-1
    // pool (4,175 keywords), 89% at opportunity < 0.1 — this cap stops a
    // brand-new (or merely numerous) autocomplete keyword from
    // unconditionally competing in the daily-guaranteed lane the same way
    // seed/manual do, protecting the corpus every validated candidate has
    // ever actually come from. 50 leaves meaningful room within the default
    // 75-keyword `keywordsPerSweep` batch for hot + guaranteed + autocomplete
    // all in the same cycle.
    tier1AutocompleteCap: z.number().int().min(0).max(500).default(50),
    // How many top-ranked gap candidates to surface per scan.
    topN: z.number().int().min(5).max(50).default(20),
    // Weight applied to the `appstore_gap` demand-evidence kind when
    // aggregating a candidate's demand artifact (see `demand-probes.ts`'s
    // `enrichDemand`, which resolves this field into `aggregateDemand`'s
    // `kindWeightOverrides` — `DEMAND_KIND_WEIGHTS.appstore_gap` in
    // `demand.ts` stays the 1.0 default fallback when this equals 1). Modest
    // default so demand nudges but does not dominate ranking/difficulty.
    demandWeight: z.number().min(0).max(5).default(1),
    // Minimum opportunity score (0..1) a keyword must clear before it is fed
    // back as a seed into further expansion/generation. Live opportunity
    // scores currently top out around ~0.324, so 0.4 never fires — lowered
    // to 0.15 so genuinely strong winners actually seed further discovery.
    opportunityThresholdForSeed: z.number().min(0).max(1).default(0.15),
    // ASA popularity manual-import veto (2026-07-22, batch E — see
    // `popularity-store.ts` / `collector-keyword-gaps.ts`'s
    // `filterKnownZeroVolume`). Apple's ratings-per-day demand proxy has no
    // ground truth of its own — the 2026-07-20 28-term US ASA sweep (manual,
    // Playwright-driven; there is no programmatic sweep endpoint) found 27/28
    // terms at `searchPopularity` 1, contradicting the proxy for most of
    // them. This is a coverage-tiny, manually-populated signal, so it's a
    // hard VETO on seed selection, never a scoring multiplier. Default OFF
    // until enough manually imported rows exist to be worth enforcing.
    excludeKnownZeroVolume: z.boolean().default(false),
    // A recorded ASA `searchPopularity` (0..5) at or under this value is
    // treated as "known dead" for the veto above. 1 is Apple's near-floor
    // reading — the 2026-07-20 sweep's near-universal result.
    zeroVolumeThreshold: z.number().int().min(0).max(5).default(1),
    // A recorded reading older than this many days is treated as stale and
    // ignored by the veto — search demand drifts, so a probe from months ago
    // should not permanently blacklist a keyword.
    zeroVolumeFreshnessDays: z.number().int().min(1).max(365).default(45),
    // Minimum `buildability` (0..100, see `computeBuildability`) a keyword's
    // latest US-storefront scan must clear before `collectKeywordGaps`
    // (idea-synthesis pipeline consumer) will draw it as a seed. Additive to
    // the store/low-confidence/junk filters `collectKeywordGaps` always
    // applies (Batch F, F1) — default 0 (no-op) so this ships without
    // silently starving the pipeline of seeds; raise once the corpus's real
    // buildability distribution is understood from the dashboard.
    pipelineMinBuildability: z.number().int().min(0).max(100).default(0),
    // Cap on how many top-opportunity scans `collectKeywordGaps` fetches per
    // pipeline run before ranking/selecting seeds (was a hardcoded `limit: 10`
    // in `pipeline.ts`'s Step 3b). Lifted into config so an operator can widen
    // the seed pool without a code change; kept at the prior hardcoded value
    // as the default so this ships behavior-neutral.
    seedLimit: z.number().int().min(1).max(100).default(10),
    // SECONDARY corpus-discovery: mines new keyword candidates from App
    // Store data the scraper already fetches (top-chart app names +
    // categories — see keyword-miner.ts). Demoted 2026-07-21 in favor of
    // `autocompleteExpansion` (below) as the PRIMARY discovery source — the
    // 2026-07-18 "Apple search-suggest is dead" diagnosis this miner's doc
    // comment describes was WRONG (the endpoint requires an
    // `X-Apple-Store-Front` header Apple made mandatory at some point; it
    // was never actually retired — see keyword-autocomplete.ts). This miner
    // still runs (small default cap) because it catches brand-new apps
    // autocomplete hasn't indexed yet, which real user search queries can't
    // surface until the app has enough install/search volume. Default ON.
    corpusDiscovery: z
      .object({
        enabled: z.boolean().default(true),
        // Upper bound on newly-added corpus keywords per mining cycle.
        // Lowered 500 -> 100 as part of the 2026-07-21 demotion to secondary
        // status: corpus growth should now be dominated by
        // `autocompleteExpansion`'s real user-query terms, not app-name
        // n-gram fragments.
        maxMinedPerCycle: z.number().int().min(1).max(2000).default(100),
        // Batch C4: a FOURTH corpus-discovery source — mines candidate
        // keywords from low-star (rating <= 3) REVIEW TEXT rather than app
        // names/rankings (see keyword-review-miner.ts). Complaint language
        // ("wish it had X", "missing Y") is a market-need signal none of the
        // other sources capture, but the review pool is enrollment-gated to
        // whatever population `review-harvester.ts` currently tracks (a few
        // hundred apps at a time), so this deepens already-tracked niches
        // rather than discovering brand-new ones. Default OFF — narrower and
        // more speculative than autocomplete/mined; an operator opts in once
        // the review-harvest pool has matured.
        reviewMining: z
          .object({
            enabled: z.boolean().default(false),
            // Minimum gap between mining passes — pure DB read/extract, no
            // network calls of its own (reuses reviews the harvester already
            // fetched), but shouldn't re-scan the whole complaint-review
            // window on every ~1min sweep tick. Default 6h, same cadence
            // family as `appstoreReviewHarvest.cohortRefresh`.
            minIntervalMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000),
            // How many of the most-recent rating<=3 reviews to scan per pass.
            reviewScanLimit: z.number().int().min(1).max(20_000).default(5000),
            // Only reviews first seen within this rolling window are
            // considered — keeps each pass bounded and self-refreshing
            // rather than re-walking the entire historical review pool.
            lookbackMs: z.number().int().min(60_000).default(30 * 24 * 60 * 60 * 1000),
            // Upper bound on newly-added corpus keywords per mining cycle —
            // deliberately small (~50), matching the module doc's "narrow,
            // speculative source" framing.
            maxNewPerCycle: z.number().int().min(1).max(500).default(50),
          })
          .default({
            enabled: false,
            minIntervalMs: 6 * 60 * 60 * 1000,
            reviewScanLimit: 5000,
            lookbackMs: 30 * 24 * 60 * 60 * 1000,
            maxNewPerCycle: 50,
          }),
      })
      .default({
        enabled: true,
        maxMinedPerCycle: 100,
        reviewMining: {
          enabled: false,
          minIntervalMs: 6 * 60 * 60 * 1000,
          reviewScanLimit: 5000,
          lookbackMs: 30 * 24 * 60 * 60 * 1000,
          maxNewPerCycle: 50,
        },
      }),
    // PRIMARY corpus-discovery source (restored 2026-07-21): pulls Apple's
    // own search-suggest ("autocomplete") hints for a batch of expansion
    // seeds each cycle — real, popularity-ordered user search queries (e.g.
    // "budget planner", "budget bestie"), not app-name fragments. MUST send
    // the `X-Apple-Store-Front` header: verified live 2026-07-20/21 that the
    // endpoint returns an EMPTY hints array without it (the cause of the
    // 2026-07-18 "autocomplete is dead" misdiagnosis that led to
    // `corpusDiscovery` above) but real suggestions with it. See
    // keyword-autocomplete.ts for the fetch + plist-parsing implementation
    // and scraper.ts's `runAutocompleteExpansionIfDue` for the cadence gate.
    // Default ON.
    autocompleteExpansion: z
      .object({
        enabled: z.boolean().default(true),
        // Minimum gap between expansion passes. Throughput wave (2026-07-21,
        // item 3 "hint breadth"): widened 15min -> 1h alongside raising
        // winnerLimit+diverseLimit below (25 -> 60 total seeds/pass, 2.4x) —
        // a straight cadence-unchanged multiply would have pushed this
        // lane's daily request volume from ~14.4k/day to ~34.6k/day on its
        // OWN, before even counting the new `gbLane` below or the SERP-scan/
        // DE-storefront lanes that share the same Apple search-endpoint
        // family. Slowing the cadence 4x while widening the seed set 2.4x
        // nets this lane back down to ~8.6k/day (60 seeds * 6 queries
        // [1 bare + 5 prefix-fanout] * 24 passes/day) — see item 4's budget
        // table in `appstoreAppEnrichment`'s doc comment for the full
        // cross-lane total.
        minIntervalMs: z.number().int().min(60_000).default(3_600_000), // 1h
        // How many current high-opportunity "winner" keywords seed an
        // expansion pass — see keyword-store.ts `getWinnerKeywords`. Raised
        // 15 -> 36 (throughput wave item 3), keeping the original ~1.5:1
        // winner:diverse ratio at the new 60-seed total.
        winnerLimit: z.number().int().min(0).max(200).default(36),
        // How many additional zone-diverse picks (least-recently-scanned per
        // genre zone) round out the seed set, so expansion isn't purely
        // winner-driven and under-covered zones still get a turn — see
        // `getDiverseZoneSample`. Anti rich-get-richer monoculture, same
        // rationale as the diversity guard elsewhere in the funnel. Raised
        // 10 -> 24 (throughput wave item 3): winnerLimit(36) + diverseLimit(24)
        // = 60 total seeds/pass, up from 25.
        diverseLimit: z.number().int().min(0).max(200).default(24),
        // Upper bound on GOOD (post-`isJunkKeyword`) suggestions kept per
        // seed. Apple returns suggestions in popularity order, so this keeps
        // the top-N most-popular per seed rather than an arbitrary slice.
        perSeed: z.number().int().min(1).max(20).default(8),
        // Delay between each seed's hint request within one expansion pass —
        // same spirit as `sweepDelayMs`, scoped to this separate endpoint.
        delayMs: z.number().int().min(100).max(10_000).default(1000),
        // Apple storefront to query, in the raw `X-Apple-Store-Front` header
        // format (`"<storefront-id>-<lang-id>[,<lang-id>...]"`). Defaults to
        // the US storefront verified live 2026-07-20/21. The header itself
        // is MANDATORY — see the field doc above.
        storefront: z.string().min(1).default("143441-1,29"),
        // Prefix fan-out (2026-07-21 audit NOW-tier fix, item D): besides the
        // bare seed, also queries `"<seed> <letter>"` for up to
        // `maxPrefixesPerSeed` single letters (a..z, in order) — Apple's
        // search-suggest returns DIFFERENT, more specific completions per
        // prefix (e.g. "budget a..." surfaces "budget app", "budget b..."
        // surfaces "budget bestie"), which is how real users actually type.
        // Config-driven cap keeps the added request volume per seed bounded;
        // 0 disables fan-out entirely (bare-seed-only, the pre-fix
        // behavior). Scaled by the same shared throttle multiplier as
        // `winnerLimit`/`diverseLimit` — see scraper.ts's
        // `runAutocompleteExpansionIfDue`. Throughput wave item 3: kept ON
        // ("keep prefix fan-out") at the same cap while breadth was raised.
        prefixFanOut: z
          .object({
            enabled: z.boolean().default(true),
            maxPrefixesPerSeed: z.number().int().min(0).max(26).default(5),
          })
          .default({ enabled: true, maxPrefixesPerSeed: 5 }),
        // Throughput wave item 1: routes this lane's search-suggest hint
        // fetches through the Webshare proxy when set. Default OFF — same
        // "already a proven-safe endpoint family" reasoning as
        // `appstoreKeywordGap.useProxy` above (this lane shares that budget
        // envelope — see item 4's table).
        useProxy: z.boolean().default(false),
        // Throughput wave item 3 ("hint breadth"): a SECOND autocomplete
        // pass against the GB storefront, writing into the SAME
        // `appstore_autocomplete_hints` table (migration 049 adds the
        // `storefront` column) rather than a parallel table — a hint is
        // meaningful per-market, and GB's popularity ordering differs from
        // US's. Reuses the SAME seed pool/rotation as the US lane above
        // (`getExpansionSeeds`/`markSeedsExpanded` — see
        // `keyword-autocomplete.ts`'s `expandCorpus`, called a second time
        // with `storefront` swapped to GB): the rotation state tracks "when
        // was this keyword last used as an expansion seed" generically, not
        // per-storefront, so sharing it is a deliberate simplification, not
        // an oversight. Smaller seed set + own 1h cadence keeps this
        // lane's volume modest (~3.6k/day: 25 seeds * 6 queries * 24
        // passes/day) — see item 4's budget table.
        gbLane: z
          .object({
            enabled: z.boolean().default(true),
            minIntervalMs: z.number().int().min(60_000).default(3_600_000), // 1h
            winnerLimit: z.number().int().min(0).max(200).default(15),
            diverseLimit: z.number().int().min(0).max(200).default(10),
            perSeed: z.number().int().min(1).max(20).default(8),
            delayMs: z.number().int().min(100).max(10_000).default(1000),
            // GB storefront id (143444) — same header format as the US
            // `storefront` field above; the `-1,29` suffix is carried over
            // unchanged (verified structurally identical across storefronts
            // for this endpoint — it encodes protocol/client capability,
            // not language).
            storefront: z.string().min(1).default("143444-1,29"),
            prefixFanOut: z
              .object({
                enabled: z.boolean().default(true),
                maxPrefixesPerSeed: z.number().int().min(0).max(26).default(5),
              })
              .default({ enabled: true, maxPrefixesPerSeed: 5 }),
            useProxy: z.boolean().default(false),
          })
          .default({
            enabled: true,
            minIntervalMs: 3_600_000,
            winnerLimit: 15,
            diverseLimit: 10,
            perSeed: 8,
            delayMs: 1000,
            storefront: "143444-1,29",
            prefixFanOut: { enabled: true, maxPrefixesPerSeed: 5 },
            useProxy: false,
          }),
      })
      .default({
        enabled: true,
        minIntervalMs: 3_600_000,
        winnerLimit: 36,
        diverseLimit: 24,
        perSeed: 8,
        delayMs: 1000,
        storefront: "143441-1,29",
        prefixFanOut: { enabled: true, maxPrefixesPerSeed: 5 },
        useProxy: false,
        gbLane: {
          enabled: true,
          minIntervalMs: 3_600_000,
          winnerLimit: 15,
          diverseLimit: 10,
          perSeed: 8,
          delayMs: 1000,
          storefront: "143444-1,29",
          prefixFanOut: { enabled: true, maxPrefixesPerSeed: 5 },
          useProxy: false,
        },
      }),
    // Safety rails for the higher sweep rate above — see `sweep-throttle.ts`.
    // Apple's tolerance for request volume is the real constraint here, not
    // anything under our control, so both an automatic backoff and a manual
    // kill-switch exist. Shared with `autocompleteExpansion`: both hit an
    // Apple search endpoint on the same corpus, so a rate-limit spike from
    // either source trips the SAME throttle state and backs off both (see
    // scraper.ts's shared `sweepThrottleState`); the kill-switch below also
    // disables `autocompleteExpansion` for the cycle, not just the scan
    // sweep.
    sweepRateSafety: z
      .object({
        // Tracks each sweep's rate-limit (429/503) error rate and halves the
        // effective `keywordsPerSweep` when it spikes (see
        // `sweep-throttle.ts`'s `THROTTLE_ERROR_RATE_THRESHOLD`), recovering
        // gradually once errors subside. Default ON.
        adaptiveThrottleEnabled: z.boolean().default(true),
        // MANDATORY hard kill-switch: when true, ignores `keywordsPerSweep` /
        // `sweepDelayMs` / the adaptive throttle entirely and reverts to the
        // pre-throughput-bump rate (`LEGACY_KEYWORDS_PER_SWEEP` = 25,
        // `LEGACY_SWEEP_DELAY_MS` = 2000ms — see `sweep-throttle.ts`), and
        // skips `autocompleteExpansion` entirely for the cycle. Flip this on
        // for an immediate, unambiguous revert if the higher rate ever
        // causes real trouble with Apple's endpoints. Default OFF.
        legacyRateOverride: z.boolean().default(false),
        // AIMD tuning (continuous-fetch retune, 2026-07-23): with mined
        // exploration no longer paced by idle gaps (see `keywordsPerSweep`'s
        // module doc / keyword-tiering.ts), the adaptive throttle is now the
        // ONLY thing standing between "continuously fetch" and "continuously
        // hammer Apple past its real ceiling" — it needs to both back off
        // hard on a real 429 spike (multiplicative decrease,
        // `throttleBackoffFactor`) AND climb back up once errors clear
        // (additive increase, `throttleRecoveryStep`, gated by
        // `THROTTLE_HOLD_SWEEPS` clean sweeps — see `sweep-throttle.ts`'s
        // `advanceThrottle`) so the sustained rate settles just under
        // Apple's actual ceiling instead of staying backed off forever.
        // Multiplied into the CURRENT multiplier each trip (floored at
        // `MIN_THROTTLE_MULTIPLIER`), so repeated trips keep backing off
        // further. 0.5 (unchanged from the pre-AIMD-knob default) halves the
        // rate per trip.
        throttleBackoffFactor: z.number().min(0.05).max(0.95).default(0.5),
        // Added to the multiplier per recovery step once
        // `THROTTLE_HOLD_SWEEPS` consecutive sweeps have stayed under the
        // error-rate threshold (clamped at 1.0). Raised from the pre-knob
        // 0.15 default to 0.25 (alongside `sweep-throttle.ts`'s
        // `THROTTLE_HOLD_SWEEPS` default dropping 5 -> 3) so a throttled-down
        // sweep probes back toward the configured rate over a handful of
        // minutes rather than the ~30min-to-hours it took at the old
        // defaults once sweeps stopped being idle-paced — see
        // `sweep-throttle.ts`'s module doc for the recovery-time math.
        throttleRecoveryStep: z.number().min(0.01).max(1).default(0.25),
        // Floor the adaptive throttle can back off to on repeated trips (the
        // MD of AIMD is clamped here). Lowered from the pre-knob 1/8 (0.125)
        // to 1/32 (2026-07-23): at 1/8 the clamped batch (base
        // `keywordsPerSweep` 600 -> 75) still exceeded a single direct Apple
        // IP's sustainable rate, so the throttle pinned at the floor with
        // ~50% of every sweep 403'd for hours. 1/32 (batch ~19) gives the
        // AIMD room to reach a clean level; drop it further (e.g. 1/64) live
        // via this knob if Apple's per-IP ceiling tightens. Min bound 1/128
        // keeps the sweep from stalling to a trickle.
        throttleMinMultiplier: z.number().min(0.0078125).max(0.5).default(0.03125),
      })
      .default({
        adaptiveThrottleEnabled: true,
        legacyRateOverride: false,
        throttleBackoffFactor: 0.5,
        throttleRecoveryStep: 0.25,
        throttleMinMultiplier: 0.03125,
      }),
    // ─── Mined exploration quota (2026-07-21 scan-budget retune) ───────────
    // Measured 2026-07-21: 97.9% of the ~36k daily SERP scans went to the
    // `source: 'mined'` pool (114,656 keywords), which had produced 304
    // signature hits — ALL triaged as noise; every validated candidate ever
    // came from seed/manual. `getStaleKeywordsTiered` (keyword-store.ts) now
    // guarantees tier 1 (seed/manual/autocomplete/signature-hit) a daily
    // re-scan UNCAPPED, and gives mined exploration only this separate,
    // capped daily quota — never-scanned mined keywords first, then
    // oldest-scanned still-active ones (see keyword-tiering.ts). The freed
    // scan capacity funds `deStorefrontLane` below.
    minedExploration: z
      .object({
        // Rolling-24h cap on `source: 'mined'` scans, tracked independently
        // of `dailyKeywordBudget` via `countMinedScansSince`. Raised
        // 5,000 -> 20,000 (2026-07-21 audit NOW-tier fix), then 20,000 ->
        // 30,000 (2026-07-21 capacity-raise escalation, proxy armed/paid).
        // MAX-THROUGHPUT PASS (2026-07-22): raised 30,000 -> 100,000 (max
        // ceiling unchanged at 100,000 — the new default sits exactly at it,
        // deliberately, since `dailyKeywordBudget` above is the real
        // whole-corpus ceiling and this sub-quota should never itself become
        // the binding constraint before that one does).
        //
        // IMPORTANT — this quota being large does NOT mean the mined lane
        // drains 100,000/day on its own; `dailyKeywordBudget` above is the
        // real whole-corpus ceiling. Live 2026-07-21/22 diagnosis found the
        // mined lane's bottleneck wasn't this quota at all — at
        // `keywordsPerSweep` = 75, the hot lane (≤50) plus tier 1 (uncapped,
        // and `tier1AutocompleteCap` = 50 alone could exceed the whole
        // 75-slot batch) routinely crowded mined out of the batch entirely
        // (observed: ~30,000 quota, only ~1,944 actually spent in a rolling
        // 24h window — 93% unused). Raising `keywordsPerSweep` to 600 is what
        // relieves that crowding.
        //
        // CONTINUOUS FETCH (2026-07-23): from 2026-07-21 to 2026-07-22 the
        // per-sweep governor was ADDITIONALLY paced —
        // `computePerSweepCap(dailyQuota, scanIntervalMs)` in
        // `keyword-tiering.ts` (`ceil(dailyQuota * scanIntervalMs /
        // 86_400_000)`) spread this quota evenly across the sweeps a nominal
        // `scanIntervalMs` cadence implies, yielding ~70 mined slots/sweep at
        // this 100,000 default. That pacing turned out to BE the idle-sweep
        // mechanism: with a mined backlog (never-scanned keywords) far
        // larger than any single sweep's batch, the ~70/sweep cap left most
        // of a 600-keyword batch unfilled once hot+tier1 ran out, so the
        // process idled between sweeps instead of continuously fetching.
        // `computePerSweepCap` is retired — `keyword-gaps.ts`'s
        // `runKeywordSweep` now passes `perSweepCap = opts.limit` (this
        // cycle's own batch size), so mined exploration fills the WHOLE
        // remaining batch every cycle whenever the backlog supports it. This
        // rolling quota (and `dailyKeywordBudget`) remain the real ceilings —
        // along with `sweepRateSafety`'s adaptive throttle, which now also
        // AIMD-recovers (see `throttleRecoveryStep`/`throttleBackoffFactor`
        // above and `sweep-throttle.ts`) so the sustained rate settles just
        // under Apple's real ceiling rather than staying backed off. Monitor
        // `keywordSweepTick`'s logged `mineQuotaRemaining` after deploy; if
        // it consistently sits near 100,000 (mostly unused) even with
        // continuous fill, the corpus's real never-scanned mined backlog has
        // likely shrunk below what one day's quota can absorb.
        dailyQuota: z.number().int().min(0).max(100_000).default(100_000),
      })
      .default({ dailyQuota: 100_000 }),
    // ─── DE storefront lane (2026-07-21 scan-budget retune; CHUNKED as of ──
    // the 2026-07-22 Batch A budget rescue) ─────────────────────────────────
    // Scans a CHUNK of the active seed/manual/autocomplete keyword pool
    // (`keyword-store.ts`'s `getTier1ProtectedKeywords`, stalest-by-DE-scan
    // first) against the German App Store each pass, funded by budget freed
    // from the mined-pool tightening above. Querying/mining data only this
    // iteration — deliberately does NOT feed junk-deactivation, velocity
    // bookkeeping, or the (US-calibrated) signature screener; see
    // `keyword-gaps.ts`'s `runDeStorefrontSweep`.
    //
    // Previously ONE pass scanned the WHOLE protected pool (~4,175 keywords)
    // at a 12h cadence — ~110 minutes per pass at the live per-keyword rate,
    // wedging every OTHER lane sharing `scraper.ts`'s single-flight sweep
    // tick for that entire window, twice daily (PR #327's `pass-deadline.ts`
    // fixed the same class of wedge for other lanes but not this one).
    // Chunked 2026-07-22: `deChunkSize` (default 150) keeps each pass to
    // ~4min at the live per-keyword rate, and `minIntervalMs` dropped
    // 12h -> 25min so the SAME approximate daily volume is spread across many
    // small passes instead of two giant ones — `deChunkSize` keywords every
    // `minIntervalMs` ≈ 150 * (1440min/day / 25min) ≈ 8,640 scans/day
    // capacity, enough to walk the whole ~4,175-keyword pool roughly twice a
    // day (≈ 4,175 / 150 ≈ 28 chunks ≈ 11.7h for one full round-robin) —
    // same "the pool still completes within ~12h" target the old 12h/whole-
    // pool cadence aimed for, just without the wedge.
    deStorefrontLane: z
      .object({
        // Master switch. Default OFF (2026-07-23): the DE storefront lane was
        // a monolithic pass that wedged `keywordSweepRunning` and monopolized
        // the sweep tick, starving the US high-volume lane and preventing the
        // adaptive throttle from ever completing a tick to advance — and DE
        // demand evidence is unused/contaminating (store-predicate defects).
        // Re-enable per-storefront only with a chunked, non-wedging pass.
        enabled: z.boolean().default(false),
        // Minimum gap between DE-lane passes — its own cadence, decoupled
        // from the ~1min scan-sweep timer. Was 24h ("a daily pass"), then 12h
        // (2026-07-21 capacity-raise escalation), each time assuming ONE pass
        // scans the WHOLE tier-1-protected corpus. Dropped to 25min
        // (2026-07-22 budget rescue) now that each pass only scans one
        // `deChunkSize` chunk — see this field group's doc comment for the
        // daily-volume math.
        minIntervalMs: z.number().int().min(60_000).default(25 * 60 * 1000),
        // Delay between each keyword's iTunes call within one DE-lane pass —
        // same spirit as `sweepDelayMs`, scoped to this separate pass.
        delayMs: z.number().int().min(100).max(10_000).default(1000),
        // How many protected-pool keywords ONE DE-lane pass scans (Batch A
        // budget rescue, 2026-07-22) — see `keyword-store.ts`'s
        // `getTier1ProtectedKeywords`, ordered stalest-by-DE-scan first, so
        // this is a resumable chunk, not a hard partition: consecutive
        // passes naturally continue from wherever the last one left off.
        deChunkSize: z.number().int().min(1).max(2000).default(150),
      })
      .default({
        enabled: true,
        minIntervalMs: 25 * 60 * 1000,
        delayMs: 1000,
        deChunkSize: 150,
      }),
    // ─── Deep SERP fetch (serp-rank Stage 1, deep-scrape build) ─────────────
    // How many results to request from the iTunes Search API for the hot/
    // tier1/DE lanes (see `keyword-gaps.ts`'s `scanKeywordDeep`) — a strictly
    // BIGGER fetch than `topN`, never smaller (`scanKeywordDeep` also treats
    // any `depth <= topN` as a no-op tail). Scoring is unaffected: every
    // demand/competitiveness/opportunity computation still reads only the
    // first `topN` entries (calibration frozen) — the extra depth is
    // persisted separately as `serp_tail` (migration 044) purely to recover
    // rank-over-time for apps beyond the scored window. Adds zero extra
    // requests (same call count, bigger payload per call) — see the build
    // plan's daily-budget table.
    serpDepth: z.number().int().min(20).max(200).default(200),
    // Whether the `source: 'mined'` sweep lane also deep-scans. Default OFF —
    // the mined pool is the highest-volume, lowest-signal lane (see
    // `minedExploration`'s doc comment above), so its fetches stay shallow
    // (topN) unless an operator opts in.
    deepScanMined: z.boolean().default(false),
    // ─── Keyword-scans retention (B3, 2026-07-22) ──────────────────────────
    // The `appstore_keyword_scans` history table (~234k rows / ~407MB, growing
    // ~17k rows/day) had ZERO production DELETEs. This is an AGE-ONLY, chunked
    // prune (see `keyword-store.ts`'s `pruneKeywordScans`), wired as a
    // cadence-gated lane on the keyword-sweep tick (scraper.ts's
    // `runScansRetentionIfDue`), mirroring the ledger prunes. NOTE: under the
    // 90d `maxAgeMs` default this logs `pruned: 0` until ~2026-10-07 (the
    // oldest scan is 2026-07-09) — it's future-proofing, not immediate
    // hygiene; drop `maxAgeMs` to 45d for earlier cleanup.
    scansRetention: z
      .object({
        // Master switch. Default ON (the prune is conservative — keep-newest
        // guard + age cutoff — and no-ops when nothing is old enough).
        enabled: z.boolean().default(true),
        // Rows scanned longer ago than this are prune candidates. 90d default.
        maxAgeMs: z.number().int().min(24 * 60 * 60 * 1000).default(90 * 24 * 60 * 60 * 1000),
        // Keep-newest-per-(keyword, store) guard — hard floor 200 (the history
        // route reads up to limit=200), enforced again in `pruneKeywordScans`.
        keepNewestPerKeyword: z.number().int().min(200).max(10_000).default(200),
        // Rows deleted per chunk DELETE (bounds lock duration on a first run).
        chunkSize: z.number().int().min(1).max(50_000).default(5_000),
        // Safety bound on chunk-DELETEs per run — 1000 * 5000 = up to 5M rows
        // per run, far above the realistic backlog, so a run effectively drains
        // the whole eligible set while staying bounded.
        maxChunksPerRun: z.number().int().min(1).max(100_000).default(1_000),
        // Own cadence gate, decoupled from the ~1min sweep tick. 6h default.
        minIntervalMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000),
      })
      .default({
        enabled: true,
        maxAgeMs: 90 * 24 * 60 * 60 * 1000,
        keepNewestPerKeyword: 200,
        chunkSize: 5_000,
        maxChunksPerRun: 1_000,
        minIntervalMs: 6 * 60 * 60 * 1000,
      }),
    // ─── Run-aggregate outcome attribution (Batch F, F5 leg 4) ─────────────
    // When a run reaches a terminal gold/reprobe idea verdict,
    // `keyword-outcome-feedback.ts` attributes the run's AGGREGATE verdict
    // back to every gap-seed keyword the run was exposed to (see
    // `collector-keyword-gaps.ts`'s module doc on why this is run-aggregate,
    // not per-idea). Default ON: bounded, in-process Postgres bookkeeping,
    // no extra network calls — same "safe by default" reasoning as
    // `appstoreVelocity`/`appstoreSignatureScreener` above. The materialized
    // `killed_count` this produces is consumed by `collectKeywordGaps` as a
    // SOFT downweight only (see `killDownweightStrength` below) — never a
    // hard exclude.
    outcomeAttribution: z
      .object({
        enabled: z.boolean().default(true),
        // Per-run signed credit magnitude for a validated / killed aggregate
        // verdict, before temporal decay — mirrors
        // `pipelines.ideas.smart.graphFeedback`'s validatedWeight/killedWeight
        // shape (same buildSeedOutcomeEvents builder, reused unchanged).
        validatedWeight: z.number().default(1),
        killedWeight: z.number().default(-1),
        // Half-life (days) for `applyTemporalDecay` when materializing
        // validated_count/killed_count from the immutable event log — an old
        // kill signal fades so a keyword isn't downweighted forever.
        weightHalfLifeDays: z.number().min(0).default(45),
        // Clamp on the net per-run signed weight attributed to EVERY exposed
        // keyword (mirrors graphFeedback.maxSeedWeight) — bounds how much a
        // single run's outcome can move any one keyword.
        maxSeedWeight: z.number().min(0).default(5),
        // Strength of the graduated SOFT downweight `collectKeywordGaps`
        // applies from a keyword's decayed `killed_count`: sort rank is
        // divided by `1 + killedCount * killDownweightStrength`. Higher =
        // repeatedly-killed keywords sink further, never excluded outright.
        killDownweightStrength: z.number().min(0).default(0.35),
      })
      .default({
        enabled: true,
        validatedWeight: 1,
        killedWeight: -1,
        weightHalfLifeDays: 45,
        maxSeedWeight: 5,
        killDownweightStrength: 0.35,
      }),
    // ─── New-hit / first-crossing alert digest (Batch F4) ───────────────────
    // Daily, off the keyword-sweep tick (see `scraper.ts`'s
    // `runGapAlertsIfDue`): batches new signature-screener hits + first-ever
    // opportunity-threshold crossings (`gap-alerts.ts`) into ONE digest
    // message, enqueued into the existing cron delivery queue (never a
    // separate Telegram bot instance in the scraper process — see that
    // module's doc comment on the 409/duplicate-poller risk this avoids).
    // Default OFF: unlike the bookkeeping-only knobs above, this actually
    // sends a message to the operator's primary Telegram chat, so it should
    // be an explicit opt-in.
    alerts: z
      .object({
        enabled: z.boolean().default(false),
        // Minimum gap between alert runs — this scans the WHOLE corpus
        // (cheap, index-friendly SQL), so this cap exists purely to keep the
        // digest at a sane cadence ("what's new this week"-ish) rather than
        // firing on every sweep tick. Default 24h.
        minRunIntervalMs: z.number().int().min(60_000).default(24 * 60 * 60 * 1000),
      })
      .default({ enabled: false, minRunIntervalMs: 24 * 60 * 60 * 1000 }),
  })
  .default({
    enabled: true,
    scanIntervalMs: 60_000,
    sweepDelayMs: 150,
    dailyKeywordBudget: 150_000,
    useProxy: false,
    keywordsPerSweep: 600,
    tier1StaleThresholdMs: 6 * 60 * 60 * 1000,
    tier1AutocompleteCap: 50,
    topN: 20,
    demandWeight: 1,
    opportunityThresholdForSeed: 0.15,
    excludeKnownZeroVolume: false,
    zeroVolumeThreshold: 1,
    zeroVolumeFreshnessDays: 45,
    pipelineMinBuildability: 0,
    seedLimit: 10,
    corpusDiscovery: {
      enabled: true,
      maxMinedPerCycle: 100,
      reviewMining: {
        enabled: false,
        minIntervalMs: 6 * 60 * 60 * 1000,
        reviewScanLimit: 5000,
        lookbackMs: 30 * 24 * 60 * 60 * 1000,
        maxNewPerCycle: 50,
      },
    },
    autocompleteExpansion: {
      enabled: true,
      minIntervalMs: 3_600_000,
      winnerLimit: 36,
      diverseLimit: 24,
      perSeed: 8,
      delayMs: 1000,
      storefront: "143441-1,29",
      prefixFanOut: { enabled: true, maxPrefixesPerSeed: 5 },
      useProxy: false,
      gbLane: {
        enabled: true,
        minIntervalMs: 3_600_000,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        delayMs: 1000,
        storefront: "143444-1,29",
        prefixFanOut: { enabled: true, maxPrefixesPerSeed: 5 },
        useProxy: false,
      },
    },
    sweepRateSafety: {
      adaptiveThrottleEnabled: true,
      legacyRateOverride: false,
      throttleBackoffFactor: 0.5,
      throttleRecoveryStep: 0.25,
      throttleMinMultiplier: 0.03125,
    },
    minedExploration: { dailyQuota: 100_000 },
    deStorefrontLane: {
      enabled: false,
      minIntervalMs: 25 * 60 * 1000,
      delayMs: 1000,
      deChunkSize: 150,
    },
    serpDepth: 200,
    deepScanMined: false,
    scansRetention: {
      enabled: true,
      maxAgeMs: 90 * 24 * 60 * 60 * 1000,
      keepNewestPerKeyword: 200,
      chunkSize: 5_000,
      maxChunksPerRun: 1_000,
      minIntervalMs: 6 * 60 * 60 * 1000,
    },
    outcomeAttribution: {
      enabled: true,
      validatedWeight: 1,
      killedWeight: -1,
      weightHalfLifeDays: 45,
      maxSeedWeight: 5,
      killDownweightStrength: 0.35,
    },
    alerts: { enabled: false, minRunIntervalMs: 24 * 60 * 60 * 1000 },
  });
export type AppstoreKeywordGapConfig = z.infer<typeof appstoreKeywordGapConfigSchema>;

// ─── App Store newborn-velocity screener ───────────────────────────────────
// Runs AFTER the keyword-gap scanner's scan batches (see `scraper.ts` /
// `keyword-screener.ts`): evaluates the validated "window-opening signature"
// against the latest scan of every keyword and persists hits to
// `appstore_signature_hits` (migration 039). Gated like `appstoreKeywordGap`
// above, but default ON — this is a read-only pass over data the scanner
// already collected (no extra network calls), so there is no cost reason to
// default it off.
export const appstoreSignatureScreenerConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Minimum gap between full-corpus screener runs, regardless of how often
    // the scraper's scan-batch cycle fires — the screener re-evaluates the
    // WHOLE corpus each run (cheap, index-friendly SQL prefilter + a small
    // in-memory pass over the matches), so this exists purely to cap runs
    // when scans are batched more frequently than this. Default 6h.
    minRunIntervalMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000),
  })
  .default({
    enabled: true,
    minRunIntervalMs: 6 * 60 * 60 * 1000,
  });
export type AppstoreSignatureScreenerConfig = z.infer<
  typeof appstoreSignatureScreenerConfigSchema
>;

// ─── App Store newborn-velocity time-series ────────────────────────────────
// Hooked into the SERP-scan persist path (`keyword-gaps.ts` `scanAndRecord`):
// records one bucketed observation per newborn app per scan (see
// `app-velocity.ts` / `app-velocity-store.ts`, migration 040). Default ON —
// like the signature screener, this is bounded, read-mostly bookkeeping over
// data the scan already fetched (no extra network calls).
export const appstoreVelocityConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Deep SERP fetch (serp-rank Stage 1, deep-scrape build): bounds how deep
    // into a scan's rank-ordered app list (`scanAndRecord`'s `rankedSerp`)
    // observations are even attempted, independent of
    // `appstoreKeywordGap.serpDepth` (how deep the FETCH goes) — an operator
    // can retune how much of the fetched depth actually gets written to
    // `appstore_app_velocity` without touching the fetch-size knob. Default
    // 200 matches `serpDepth`'s default, so out of the box this is a no-op
    // cap; the two are deliberately independent knobs, not derived from one
    // another.
    maxRankRecorded: z.number().int().min(1).max(500).default(200),
  })
  .default({ enabled: true, maxRankRecorded: 200 });
export type AppstoreVelocityConfig = z.infer<typeof appstoreVelocityConfigSchema>;

// ─── App Store junk-keyword deactivation ───────────────────────────────────
// Hooked into the same SERP-scan persist path: after a scan persists,
// deactivates (`active = false`) keywords that are structurally hopeless —
// see `keyword-deactivation.ts`'s `shouldDeactivateKeyword`. Reversible
// (flips `active` back on) and never touches `source: 'manual' | 'seed'`.
// Default ON — it only ever narrows future sweep spend toward keywords more
// likely to matter.
export const appstoreJunkDeactivationConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // One-time, set-based backfill of the mined-pool-specific rule
    // (`shouldDeactivateMinedKeyword`) against the EXISTING mined pool — see
    // `keyword-store.ts`'s `backfillMinedDeactivation` and `scraper.ts`'s
    // `runMinedBackfillOnce`. Runs once per process lifetime off the async
    // keyword-sweep tick (never blocking startup). Default ON; flip off to
    // rely purely on the inline per-scan check pruning the pool gradually.
    minedBackfillEnabled: z.boolean().default(true),
  })
  .default({ enabled: true, minedBackfillEnabled: true });
export type AppstoreJunkDeactivationConfig = z.infer<
  typeof appstoreJunkDeactivationConfigSchema
>;

// ─── App Store app-meta registry: Lookup-API enrichment ────────────────────
// Deep-scrape build Stage 2 (migration 045, `app-meta-store.ts` /
// `app-enrichment.ts`): drains the "every app id we ever see" registry via
// batched iTunes Lookup API calls (`app-lookup.ts`) — release date (for
// newborn classification, mirroring `NEWBORN_AGE_DAYS_MAX` from
// `app-velocity.ts`), price/rating/developer data, and delist detection.
// Wired into `scraper.ts`'s `keywordSweepTick` as `runAppEnrichmentIfDue()`
// (build plan §0.4 slot 7) — NOT a new timer. Default ON: unlike the
// screener/velocity/junk-deactivation passes (read-only bookkeeping), this
// DOES make network calls, but the registry it drains is a prerequisite for
// Stage 3 (charts) and Stage 4 (chart-newborn review enrollment), so it
// defaults on like the other network lanes (`deStorefrontLane`,
// `autocompleteExpansion`) added in the same build.
// ─── Throughput-wave (2026-07-21) budget table, item 4 ─────────────────────
// "Raise the deep-scrape lane caps so TOTAL projected requests/day lands
// ~35k direct (just under proven 36.7k)." That 36.7k figure (2026-07-20 live
// traffic: 36,013 mined + 666 seed SERP scans, ZERO rate-limit errors — see
// `minedExploration`'s doc comment below) is specifically an iTunes SEARCH
// API measurement. The lanes below hit FOUR DIFFERENT Apple endpoint
// families (search, search-suggest, `/lookup`, review-RSS/HTML), each very
// plausibly rate-limited independently (different subdomains/paths, no
// evidence they share a bucket) — so this table applies the 36.7k proof
// ONLY to the search-endpoint family it was measured against, and raises the
// OTHER lanes' caps on separate, more conservative grounds (each currently
// running well under its own configured cap post PR #326/#327's
// dormant-lanes fix, i.e. real headroom exists even before any proxy).
//
//   Search-endpoint family (itunes.apple.com/search + search-suggest),
//   direct fetch, no proxy — target ~35k, under the proven 36.7k:
//     SERP scan (tier1 protected, uncapped)      ~1,135/day (dynamic, corpus-sized)
//     SERP scan (mined, dailyQuota — UNCHANGED)   20,000/day
//     DE storefront lane (tier1-protected corpus)  ~1,135/day (dynamic)
//     Autocomplete expansion, US (60 seeds * 6      8,640/day (1h cadence)
//       queries [1 bare + 5 prefix-fanout] * 24/day)
//     Autocomplete expansion, GB (25 seeds * 6       3,600/day (1h cadence)
//       queries * 24/day)
//     ─────────────────────────────────────────────────────────
//     TOTAL (search family)                       ~34,510/day  <- ~35k target
//
//   Other endpoint families, raised on separate headroom grounds (item 1's
//   per-lane `useProxy` flags are the pressure valve if any of these starts
//   rate-limiting at the new cap — flip that lane's flag on, no code change):
//     Lookup API (`/lookup`) — app-enrichment + portfolio + NEW newborn
//       re-observation lane (item 2): raised from ~1,200/day to 2,400/day
//       (enrichment) + ~225/day (newborn re-observation, ~45k apps / 200
//       ids per batch) ≈ 2,625/day combined.
//     Review-RSS: raised from 10,000/day to 15,000/day.
//     App-page HTML (heaviest per-request payload, proxy default ON):
//       raised from 3,000/day to 5,000/day.
//
// ─── Capacity-raise escalation (2026-07-21, post PR #328) ──────────────────
// PR #328 (above) armed the Webshare rotating-proxy layer but kept every
// lane's `useProxy` conservative-default-OFF except app-page HTML, deferring
// to "flip the valve if a lane starts rate-limiting." This pass escalates
// PROACTIVELY instead of waiting for 429s: the proxy has since been renewed
// as a PAID plan (per-request rotating IP, not a shared/free tier), so
// spreading volume across it ahead of need is now cheap insurance rather
// than a step to save for an emergency.
//
//   Search-endpoint family — `appstoreKeywordGap.useProxy` flipped OFF ->
//   ON (now covers tier1 SERP scan, mined SERP scan, AND the DE storefront
//   lane — all three share `fetchTopApps`/this one flag):
//     SERP scan (tier1 protected, uncapped)      ~1,135/day (dynamic, unchanged)
//     SERP scan (mined, dailyQuota 20k -> 30k)   30,000/day
//     DE storefront lane (24h -> 12h cadence)     ~2,270/day (dynamic, ~2x)
//     Autocomplete expansion, US/GB (unchanged,   12,240/day (still direct —
//       still direct — not touched by this pass)              not proxied)
//     ─────────────────────────────────────────────────────────
//     TOTAL (search family)                       ~45,645/day (~33.4k of it
//                                                    now proxied)
//
//   Other endpoint families:
//     Lookup API (`/lookup`) — enrichment dailyRequestBudget 2,400 -> 6,000
//       (stays DIRECT — no proxy flip for this lane in this pass) + ~384/day
//       portfolio + ~225/day newborn re-observation (both unchanged,
//       direct) ≈ 6,609/day combined, direct.
//     Review-RSS — dailyRequestBudget 15,000 -> 30,000, `useProxy` flipped
//       OFF -> ON (this lane runs AT its cap, so the extra volume needed
//       rotating IPs, not just a bigger number).
//     App-page HTML — dailyPageBudget 5,000 -> 15,000 (already proxied
//       since PR #328; the single largest raise, since it's the proxy's
//       primary target lane).
//
//   Aggregate of the four explicit ledger-capped ceilings (mined 30,000 +
//   review-RSS 30,000 + app-page 15,000 + lookup 6,000) ≈ 81,000/day
//   (~80k/day) — the search family's tier1/autocomplete slices are
//   dynamic/uncapped and add on top of that, not folded in (per this
//   table's own caveat above: the four endpoint families are plausibly
//   rate-limited independently, so a single grand total isn't meaningful —
//   this ~80k figure is the sum of the operator-facing daily BUDGET knobs,
//   not a claim that Apple enforces one shared bucket across them).
//   `appstoreKeywordGap.dailyKeywordBudget` (the rolling ceiling gating
//   tier1+mined+DE together) stays at 60,000 — projected new usage
//   (~33.4k/day) leaves ~45% headroom, so it did not need raising.
export const appstoreAppEnrichmentConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Minimum gap between enrichment passes — its own cadence, decoupled
    // from the ~1min scan-sweep timer (build plan §0.4 slot 7: 15 min).
    minIntervalMs: z.number().int().min(60_000).default(15 * 60 * 1000),
    // Ids per `/lookup` batch request. Apple's documented ceiling is ~200
    // (verified empirically) — see `app-lookup.ts`'s `MAX_LOOKUP_BATCH_SIZE`.
    batchSize: z.number().int().min(1).max(200).default(200),
    // Batches (HTTP requests) fetched per pass. 0 disables the pass entirely
    // (build plan §0.4: "0 ⇒ skip") without touching `enabled` — an operator
    // knob distinct from the master switch. Throughput wave (2026-07-21,
    // item 4): raised 4 -> 8 batches/pass * 96 passes/day (15 min cadence)
    // ≈ 768 batches/day (was ~384/day) — see the budget table above.
    maxBatchesPerPass: z.number().int().min(0).max(50).default(8),
    // How old `enriched_at` must be before a registry row is due for
    // RE-enrichment (never-enriched rows — `enriched_at IS NULL` — are
    // always due regardless of this). Most apps only need one-time
    // enrichment; currently-accelerating newborns bypass this staleness gate
    // entirely via `acceleratingLimit` below. Default 30 days.
    staleAfterMs: z.number().int().min(0).default(30 * 24 * 60 * 60 * 1000),
    // How many currently-accelerating newborns (`app-velocity-store.ts`'s
    // `getTopAcceleratingNewborns`) are force-included in each pass's
    // enrichment queue ahead of the staleness-ordered fill, regardless of
    // their own `enriched_at` age — a fast-moving app's price/rating/developer
    // data going stale matters more than an ordinary app's.
    acceleratingLimit: z.number().int().min(0).max(200).default(50),
    // Consecutive Lookup-API misses (the id absent from a batch's results —
    // Apple delisted it, or it never existed) before a registry row is
    // marked `delisted`. Default 1: a single miss is treated as a confident
    // delist signal, since a genuine transient gap (rate-limit, partial
    // response) is already handled by `ssrfSafeFetch`'s retry — see
    // `app-meta-store.ts`'s `recordEnrichmentMiss`.
    delistMissThreshold: z.number().int().min(1).max(10).default(1),
    // Rolling-24h cap on Lookup-API HTTP requests (lookup + portfolio
    // combined), tracked via the `appstore_lookup_requests` ledger — see
    // `app-meta-store.ts`'s `countLookupRequestsSince`. Throughput wave
    // (2026-07-21, item 4): raised 1,200 -> 2,400/day — see the budget
    // table above (was the build plan's §6 worst-case cap; real usage has
    // stayed well under it since PR #326/#327 fixed the dormant-lanes bug).
    // Raised again 2,400 -> 6,000/day (2026-07-21 capacity-raise escalation)
    // on the same separate-headroom grounds — this lane stays DIRECT
    // (`useProxy` below unchanged, still no proven ceiling data point either
    // way for the Lookup-API endpoint family), so the raise is a proactive
    // bet on the existing observed headroom, not proxy-enabled capacity.
    dailyRequestBudget: z.number().int().min(0).max(50_000).default(6_000),
    // Throughput wave item 1: routes `/lookup` batch + portfolio requests
    // through the Webshare proxy when set. Was default OFF ("this endpoint
    // has no proven ceiling data point either way; raised via the cap above
    // on separate headroom grounds instead"). MAX-THROUGHPUT PASS
    // (2026-07-22): flipped OFF -> ON for consistency with every other
    // high-volume appstore lane now riding the paid rotating proxy — no
    // reason to leave this one exposed to this box's direct IP while the
    // keyword-scan/mined/DE lanes above ride rotation at a much higher rate.
    useProxy: z.boolean().default(false),
    // Developer-portfolio sub-pass (build plan §0.1: sightings recorded with
    // source 'portfolio') — runs as part of the SAME 15-min enrichment pass
    // (no separate timer), gated to its own cadence via `minIntervalMs`.
    portfolio: z
      .object({
        enabled: z.boolean().default(true),
        minIntervalMs: z.number().int().min(60_000).default(15 * 60 * 1000),
        // Developers scanned per pass. Throughput wave (2026-07-21, item 4):
        // raised 2 -> 4/pass * 96 passes/day ≈ 384 requests/day (was ~192/day).
        developerLimit: z.number().int().min(0).max(50).default(4),
        // Ids requested per portfolio lookup — same ~200 ceiling as batchSize.
        portfolioLimit: z.number().int().min(1).max(200).default(200),
        // Minimum gap before a developer's portfolio is re-scanned. Default
        // 30 days — a developer's app list changes slowly.
        minRescanIntervalMs: z.number().int().min(0).default(30 * 24 * 60 * 60 * 1000),
      })
      .default({
        enabled: true,
        minIntervalMs: 15 * 60 * 1000,
        developerLimit: 4,
        portfolioLimit: 200,
        minRescanIntervalMs: 30 * 24 * 60 * 60 * 1000,
      }),
    // Lookup-request ledger prune — its own cadence (build plan §0.4 slot 7:
    // "+ request-log prune"), independent of the enrichment pass cadence.
    ledgerPrune: z
      .object({
        maxAgeMs: z.number().int().min(0).default(7 * 24 * 60 * 60 * 1000),
        minIntervalMs: z.number().int().min(60_000).default(24 * 60 * 60 * 1000),
      })
      .default({ maxAgeMs: 7 * 24 * 60 * 60 * 1000, minIntervalMs: 24 * 60 * 60 * 1000 }),
  })
  .default({
    enabled: true,
    minIntervalMs: 15 * 60 * 1000,
    batchSize: 200,
    maxBatchesPerPass: 8,
    staleAfterMs: 30 * 24 * 60 * 60 * 1000,
    acceleratingLimit: 50,
    delistMissThreshold: 1,
    dailyRequestBudget: 6_000,
    useProxy: false,
    portfolio: {
      enabled: true,
      minIntervalMs: 15 * 60 * 1000,
      developerLimit: 4,
      portfolioLimit: 200,
      minRescanIntervalMs: 30 * 24 * 60 * 60 * 1000,
    },
    ledgerPrune: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, minIntervalMs: 24 * 60 * 60 * 1000 },
  });
export type AppstoreAppEnrichmentConfig = z.infer<typeof appstoreAppEnrichmentConfigSchema>;

// ─── App Store newborn re-observation lane (throughput wave, item 2) ───────
// Daily lane: re-observes EVERY app ever recorded in `appstore_app_velocity`
// (the newborn-velocity population, apps < `maxAgeDays` — see
// `app-velocity.ts`'s `NEWBORN_AGE_DAYS_MAX` = 540) via the SAME batched
// `/lookup` client `app-lookup.ts` already provides (`chunkIds`,
// `fetchLookupBatch` — MAX_LOOKUP_BATCH_SIZE = 200), writing a fresh
// `appstore_app_velocity` observation per app (`reviews`/`rating` from the
// lookup result, `rank: null` — a lookup-sourced observation has no SERP
// position, mirroring `app-enrichment.ts`'s existing `"chart-first-seen"`
// synthetic-observation hook). This is audit NEXT item F: previously a
// newborn only got a fresh time-series point when a keyword-gap SERP scan
// happened to surface it — most newborns went days between accidental
// sightings, or never got a second observation at all. Default ON — see
// `newborn-reobservation.ts` for the pass implementation (MANDATORY
// wall-clock pass-deadline guard per `pass-deadline.ts`'s doc comment: this
// is exactly the "one slow-but-not-failing lane wedges every other lane on
// the shared tick" shape that PR #327 fixed for the other deep-scrape
// lanes — this NEW lane must not reintroduce that failure mode).
export const appstoreNewbornReobservationConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Minimum gap between passes — a genuinely daily lane (the whole
    // ~45k-app population in one pass, per `batchSize` below), decoupled
    // from the ~1min scan-sweep timer, mirroring `deStorefrontLane`'s
    // "one pass sweeps everything, so keep the cadence slow" rationale.
    minIntervalMs: z.number().int().min(60_000).default(24 * 60 * 60 * 1000),
    // Ids per `/lookup` batch request — same ~200 ceiling as
    // `appstoreAppEnrichment.batchSize` (`app-lookup.ts`'s
    // `MAX_LOOKUP_BATCH_SIZE`). At the default, ~200 ids/request covers the
    // ~45k-app tracked population in ~225 requests/day.
    batchSize: z.number().int().min(1).max(200).default(200),
    // An app older than this (days) is dropped from this pass's population
    // even if it's still present in `appstore_app_velocity` (a historical
    // row from when it WAS a newborn) — mirrors `app-velocity.ts`'s
    // `NEWBORN_AGE_DAYS_MAX`. Kept as an independent config field (not an
    // import) for the same reason that constant is independent of the
    // screener's newborn-age bound: these are operationally separate
    // concerns that should be retunable independently.
    maxAgeDays: z.number().int().min(1).max(3650).default(540),
    // Delay between successive `/lookup` batch requests within one pass —
    // same spirit as `appstoreKeywordGap.sweepDelayMs`, scoped to this
    // lane. At the default (~225 requests/pass), 225 * (300ms delay +
    // observed ~200-400ms iTunes latency) ≈ 2-2.5 minutes — comfortably
    // under the 5-minute wall-clock pass budget below even with headroom
    // for a slower-than-usual upstream.
    delayMs: z.number().int().min(0).max(10_000).default(300),
    // Throughput wave item 1: routes this lane's `/lookup` requests through
    // the Webshare proxy when set. Was default OFF, same endpoint-family
    // reasoning as `appstoreAppEnrichment.useProxy`. MAX-THROUGHPUT PASS
    // (2026-07-22): flipped OFF -> ON alongside that field, same rationale.
    useProxy: z.boolean().default(false),
  })
  .default({
    enabled: true,
    minIntervalMs: 24 * 60 * 60 * 1000,
    batchSize: 200,
    maxAgeDays: 540,
    delayMs: 300,
    useProxy: false,
  });
export type AppstoreNewbornReobservationConfig = z.infer<
  typeof appstoreNewbornReobservationConfigSchema
>;

// ─── App Store review-text harvester ────────────────────────────────────────
// Deep-scrape build Stage 4 (migration 047, `review-harvest-store.ts` /
// `review-harvester.ts`): rolling-cohort deep review-feed harvest (up to 10
// pages/app, `review-rss.ts`) for apps enrolled via three candidate sources
// (open signature hits, accelerating newborns, chart-sourced newborns).
// Wired into `scraper.ts`'s `keywordSweepTick` as `runReviewHarvestIfDue()`
// (build plan §0.4 slot 6) — NOT a new timer (`minIntervalMs` replaces the
// reviews spec's `tickIntervalMs` per build plan §0.2). Default ON, like the
// other network lanes added in this build (`deStorefrontLane`,
// `appstoreAppEnrichment`).
export const appstoreReviewHarvestConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Minimum gap between harvest passes — rides the existing ~1min
    // scan-sweep timer (no new timer); this just keeps the pass from
    // re-checking due enrollments on every single tick once one has just
    // run. Default 60s (effectively "every tick").
    minIntervalMs: z.number().int().min(1_000).default(60_000),
    // Apps drained per pass, before throttle scaling (build plan §0.4:
    // "appsPerTick × multiplier, floor 1" — see `review-harvester.ts`'s
    // `computeEffectiveAppsPerTick`).
    appsPerTick: z.number().int().min(0).max(50).default(3),
    // iTunes storefront the harvester fetches — lowercase cc (build plan
    // §0.5 convention). Reviews aren't multi-storefront in this build; kept
    // as a knob (not hardcoded "us") for forward compatibility.
    storefront: z.string().length(2).default("us"),
    // Delay between successive page fetches for the SAME app — politeness,
    // same spirit as `scraper.ts`'s `REQUEST_DELAY_MS`.
    pageDelayMs: z.number().int().min(0).default(500),
    // Consecutive harvest passes with zero NEW reviews before an enrollment
    // is deactivated (see `review-harvest-scheduling.ts`'s
    // `shouldDeactivateEnrollment`) — an app that's gone quiet stops
    // burning budget every cadence cycle. Independent of delisting (a
    // delisted app deactivates immediately regardless of this counter).
    maxConsecutiveEmptyHarvests: z.number().int().min(1).default(5),
    // "low-star-only" pre-marks 4/5-star review rows `indexed_at` at write
    // time (never enters the RAG-indexing unindexed queue — critical
    // 1-3-star review text is the more actionable signal); "all" indexes
    // every review, matching the legacy hourly path's implicit behavior.
    memoryIndexing: z.enum(["all", "low-star-only"]).default("low-star-only"),
    // Rolling-24h cap on review-feed page fetches (1 page = 1 HTTP
    // request), tracked via the `appstore_review_harvests` ledger — see
    // `review-harvest-store.ts`'s `countReviewPagesFetchedSince`. Throughput
    // wave (2026-07-21, item 4): raised 10,000 -> 15,000/day — this lane
    // runs at its cap today (real demand exceeds it), so raising it directly
    // unlocks more review coverage rather than sitting on unused headroom
    // like the lookup/app-page lanes — see the budget table on
    // `appstoreAppEnrichmentConfigSchema`. Raised again 15,000 -> 30,000/day
    // (2026-07-21 capacity-raise escalation), paired with flipping `useProxy`
    // below ON: since this lane runs AT its cap (real demand exceeds it),
    // doubling the budget without spreading the extra volume across rotating
    // IPs would be the most likely lane to trip a rate limit first.
    dailyRequestBudget: z.number().int().min(0).max(100_000).default(30_000),
    // Throughput wave item 1: routes review-feed page fetches through the
    // Webshare proxy when set. Was default OFF ("no proven ceiling data
    // point either way"). Flipped ON 2026-07-21 (capacity-raise escalation)
    // alongside doubling `dailyRequestBudget` above — this lane runs at its
    // cap today, so the extra volume goes out over rotating IPs rather than
    // this box's direct one. Gracefully falls back to direct fetch if the
    // proxy is unconfigured (see `appstore-proxy.ts`).
    useProxy: z.boolean().default(false),
    // Cohort-refresh sub-pass (build plan §0.4 slot 6 inner pass:
    // "runCohortRefreshIfDue 6h") — re-scans the 3 candidate sources (open
    // signature hits, accelerating newborns, chart-sourced newborns) and
    // enrolls/refreshes `appstore_review_harvest_state` rows. Own cadence,
    // decoupled from the per-tick harvest pass above.
    cohortRefresh: z
      .object({
        enabled: z.boolean().default(true),
        minIntervalMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000),
        signatureHitCap: z.number().int().min(0).max(500).default(100),
        velocityCap: z.number().int().min(0).max(500).default(50),
        chartNewbornCap: z.number().int().min(0).max(1000).default(200),
      })
      .default({
        enabled: true,
        minIntervalMs: 6 * 60 * 60 * 1000,
        signatureHitCap: 100,
        velocityCap: 50,
        chartNewbornCap: 200,
      }),
    // Review-harvest ledger prune — its own cadence (build plan §0.4 slot 6
    // inner pass: "runReviewPruneIfDue 24h"), mirrors
    // `appstoreAppEnrichment.ledgerPrune`.
    ledgerPrune: z
      .object({
        maxAgeMs: z.number().int().min(0).default(7 * 24 * 60 * 60 * 1000),
        minIntervalMs: z.number().int().min(60_000).default(24 * 60 * 60 * 1000),
      })
      .default({ maxAgeMs: 7 * 24 * 60 * 60 * 1000, minIntervalMs: 24 * 60 * 60 * 1000 }),
  })
  .default({
    enabled: true,
    minIntervalMs: 60_000,
    appsPerTick: 3,
    storefront: "us",
    pageDelayMs: 500,
    maxConsecutiveEmptyHarvests: 5,
    memoryIndexing: "low-star-only",
    dailyRequestBudget: 30_000,
    useProxy: false,
    cohortRefresh: {
      enabled: true,
      minIntervalMs: 6 * 60 * 60 * 1000,
      signatureHitCap: 100,
      velocityCap: 50,
      chartNewbornCap: 200,
    },
    ledgerPrune: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, minIntervalMs: 24 * 60 * 60 * 1000 },
  });
export type AppstoreReviewHarvestConfig = z.infer<typeof appstoreReviewHarvestConfigSchema>;

// ─── App Store product-page HTML enrichment ─────────────────────────────────
// Deep-scrape build Stage 5 (migration 048, `app-pages-store.ts` /
// `app-pages.ts` / `app-page-parse.ts`): fetches each tracked app's
// `apps.apple.com` product page (the heaviest per-request lane in this
// build — ~0.6-1MB HTML per fetch, verified live — hence the most
// conservative pacing/cadence of any lane) for data no JSON API surfaces:
// the ratings-star histogram, in-app-purchase price list, and related-apps
// ("similar" + "more by developer") edges. Wired into `scraper.ts`'s
// `keywordSweepTick` as `runAppPageEnrichmentIfDue()` (build plan §0.4 slot
// 8) — NOT a new timer. Default ON, like the other network lanes added in
// this build (`appstoreAppEnrichment`, `appstoreReviewHarvest`).
export const appstoreAppPagesConfigSchema = z
  .object({
    // Master switch. Default ON.
    enabled: z.boolean().default(true),
    // Minimum gap between fetch passes — rides the existing ~1min
    // scan-sweep timer (no new timer). Build plan §0.4 slot 8: 5 min.
    minIntervalMs: z.number().int().min(60_000).default(5 * 60 * 1000),
    // Pages fetched per pass, before throttle scaling (`pagesPerBatch ×
    // multiplier`, see `scraper.ts`'s `runAppPageEnrichmentIfDue`). Default
    // 10/pass * ~288 passes/day (5min cadence) ≈ 2,880/day, close to the
    // build plan's §6 steady-state estimate (~2,600/day) for this lane —
    // the `dailyPageBudget` ledger below is the real ceiling regardless.
    pagesPerBatch: z.number().int().min(0).max(50).default(10),
    // `apps.apple.com` storefront the pass fetches — lowercase cc (build
    // plan §0.5 convention). Kept as a knob (not hardcoded "us") for
    // forward compatibility; this build only ever passes "us".
    storefront: z.string().length(2).default("us"),
    // Delay between successive page fetches within one pass — deliberately
    // larger than `appstoreReviewHarvest.pageDelayMs` (different host,
    // heaviest payload, most conservative pacing per build plan §5).
    requestDelayMs: z.number().int().min(0).default(1_000),
    // Rolling-24h cap on product-page HTTP requests, tracked via the
    // `appstore_app_ratings_history` ledger (see `app-pages-store.ts`'s
    // `countPageFetchesSince` — that table doubles as this lane's request
    // ledger, migration 048). Throughput wave (2026-07-21, item 4): raised
    // 3,000 -> 5,000/day — see the budget table on
    // `appstoreAppEnrichmentConfigSchema`. Safe to raise further than the
    // lookup/review lanes precisely BECAUSE `useProxy` below defaults ON
    // for this lane (item 1): the heaviest per-request payload (~0.6-1MB
    // HTML) already routes off this box's direct IP. Raised again
    // 5,000 -> 15,000/day (2026-07-21 capacity-raise escalation): this lane
    // was already proxied and is the primary target the proxy layer was
    // built to protect, so it absorbs the largest single raise of all the
    // lanes touched in this pass.
    dailyPageBudget: z.number().int().min(0).max(50_000).default(15_000),
    // Throughput wave item 1: routes product-page HTML fetches through the
    // Webshare proxy when set. Default ON (unlike every other App Store
    // lane) — this is the PRIMARY target lane for the proxy: heaviest
    // per-request payload, most valuable to spread across rotating IPs, and
    // the lane this feature was built to protect first. Gracefully falls
    // back to direct fetch if the proxy is unconfigured (see
    // `appstore-proxy.ts`) — flipping this to `false` reverts to the
    // pre-proxy direct-fetch behavior with zero other changes.
    useProxy: z.boolean().default(true),
    // How old a HOT-tier row's `last_fetched_at` must be before it's due for
    // re-fetch. Default 24h — a signature-hit-related / accelerating-newborn
    // app's IAP/rating/related data is worth refreshing daily.
    hotIntervalMs: z.number().int().min(0).default(24 * 60 * 60 * 1000),
    // How old a ROLLING-tier row's `last_fetched_at` must be before it's due
    // for re-fetch. Default 14 days — the general corpus rotation, refreshed
    // far more slowly than the hot tier given the per-fetch cost.
    rollingIntervalMs: z.number().int().min(0).default(14 * 24 * 60 * 60 * 1000),
    // Sync sub-pass (build plan §0.4 slot 8: hot/rolling tier membership,
    // `app-pages-store.ts`'s `syncTrackedAppPages`) — runs as part of the
    // SAME tick (no separate timer), gated to its own cadence, mirroring
    // `appstoreReviewHarvest.cohortRefresh`. Pure DB reads/writes (no
    // network), so it can run on a faster cadence than the fetch pass
    // without adding to this lane's request budget.
    sync: z
      .object({
        enabled: z.boolean().default(true),
        minIntervalMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000),
        // Same defaults as `appstoreReviewHarvest.cohortRefresh`'s
        // `signatureHitCap`/`velocityCap` — the SAME two candidate sources
        // (`review-harvest-store.ts`'s `getSignatureHitCandidates` /
        // `getVelocityCandidates`) define the "hot" tier here too.
        hotSignatureHitCap: z.number().int().min(0).max(500).default(100),
        hotVelocityCap: z.number().int().min(0).max(500).default(50),
        // New ROLLING-tier apps enrolled per sync pass, from the app-meta
        // registry's most-recently-seen ids not yet tracked. Bounds one
        // sync's enrollment burst — the registry can hold 100k+ rows, and
        // this lane's per-fetch cost means the tracked pool should grow
        // gradually, not all at once.
        rollingAddPerSync: z.number().int().min(0).max(5_000).default(500),
      })
      .default({
        enabled: true,
        minIntervalMs: 6 * 60 * 60 * 1000,
        hotSignatureHitCap: 100,
        hotVelocityCap: 50,
        rollingAddPerSync: 500,
      }),
    // Batch canary (build plan §5): if a fetch pass attempts at least
    // `minBatchSize` apps and more than `parseFailureThreshold` of them fail
    // to PARSE (not fetch — a 200 response `app-page-parse.ts` couldn't make
    // sense of), `app-pages.ts` logs an ALARM — a parse-failure spike across
    // many different apps in one pass is the signature of Apple changing the
    // page's JSON shape, not any one app being broken.
    canary: z
      .object({
        minBatchSize: z.number().int().min(1).default(10),
        parseFailureThreshold: z.number().min(0).max(1).default(0.5),
      })
      .default({ minBatchSize: 10, parseFailureThreshold: 0.5 }),
  })
  .default({
    enabled: true,
    minIntervalMs: 5 * 60 * 1000,
    pagesPerBatch: 10,
    storefront: "us",
    requestDelayMs: 1_000,
    dailyPageBudget: 15_000,
    useProxy: true,
    hotIntervalMs: 24 * 60 * 60 * 1000,
    rollingIntervalMs: 14 * 24 * 60 * 60 * 1000,
    sync: {
      enabled: true,
      minIntervalMs: 6 * 60 * 60 * 1000,
      hotSignatureHitCap: 100,
      hotVelocityCap: 50,
      rollingAddPerSync: 500,
    },
    canary: { minBatchSize: 10, parseFailureThreshold: 0.5 },
  });
export type AppstoreAppPagesConfig = z.infer<typeof appstoreAppPagesConfigSchema>;

// App Store ranking-sync breadth: how aggressively the scraper's ~hourly
// ranking tick (scraper.ts `scrape()`) pulls chart data. Feeds the keyword
// miner (more distinct apps → more candidate keywords), so wider breadth
// directly improves keyword-corpus discovery.
export const appstoreSyncListTypeSchema = z.enum(["top-free", "top-paid", "top-grossing"]);
export type AppstoreSyncListType = z.infer<typeof appstoreSyncListTypeSchema>;

export const appstoreSyncConfigSchema = z
  .object({
    // Per-category (genre) iTunes RSS page size. The RSS feed itself caps at
    // ~100 entries regardless of the requested limit (verified live), so 200
    // is a harmless ceiling that always yields the max the feed will give.
    perCategoryLimit: z.number().int().min(1).max(200).default(200),
    // Which iTunes RSS chart list types to fetch per category. All three are
    // verified to return distinct per-genre rankings (top free, top paid, top
    // grossing) — fetching all three multiplies per-category ranking
    // breadth ~3x versus top-free alone.
    listTypes: z
      .array(appstoreSyncListTypeSchema)
      .min(1)
      .default(["top-free", "top-paid", "top-grossing"]),
    // Page size for the GLOBAL (cross-category) top-free / top-paid feeds,
    // served by rss.applemarketingtools.com — a DIFFERENT API from the
    // per-category iTunes RSS above, with its own hard cap: requests above
    // limit=100 return HTTP 500 (verified live). 100 is the real ceiling,
    // not just a default.
    globalLimit: z.number().int().min(1).max(100).default(100),
    // Throughput wave item 1: routes the hourly ranking tick's global +
    // per-category chart fetches (and discovery/legacy-review lookups —
    // see `scraper.ts`'s `fetchJson`) through the Webshare proxy when set.
    // Default OFF — same "no proven ceiling either way, not the primary
    // proxy target" reasoning as the other non-app-page lanes.
    useProxy: z.boolean().default(false),
    // International storefront chart sweep (deep-scrape build Stage 3,
    // §0.1/§0.3) — reuses the SAME per-category iTunes RSS charts as above
    // (`charts.ts`'s `buildCategoryRankingUrl`/`ITUNES_CATEGORIES`) but for
    // non-US storefronts, gated to its own cadence off the ~1min sweep tick
    // (see `scraper.ts`'s `runIntlChartsIfDue`) — NOT the ~hourly `scrape()`
    // tick this section otherwise configures. Deliberately has NO `firstSeen`
    // block (build plan §0.1: the metadata stage's `appstore_app_meta`
    // registry is the single first-seen registry; intl sightings are
    // recorded there with source `'chart-intl'`).
    intlCharts: z
      .object({
        // Master switch. Default ON.
        enabled: z.boolean().default(true),
        // Lowercase iTunes storefront country codes (build plan §0.5
        // convention). GB/CA/AU chosen as the initial set — large English-
        // language storefronts distinct enough from US charts to surface
        // apps the US-only sweep misses.
        storefronts: z.array(z.string().length(2)).min(1).default(["gb", "ca", "au"]),
        // Minimum gap between intl-charts passes — one pass sweeps every
        // configured storefront's whole category list in one shot (batch
        // truncated by the shared adaptive throttle), so a slow cadence
        // (default 12h) keeps this lane's request volume small relative to
        // the hourly US chart tick — see the build plan's §6 budget table.
        minIntervalMs: z.number().int().min(60_000).default(12 * 60 * 60 * 1000),
        // Which iTunes RSS chart list types to fetch per (category,
        // storefront) pair — same enum/defaults as the US `listTypes` above,
        // configured independently so an operator can narrow intl breadth
        // without touching the US lane.
        listTypes: z
          .array(appstoreSyncListTypeSchema)
          .min(1)
          .default(["top-free", "top-paid", "top-grossing"]),
        // Delay between each work-item's iTunes call within one intl-charts
        // pass — same spirit as `appstoreKeywordGap.sweepDelayMs`, scoped to
        // this separate pass.
        delayMs: z.number().int().min(100).max(10_000).default(1000),
        // Throughput wave item 1: routes intl-storefront chart fetches
        // through the Webshare proxy when set. Default OFF, same reasoning
        // as the US lane's `useProxy` above.
        useProxy: z.boolean().default(false),
      })
      .default({
        enabled: true,
        storefronts: ["gb", "ca", "au"],
        minIntervalMs: 12 * 60 * 60 * 1000,
        listTypes: ["top-free", "top-paid", "top-grossing"],
        delayMs: 1000,
        useProxy: false,
      }),
  })
  .default({
    perCategoryLimit: 200,
    listTypes: ["top-free", "top-paid", "top-grossing"],
    globalLimit: 100,
    useProxy: false,
    intlCharts: {
      enabled: true,
      storefronts: ["gb", "ca", "au"],
      minIntervalMs: 12 * 60 * 60 * 1000,
      listTypes: ["top-free", "top-paid", "top-grossing"],
      delayMs: 1000,
      useProxy: false,
    },
  });
export type AppstoreSyncConfig = z.infer<typeof appstoreSyncConfigSchema>;

// Apple Ads (Search Ads) external-demand connection foundation — Phase 4a.
// Default OFF. This flag is a FUTURE activation switch for a not-yet-built
// automated fetch/store/scoring pipeline; it does NOT gate the manual
// test-connection / probe routes in src/web/routes/apple-ads.ts (those work
// whenever credentials are configured, regardless of this flag, so an admin
// can validate a new Apple Ads account before flipping it on). See
// docs/superpowers/specs/2026-07-14-apple-ads-demand-foundation-design.md.
export const appstoreExternalDemandConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({ enabled: false });
export type AppstoreExternalDemandConfig = z.infer<typeof appstoreExternalDemandConfigSchema>;

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
    pollIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .default(5 * 60 * 1_000),
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
  provider: z
    .enum(["openrouter", "agent-sdk", "alibaba", "anthropic", "opencode"])
    .default("anthropic"),
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

// Default weights for the 9 GIANT rubric axes. They are non-compensatory
// inputs into a weighted geometric mean; the values intentionally sum to 1.0
// but are not normalized here (the aggregation math owns that). Each axis is
// scored 0..5; acuteProblem/whyNow/monetization/feasibility are hard gates and
// demand is evidence-gated.
// MUST stay in lockstep with src/pipelines/ideas/giant.ts GIANT_AXES weights.
export const GIANT_DEFAULT_WEIGHTS = {
  acuteProblem: 0.2,
  whyNow: 0.15,
  demand: 0.15,
  monetization: 0.13,
  feasibility: 0.12,
  nonObviousness: 0.1,
  defensibility: 0.07,
  marketShape: 0.04,
  founderFit: 0.04,
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
    // How many candidates to score per GIANT-critique LLM call. The critic is
    // CHUNKED: scoring the whole over-generated pool (~20) in one call made the
    // 38-41k-char response TRUNCATE (even at a 32k cap), so the back-half
    // scorecards were dropped and NO candidate bound a GIANT critique (every
    // giant_* column persisted NULL). A small batch fits the budget, parses
    // cleanly, and stays positionally aligned per batch. 0 disables chunking
    // (single call over the whole pool — legacy behavior).
    critiqueBatchSize: z.number().int().min(0).max(40).default(7),
    // Per-axis weights for the weighted geometric mean. Optional + fully
    // defaulted so existing config stays backward-compatible.
    weights: z
      .object({
        acuteProblem: z.number().default(GIANT_DEFAULT_WEIGHTS.acuteProblem),
        whyNow: z.number().default(GIANT_DEFAULT_WEIGHTS.whyNow),
        demand: z.number().default(GIANT_DEFAULT_WEIGHTS.demand),
        monetization: z.number().default(GIANT_DEFAULT_WEIGHTS.monetization),
        feasibility: z.number().default(GIANT_DEFAULT_WEIGHTS.feasibility),
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
    critiqueBatchSize: 7,
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
// NOTE: no anthropic entry here — the default panel must not bill the personal
// Claude OAuth account. Users can still configure anthropic via judgeModels override.
export const SIGE_DEFAULT_JUDGE_MODELS: readonly { provider: string; model: string }[] = [
  { provider: "opencode", model: "deepseek-v4-flash" },
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
        /**
         * Cosine floor for joining an existing semantic cluster. Tuned 2026-06-21
         * against real nomic embeddings of idea text: short same-domain ideas sit
         * in a compressed ~0.49–0.78 cosine band (within≈cross-archetype), so the
         * original 0.62 collapsed everything into ONE frontier. 0.67 yields ~4–5
         * distinct frontiers; 0.69+ over-splits past the cluster cap.
         */
        similarityThreshold: z.number().min(0).max(1).default(0.67),
      })
      .default({ enabled: true, similarityThreshold: 0.67 }),
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
    semanticFrontiers: { enabled: true, similarityThreshold: 0.67 },
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
    // Recency half-life (days) for outcome-memory recall ranking. <=0 disables
    // temporal decay (composite collapses to raw relevance × staleness factor).
    halfLifeDays: z.number().min(0).default(45),
    // Multiplier (0..1) applied to a memory whose promptVersion/model differ from
    // the current run — down-weights guidance generated under a stale prompt/model.
    // 1 = no penalty.
    stalePromptPenalty: z.number().min(0).max(1).default(0.6),
    // MMR diversity lambda (0..1) for the recall block. 1 = pure relevance (no
    // diversification); lower trades relevance for less near-duplicate guidance.
    mmrLambda: z.number().min(0).max(1).default(0.7),
    // Before writing a real verdict for an ideaId, delete its prior outcome
    // memories so a re-run supersedes rather than duplicates. Default ON.
    supersedePriorOnRerun: z.boolean().default(true),
    // Write stored-pending / verdictSource:"none" memories (no real verdict yet).
    // Default OFF: un-adjudicated ideas dilute recall. dedup-rejected is unaffected.
    writePendingMemories: z.boolean().default(false),
    // ── Phase 2: trust-tiered recall (read path) ──────────────────────────────
    // When ON, stable-sort already-ranked recall so GOLD (human) / REPROBE
    // (deferred re-probe) tiers lead PROXY (same-run self-grades) lead NONE
    // (legacy/unknown), and cap proxy-tier AVOID bullets at proxyAvoidCap. Default
    // ON (2026-06-23): the recall eval confirmed this stops same-run proxy
    // self-grades from crowding the scarce real (human/reprobe) lessons out of the
    // AVOID bucket; OFF reverts to the byte-identical pre-Phase-2 ranking.
    trustWeighting: z.boolean().default(true),
    // Max PROXY-tier AVOID bullets kept when trustWeighting is ON, so self-graded
    // archivals can't crowd out gold/reprobe lessons. Only consulted when ON.
    proxyAvoidCap: z.number().int().min(0).max(20).default(2),
    // ── Phase 2: deferred outcome re-probe ────────────────────────────────────
    // A bespoke cron-side scheduler re-runs the demand probes for proxy-VALIDATED
    // ideas after delayDays and supersedes the original proxy verdict with a real
    // "reprobe:*" outcome memory (grew → validated, decayed → archived, flat →
    // stored-pending). Default OFF: no table is enqueued and the scheduler never
    // starts, so the pipeline is byte-identical.
    reprobe: z
      .object({
        // Master switch. Gates BOTH the enqueue points and the cron-side
        // scheduler. Off ⇒ no enqueue rows, no scheduler, no mem0 write.
        // ON (2026-06-23): proxy-validated ideas (with a real, above-absence-floor
        // baseline demand snapshot) are re-probed after delayDays and superseded
        // with REPROBE-tier ground truth — the real signal the trust tiers rank on.
        enabled: z.boolean().default(true),
        // How many days after a proxy-validation to re-probe demand.
        delayDays: z.number().int().min(1).default(21),
        // Scheduler tick interval (ms). Default 1h — the work is sparse and DB-bound.
        tickIntervalMs: z.number().int().default(3_600_000),
        // Score delta (current − baseline demand score) at/above which demand
        // "grew" → re-validate the idea.
        scoreDeltaGrew: z.number().default(0.75),
        // Score delta at/below which demand "decayed" → archive the idea.
        scoreDeltaDecayed: z.number().default(-0.75),
        // Max due rows claimed + processed (sequentially) per tick.
        batchSize: z.number().int().min(1).max(50).default(5),
      })
      .default({
        enabled: true,
        delayDays: 21,
        tickIntervalMs: 3_600_000,
        scoreDeltaGrew: 0.75,
        scoreDeltaDecayed: -0.75,
        batchSize: 5,
      }),
  })
  .default({
    writeBack: true,
    readAtSynthesis: true,
    reinforceCap: 5,
    avoidCap: 5,
    searchLimit: 12,
    halfLifeDays: 45,
    stalePromptPenalty: 0.6,
    mmrLambda: 0.7,
    supersedePriorOnRerun: true,
    writePendingMemories: false,
    trustWeighting: true,
    proxyAvoidCap: 2,
    reprobe: {
      enabled: true,
      delayDays: 21,
      tickIntervalMs: 3_600_000,
      scoreDeltaGrew: 0.75,
      scoreDeltaDecayed: -0.75,
      batchSize: 5,
    },
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
    // Phase 3 graph feedback — cold-start neutral weight for an un-projected seed.
    // coalesce(success_weight, neutralWeight) keeps an empty weight table at
    // ~degree behavior (the read path's ORDER BY collapses to the degree tiebreak).
    neutralWeight: z.number().min(0).max(10).default(1),
    // Phase 3 graph feedback — novelty half-life in RUNS: a seed that has fed this
    // many runs is novelty-halved, so traversal rotates off over-used seeds.
    noveltyHalfLifeRuns: z.number().int().min(1).max(100).default(10),
  })
  .default({
    enabled: false,
    maxHops: 2,
    maxPaths: 8,
    searchLimit: 25,
    minDegree: 3,
    maxDegree: 200,
    neutralWeight: 1,
    noveltyHalfLifeRuns: 10,
  });
export type GraphReasoningConfig = z.infer<typeof graphReasoningConfigSchema>;

// Phase 3 "graph outcome feedback": learn which seed entities historically
// produced GOOD ideas and project that back onto the live graph so opportunity-
// path traversal favors them (breaking the degree-DESC monoculture). Default OFF
// → no Postgres/Neo4j writes and the read path stays at neutral/degree. Fully
// defaulted -> backward-compatible.
export const graphFeedbackConfigSchema = z
  .object({
    // Master switch. OFF → no exposure recording, no event log, no projection.
    enabled: z.boolean().default(false),
    // Signed credit a VALIDATED idea contributes to the run's aggregate verdict.
    validatedWeight: z.number().default(1),
    // Signed (negative) debit a KILLED idea contributes to the aggregate verdict.
    killedWeight: z.number().default(-1),
    // Half-life (days) of the temporal decay applied to each event's weight when
    // materializing graph_seed_weights, so stale outcomes fade.
    weightHalfLifeDays: z.number().default(60),
    // Clamp on the per-seed aggregate weight magnitude (±maxSeedWeight).
    maxSeedWeight: z.number().default(5),
    // Whether to project the materialized weights onto the live Neo4j graph (the
    // only step that opens a WRITE session). When false, bookkeeping still runs in
    // Postgres but the graph is untouched.
    projectToNeo4j: z.boolean().default(true),
    // Retention (days) for the append-only `:IdeaAnchor` log. Each run MERGEs a NEW
    // anchor node, so without a prune the anchor set grows unbounded once feedback
    // is enabled. The cron-side prune scheduler DETACH DELETEs anchors older than
    // this (safe — the read path never traverses :IdeaAnchor).
    anchorRetentionDays: z.number().int().min(1).default(90),
    // How often the prune scheduler runs (ms). Default daily — anchor growth is
    // slow (one per run) so a sparse cadence is plenty.
    pruneTickIntervalMs: z.number().int().min(60_000).default(86_400_000),
  })
  .default({
    enabled: false,
    validatedWeight: 1,
    killedWeight: -1,
    weightHalfLifeDays: 60,
    maxSeedWeight: 5,
    projectToNeo4j: true,
    anchorRetentionDays: 90,
    pruneTickIntervalMs: 86_400_000,
  });
export type GraphFeedbackConfig = z.infer<typeof graphFeedbackConfigSchema>;

// Phase 4 "A/B holdout": deterministically send a fraction of idea-pipeline runs
// down a memory/graph-BLIND path (no learned guidance injected) so guided-vs-blind
// validated rates measure whether the funnel actually gets smarter. The split is
// per-RUN (guidance is injected once per run). Default OFF / ratio 0 → every run
// is guided and the pipeline is byte-identical. Fully defaulted -> backward-compatible.
export const abHoldoutConfigSchema = z
  .object({
    // Master switch. OFF → no arm assignment, no lesson recording, all guided.
    // ON (2026-06-23): measure the lift of the outcome-memory learning (now that
    // trustWeighting is the default) against a blind control arm.
    enabled: z.boolean().default(true),
    // Fraction of runs assigned the BLIND arm. 0 → never blind (always guided);
    // 1 → always blind. Deterministic per run id (no RNG). 0.5 → balanced arms for
    // the fastest, cleanest lift readout (lift summary reports at ≥20 runs/arm).
    holdoutRatio: z.number().min(0).max(1).default(0.5),
  })
  .default({
    enabled: true,
    holdoutRatio: 0.5,
  });
export type AbHoldoutConfig = z.infer<typeof abHoldoutConfigSchema>;

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

// SOURCE-PICK HARD-DROP exclusion: eliminate signals whose audience is a
// LOCAL / SMB SERVICE BUSINESS or whose core is REGION-LOCKED, at collector time
// (before they can become candidates) — the earliest layer of the layered
// elimination (generation prompt + jury are the later layers). Degrade-safe:
// when off, the collector filter is a pure no-op. Default ON, pure-logic.
export const sourceExclusionConfigSchema = z
  .object({
    // Master switch. When false the collector-stage filter is a no-op (signals
    // are kept and only the later generation/jury layers apply). Default ON.
    excludeSourceAudienceRegion: z.boolean().default(true),
  })
  .default({ excludeSourceAudienceRegion: true });
export type SourceExclusionConfig = z.infer<typeof sourceExclusionConfigSchema>;

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
  // Phase 3 "graph outcome feedback": learn productive seed entities + project
  // success weights onto the live graph so traversal favors them. Default OFF
  // (gated alongside graphReasoning + sige.neo4j). Fully defaulted ->
  // backward-compatible.
  graphFeedback: graphFeedbackConfigSchema,
  // Phase 4 "A/B holdout": deterministic per-run guided-vs-blind split that makes
  // the learning lift MEASURABLE. Default OFF (ratio 0) → all runs guided, pipeline
  // byte-identical. Fully defaulted -> backward-compatible.
  abHoldout: abHoldoutConfigSchema,
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
  // SOURCE-PICK HARD-DROP exclusion: drop local/SMB-service-business-audience and
  // region-locked signals at collector time. Default ON, pure-logic, reversible.
  sourceExclusion: sourceExclusionConfigSchema,
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
    critiqueBatchSize: 7,
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
    semanticFrontiers: { enabled: true, similarityThreshold: 0.67 },
  },
  outcomeMemory: {
    writeBack: true,
    readAtSynthesis: true,
    reinforceCap: 5,
    avoidCap: 5,
    searchLimit: 12,
    halfLifeDays: 45,
    stalePromptPenalty: 0.6,
    mmrLambda: 0.7,
    supersedePriorOnRerun: true,
    writePendingMemories: false,
    trustWeighting: true,
    proxyAvoidCap: 2,
    reprobe: {
      enabled: true,
      delayDays: 21,
      tickIntervalMs: 3_600_000,
      scoreDeltaGrew: 0.75,
      scoreDeltaDecayed: -0.75,
      batchSize: 5,
    },
  },
  graphReasoning: {
    enabled: false,
    maxHops: 2,
    maxPaths: 8,
    searchLimit: 25,
    minDegree: 3,
    maxDegree: 200,
    neutralWeight: 1,
    noveltyHalfLifeRuns: 10,
  },
  graphFeedback: {
    enabled: false,
    validatedWeight: 1,
    killedWeight: -1,
    weightHalfLifeDays: 60,
    maxSeedWeight: 5,
    projectToNeo4j: true,
    anchorRetentionDays: 90,
    pruneTickIntervalMs: 86_400_000,
  },
  abHoldout: {
    enabled: true,
    holdoutRatio: 0.5,
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
    hardVetoDimensions: ["regulated", "capital", "logistics", "networkEffect"] as (
      | "regulated"
      | "capital"
      | "logistics"
      | "networkEffect"
    )[],
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
  sourceExclusion: {
    excludeSourceAudienceRegion: true,
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
  // App Store keyword-gap scanner: standalone feature, independent of the
  // SIGE ideas pipeline. Default OFF (see appstoreKeywordGapConfigSchema).
  appstoreKeywordGap: appstoreKeywordGapConfigSchema,
  // Newborn-velocity screener: runs after the keyword-gap scanner's scan
  // batches. Default ON (see appstoreSignatureScreenerConfigSchema).
  appstoreSignatureScreener: appstoreSignatureScreenerConfigSchema,
  // Newborn-velocity time-series: records bucketed per-app observations off
  // the SERP scan. Default ON (see appstoreVelocityConfigSchema).
  appstoreVelocity: appstoreVelocityConfigSchema,
  // Post-scan junk-keyword deactivation. Default ON (see
  // appstoreJunkDeactivationConfigSchema).
  appstoreJunkDeactivation: appstoreJunkDeactivationConfigSchema,
  // App Store ranking-sync breadth (per-category limit/list-types + global
  // feed limit). See appstoreSyncConfigSchema.
  appstoreSync: appstoreSyncConfigSchema,
  // App-meta registry Lookup-API enrichment (deep-scrape build Stage 2).
  // Default ON — see appstoreAppEnrichmentConfigSchema.
  appstoreAppEnrichment: appstoreAppEnrichmentConfigSchema,
  // Newborn re-observation lane (throughput wave item 2, audit NEXT item F).
  // Default ON — see appstoreNewbornReobservationConfigSchema.
  appstoreNewbornReobservation: appstoreNewbornReobservationConfigSchema,
  // Review-text harvester (deep-scrape build Stage 4). Default ON — see
  // appstoreReviewHarvestConfigSchema.
  appstoreReviewHarvest: appstoreReviewHarvestConfigSchema,
  // Product-page HTML enrichment (deep-scrape build Stage 5). Default ON —
  // see appstoreAppPagesConfigSchema.
  appstoreAppPages: appstoreAppPagesConfigSchema,
  // Apple Ads (Search Ads) external-demand connection foundation. Default
  // OFF; see appstoreExternalDemandConfigSchema.
  appstoreExternalDemand: appstoreExternalDemandConfigSchema,
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
// AppstoreKeywordGapConfig is also exported directly from its schema
// declaration above.
// SigeAutoConfig and OutcomeMemoryConfig are also exported directly from their
// schema declarations above.
