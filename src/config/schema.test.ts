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
  sigeAutoConfigSchema,
  DEFAULT_AGENT_WORKSPACE,
  DEFAULT_BLOCKED_COMMANDS,
} from "./schema";

// ── stratifiedIntake config ───────────────────────────────────────────────────

describe("stratifiedIntake config", () => {
  test("defaults to the broadened behavior", () => {
    const cfg = opencrowConfigSchema.parse({});
    const s = cfg.pipelines.ideas.smart.stratifiedIntake;
    expect(s.enabled).toBe(true);
    expect(s.perBucketCap).toBe(8);
    expect(s.totalCap).toBe(90);
    expect(s.fetchLimit).toBe(100);
  });

  test("is reversible via config", () => {
    const cfg = opencrowConfigSchema.parse({
      pipelines: { ideas: { smart: { stratifiedIntake: { enabled: false } } } },
    });
    expect(cfg.pipelines.ideas.smart.stratifiedIntake.enabled).toBe(false);
  });
});

describe("synthesisDeadlineMs config", () => {
  test("defaults to 25 minutes (above the generic 12m step deadline)", () => {
    const cfg = opencrowConfigSchema.parse({});
    // The synthesis step is the slowest; its deadline must exceed the generic
    // 12-min DEFAULT_STEP_DEADLINE_MS or slow-but-progressing runs get killed.
    expect(cfg.pipelines.ideas.smart.synthesisDeadlineMs).toBe(1_500_000);
    expect(cfg.pipelines.ideas.smart.synthesisDeadlineMs).toBeGreaterThan(12 * 60 * 1000);
  });

  test("is tunable within the 5m–60m bounds", () => {
    const cfg = opencrowConfigSchema.parse({
      pipelines: { ideas: { smart: { synthesisDeadlineMs: 3_600_000 } } },
    });
    expect(cfg.pipelines.ideas.smart.synthesisDeadlineMs).toBe(3_600_000);
  });

  test("rejects values outside the 5m–60m bounds", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        pipelines: { ideas: { smart: { synthesisDeadlineMs: 299_999 } } },
      }),
    ).toThrow();
    expect(() =>
      opencrowConfigSchema.parse({
        pipelines: { ideas: { smart: { synthesisDeadlineMs: 3_600_001 } } },
      }),
    ).toThrow();
  });
});

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
  test("defaults are applied correctly (safe by default)", () => {
    const result = toolsConfigSchema.parse({});
    // Confined to a dedicated agent workspace, not the whole $HOME.
    expect(result.allowedDirectories).toEqual([DEFAULT_AGENT_WORKSPACE]);
    // Ships a non-empty denylist of dangerous commands by default.
    expect(result.blockedCommands).toEqual([...DEFAULT_BLOCKED_COMMANDS]);
    expect(result.blockedCommands).toContain("sudo");
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

// ── sigeAutoConfigSchema ──────────────────────────────────────────────────────

describe("sigeAutoConfigSchema", () => {
  test("parses an empty object with all defaults", () => {
    const result = sigeAutoConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.maxDeepFrontiers).toBe(1);
    expect(result.broadFrontierCap).toBe(8);
    expect(result.broadPoolSize).toBe(50);
    expect(result.cadence).toBe("daily");
    expect(result.maxConcurrent).toBe(1);
    expect(result.memoryWriteback).toBe(false);
    expect(result.perRunCostCeilingUsd).toBe(0);
  });

  test("default enabled is false (master switch OFF)", () => {
    const result = sigeAutoConfigSchema.parse({});
    expect(result.enabled).toBe(false);
  });

  test("enabled=true parses correctly", () => {
    const result = sigeAutoConfigSchema.parse({ enabled: true });
    expect(result.enabled).toBe(true);
  });

  test("maxDeepFrontiers=1 is valid (minimum)", () => {
    const result = sigeAutoConfigSchema.parse({ maxDeepFrontiers: 1 });
    expect(result.maxDeepFrontiers).toBe(1);
  });

  test("maxDeepFrontiers=8 is valid (maximum)", () => {
    const result = sigeAutoConfigSchema.parse({ maxDeepFrontiers: 8 });
    expect(result.maxDeepFrontiers).toBe(8);
  });

  test("maxDeepFrontiers > 8 is rejected", () => {
    expect(() => sigeAutoConfigSchema.parse({ maxDeepFrontiers: 9 })).toThrow();
  });

  test("broadFrontierCap=8 is the default", () => {
    const result = sigeAutoConfigSchema.parse({});
    expect(result.broadFrontierCap).toBe(8);
  });

  test("broadFrontierCap=1 is valid (minimum)", () => {
    const result = sigeAutoConfigSchema.parse({ broadFrontierCap: 1 });
    expect(result.broadFrontierCap).toBe(1);
  });

  test("broadFrontierCap > 8 is rejected", () => {
    expect(() => sigeAutoConfigSchema.parse({ broadFrontierCap: 9 })).toThrow();
  });

  test("maxDeepFrontiers = 0 is rejected (below minimum)", () => {
    expect(() => sigeAutoConfigSchema.parse({ maxDeepFrontiers: 0 })).toThrow();
  });

  test("broadPoolSize=1 is valid (minimum)", () => {
    const result = sigeAutoConfigSchema.parse({ broadPoolSize: 1 });
    expect(result.broadPoolSize).toBe(1);
  });

  test("broadPoolSize=200 is valid (maximum)", () => {
    const result = sigeAutoConfigSchema.parse({ broadPoolSize: 200 });
    expect(result.broadPoolSize).toBe(200);
  });

  test("broadPoolSize > 200 is rejected", () => {
    expect(() => sigeAutoConfigSchema.parse({ broadPoolSize: 201 })).toThrow();
  });

  test("broadPoolSize = 0 is rejected (below minimum)", () => {
    expect(() => sigeAutoConfigSchema.parse({ broadPoolSize: 0 })).toThrow();
  });

  test("cadence='daily' is valid", () => {
    const result = sigeAutoConfigSchema.parse({ cadence: "daily" });
    expect(result.cadence).toBe("daily");
  });

  test("cadence='manual' is valid", () => {
    const result = sigeAutoConfigSchema.parse({ cadence: "manual" });
    expect(result.cadence).toBe("manual");
  });

  test("unknown cadence value is rejected", () => {
    expect(() => sigeAutoConfigSchema.parse({ cadence: "hourly" })).toThrow();
    expect(() => sigeAutoConfigSchema.parse({ cadence: "weekly" })).toThrow();
  });

  test("maxConcurrent=1 is valid (only valid value per schema)", () => {
    const result = sigeAutoConfigSchema.parse({ maxConcurrent: 1 });
    expect(result.maxConcurrent).toBe(1);
  });

  test("maxConcurrent > 1 is rejected (schema hard-caps at 1)", () => {
    expect(() => sigeAutoConfigSchema.parse({ maxConcurrent: 2 })).toThrow();
  });

  test("memoryWriteback=true parses correctly", () => {
    const result = sigeAutoConfigSchema.parse({ memoryWriteback: true });
    expect(result.memoryWriteback).toBe(true);
  });

  test("perRunCostCeilingUsd=0 is valid (no ceiling)", () => {
    const result = sigeAutoConfigSchema.parse({ perRunCostCeilingUsd: 0 });
    expect(result.perRunCostCeilingUsd).toBe(0);
  });

  test("perRunCostCeilingUsd=5.5 is valid (positive ceiling)", () => {
    const result = sigeAutoConfigSchema.parse({ perRunCostCeilingUsd: 5.5 });
    expect(result.perRunCostCeilingUsd).toBe(5.5);
  });

  test("perRunCostCeilingUsd < 0 is rejected", () => {
    expect(() => sigeAutoConfigSchema.parse({ perRunCostCeilingUsd: -1 })).toThrow();
  });

  test("full valid config object parses correctly", () => {
    const result = sigeAutoConfigSchema.parse({
      enabled: true,
      maxDeepFrontiers: 2,
      broadPoolSize: 100,
      cadence: "manual",
      maxConcurrent: 1,
      memoryWriteback: true,
      perRunCostCeilingUsd: 2.5,
    });
    expect(result.enabled).toBe(true);
    expect(result.maxDeepFrontiers).toBe(2);
    expect(result.broadPoolSize).toBe(100);
    expect(result.cadence).toBe("manual");
    expect(result.memoryWriteback).toBe(true);
    expect(result.perRunCostCeilingUsd).toBe(2.5);
  });
});

// ── appstoreKeywordGap config ─────────────────────────────────────────────────

describe("appstoreKeywordGap config", () => {
  test("empty config parses with the feature ON by default", () => {
    const cfg = opencrowConfigSchema.parse({});
    const g = cfg.appstoreKeywordGap;
    expect(g.enabled).toBe(true);
    expect(g.topN).toBe(20);
    expect(g.scanIntervalMs).toBe(60_000);
    // Max-throughput pass (2026-07-22): the real per-sweep governors
    // (keywordsPerSweep/sweepDelayMs), not just the safety ceilings — see
    // src/config/schema.ts's "MAX-THROUGHPUT PASS" comment on
    // appstoreKeywordGapConfigSchema for the full before/after math.
    expect(g.sweepDelayMs).toBe(150);
    expect(g.dailyKeywordBudget).toBe(150_000);
    expect(g.keywordsPerSweep).toBe(600);
    expect(g.useProxy).toBe(false);
    expect(g.minedExploration.dailyQuota).toBe(100_000);
    expect(g.demandWeight).toBe(1);
    expect(g.opportunityThresholdForSeed).toBe(0.15);
    // ASA popularity manual-import veto (batch E) — OFF by default.
    expect(g.excludeKnownZeroVolume).toBe(false);
    expect(g.zeroVolumeThreshold).toBe(1);
    expect(g.zeroVolumeFreshnessDays).toBe(45);
    expect(g.corpusDiscovery.enabled).toBe(true);
    expect(g.corpusDiscovery.maxMinedPerCycle).toBe(100);
    expect(g.autocompleteExpansion.enabled).toBe(true);
    // Throughput wave (2026-07-21, item 3): breadth raised 25 -> 60 total
    // seeds/pass, cadence slowed 15min -> 1h to compensate — see
    // src/config/schema.ts's budget-table comment on
    // appstoreAppEnrichmentConfigSchema.
    expect(g.autocompleteExpansion.minIntervalMs).toBe(3_600_000);
    expect(g.autocompleteExpansion.winnerLimit).toBe(36);
    expect(g.autocompleteExpansion.diverseLimit).toBe(24);
    expect(g.autocompleteExpansion.perSeed).toBe(8);
    expect(g.autocompleteExpansion.delayMs).toBe(1000);
    expect(g.autocompleteExpansion.storefront).toBe("143441-1,29");
    expect(g.autocompleteExpansion.useProxy).toBe(false);
    expect(g.autocompleteExpansion.gbLane.enabled).toBe(true);
    expect(g.autocompleteExpansion.gbLane.storefront).toBe("143444-1,29");
    expect(g.autocompleteExpansion.gbLane.winnerLimit).toBe(15);
    expect(g.autocompleteExpansion.gbLane.diverseLimit).toBe(10);
    expect(g.sweepRateSafety.adaptiveThrottleEnabled).toBe(true);
    expect(g.sweepRateSafety.legacyRateOverride).toBe(false);
    // AIMD tuning knobs (continuous-fetch retune, 2026-07-23) — see
    // sweep-throttle.ts's advanceThrottle.
    expect(g.sweepRateSafety.throttleBackoffFactor).toBe(0.5);
    expect(g.sweepRateSafety.throttleRecoveryStep).toBe(0.25);
    // serp-rank Stage 1 (deep-scrape build).
    expect(g.serpDepth).toBe(200);
    expect(g.deepScanMined).toBe(false);
    expect(cfg.appstoreVelocity.maxRankRecorded).toBe(200);
  });

  test("is tunable via config", () => {
    const cfg = opencrowConfigSchema.parse({
      appstoreKeywordGap: {
        enabled: true,
        topN: 10,
        corpusDiscovery: { enabled: true, maxMinedPerCycle: 10 },
        autocompleteExpansion: { enabled: true, winnerLimit: 5, storefront: "143441-1,17" },
      },
    });
    expect(cfg.appstoreKeywordGap.enabled).toBe(true);
    expect(cfg.appstoreKeywordGap.topN).toBe(10);
    expect(cfg.appstoreKeywordGap.corpusDiscovery.enabled).toBe(true);
    expect(cfg.appstoreKeywordGap.corpusDiscovery.maxMinedPerCycle).toBe(10);
    expect(cfg.appstoreKeywordGap.autocompleteExpansion.winnerLimit).toBe(5);
    expect(cfg.appstoreKeywordGap.autocompleteExpansion.storefront).toBe("143441-1,17");
    // Untouched sibling fields keep their defaults.
    expect(cfg.appstoreKeywordGap.autocompleteExpansion.diverseLimit).toBe(24);
  });

  test("can be disabled via config", () => {
    const cfg = opencrowConfigSchema.parse({
      appstoreKeywordGap: {
        enabled: false,
        corpusDiscovery: { enabled: false },
        autocompleteExpansion: { enabled: false },
      },
    });
    expect(cfg.appstoreKeywordGap.enabled).toBe(false);
    expect(cfg.appstoreKeywordGap.corpusDiscovery.enabled).toBe(false);
    expect(cfg.appstoreKeywordGap.autocompleteExpansion.enabled).toBe(false);
  });
});

// ── appstoreAppEnrichment / appstoreNewbornReobservation useProxy ──────────────
// Max-throughput pass (2026-07-22): these were the last two appstore lanes
// still direct-IP by default; flipped ON for consistency with the
// keyword-scan/mined/DE-storefront/review-harvest/app-pages lanes, all of
// which already rode the paid Webshare rotating proxy.

describe("appstoreAppEnrichment config useProxy", () => {
  test("defaults to true (max-throughput pass, 2026-07-22)", () => {
    const cfg = opencrowConfigSchema.parse({});
    expect(cfg.appstoreAppEnrichment.useProxy).toBe(false);
  });
});

describe("appstoreNewbornReobservation config useProxy", () => {
  test("defaults to true (max-throughput pass, 2026-07-22)", () => {
    const cfg = opencrowConfigSchema.parse({});
    expect(cfg.appstoreNewbornReobservation.useProxy).toBe(false);
  });
});

// ── appstoreSync config ───────────────────────────────────────────────────────

describe("appstoreSync config", () => {
  test("empty config parses with aggressive defaults", () => {
    const cfg = opencrowConfigSchema.parse({});
    const s = cfg.appstoreSync;
    expect(s.perCategoryLimit).toBe(200);
    expect(s.listTypes).toEqual(["top-free", "top-paid", "top-grossing"]);
    expect(s.globalLimit).toBe(100);
  });

  test("is tunable via config", () => {
    const cfg = opencrowConfigSchema.parse({
      appstoreSync: {
        perCategoryLimit: 50,
        listTypes: ["top-free"],
        globalLimit: 50,
      },
    });
    expect(cfg.appstoreSync.perCategoryLimit).toBe(50);
    expect(cfg.appstoreSync.listTypes).toEqual(["top-free"]);
    expect(cfg.appstoreSync.globalLimit).toBe(50);
  });

  test("rejects a globalLimit above 100 (Apple marketing-tools API 500s above that)", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        appstoreSync: { globalLimit: 200 },
      }),
    ).toThrow();
  });

  test("rejects an unknown list type", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        appstoreSync: { listTypes: ["top-free", "bogus"] },
      }),
    ).toThrow();
  });

  test("rejects an empty listTypes array", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        appstoreSync: { listTypes: [] },
      }),
    ).toThrow();
  });

  // ── intlCharts (deep-scrape build Stage 3) ───────────────────────────────
  describe("intlCharts", () => {
    test("defaults to enabled, gb/ca/au, 12h cadence", () => {
      const cfg = opencrowConfigSchema.parse({});
      const ic = cfg.appstoreSync.intlCharts;
      expect(ic.enabled).toBe(true);
      expect(ic.storefronts).toEqual(["gb", "ca", "au"]);
      expect(ic.minIntervalMs).toBe(12 * 60 * 60 * 1000);
      expect(ic.listTypes).toEqual(["top-free", "top-paid", "top-grossing"]);
      expect(ic.delayMs).toBe(1000);
    });

    test("is tunable via config", () => {
      const cfg = opencrowConfigSchema.parse({
        appstoreSync: {
          intlCharts: {
            enabled: false,
            storefronts: ["de", "fr"],
            minIntervalMs: 3_600_000,
            listTypes: ["top-free"],
            delayMs: 500,
          },
        },
      });
      const ic = cfg.appstoreSync.intlCharts;
      expect(ic.enabled).toBe(false);
      expect(ic.storefronts).toEqual(["de", "fr"]);
      expect(ic.minIntervalMs).toBe(3_600_000);
      expect(ic.listTypes).toEqual(["top-free"]);
      expect(ic.delayMs).toBe(500);
    });

    test("has NO firstSeen block (build plan §0.1 — the metadata registry owns first-seen)", () => {
      const cfg = opencrowConfigSchema.parse({});
      expect((cfg.appstoreSync.intlCharts as Record<string, unknown>).firstSeen).toBeUndefined();
    });

    test("rejects a storefront code that isn't 2 characters", () => {
      expect(() =>
        opencrowConfigSchema.parse({
          appstoreSync: { intlCharts: { storefronts: ["usa"] } },
        }),
      ).toThrow();
    });

    test("rejects an empty storefronts array", () => {
      expect(() =>
        opencrowConfigSchema.parse({
          appstoreSync: { intlCharts: { storefronts: [] } },
        }),
      ).toThrow();
    });

    test("rejects an unknown list type", () => {
      expect(() =>
        opencrowConfigSchema.parse({
          appstoreSync: { intlCharts: { listTypes: ["bogus"] } },
        }),
      ).toThrow();
    });
  });
});

// ── appstoreReviewHarvest config (deep-scrape build Stage 4) ───────────────

describe("appstoreReviewHarvest config", () => {
  test("defaults: enabled, 60s minIntervalMs, budget 30,000, low-star-only indexing", () => {
    const cfg = opencrowConfigSchema.parse({});
    const rh = cfg.appstoreReviewHarvest;
    expect(rh.enabled).toBe(true);
    expect(rh.minIntervalMs).toBe(60_000);
    expect(rh.appsPerTick).toBe(3);
    expect(rh.storefront).toBe("us");
    expect(rh.pageDelayMs).toBe(500);
    expect(rh.maxConsecutiveEmptyHarvests).toBe(5);
    expect(rh.memoryIndexing).toBe("low-star-only");
    // Throughput wave (2026-07-21, item 4): raised 10,000 -> 15,000 — this
    // lane runs at its cap in practice, so raising it directly unlocks more
    // review coverage. Capacity-raise escalation (2026-07-21, post PR #328):
    // raised again 15,000 -> 30,000 and `useProxy` flipped OFF -> ON (this
    // lane runs at its cap, so the extra volume needed rotating IPs, not
    // just a bigger number). See the budget-table comment on
    // appstoreAppEnrichmentConfigSchema.
    expect(rh.dailyRequestBudget).toBe(30_000);
    expect(rh.useProxy).toBe(false);
  });

  test("has NO tickIntervalMs — replaced by minIntervalMs (build plan §0.2/§0.4: no new timer)", () => {
    const cfg = opencrowConfigSchema.parse({});
    expect((cfg.appstoreReviewHarvest as Record<string, unknown>).tickIntervalMs).toBeUndefined();
  });

  test("cohortRefresh defaults: enabled, 6h cadence, candidate caps", () => {
    const cfg = opencrowConfigSchema.parse({});
    const cr = cfg.appstoreReviewHarvest.cohortRefresh;
    expect(cr.enabled).toBe(true);
    expect(cr.minIntervalMs).toBe(6 * 60 * 60 * 1000);
    expect(cr.signatureHitCap).toBe(100);
    expect(cr.velocityCap).toBe(50);
    expect(cr.chartNewbornCap).toBe(200);
  });

  test("ledgerPrune defaults: 7d max age, 24h cadence", () => {
    const cfg = opencrowConfigSchema.parse({});
    const lp = cfg.appstoreReviewHarvest.ledgerPrune;
    expect(lp.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(lp.minIntervalMs).toBe(24 * 60 * 60 * 1000);
  });

  test("is tunable via config", () => {
    const cfg = opencrowConfigSchema.parse({
      appstoreReviewHarvest: {
        enabled: false,
        minIntervalMs: 30_000,
        appsPerTick: 10,
        storefront: "gb",
        pageDelayMs: 200,
        maxConsecutiveEmptyHarvests: 3,
        memoryIndexing: "all",
        dailyRequestBudget: 5_000,
        cohortRefresh: { signatureHitCap: 20 },
        ledgerPrune: { maxAgeMs: 3600_000 },
      },
    });
    const rh = cfg.appstoreReviewHarvest;
    expect(rh.enabled).toBe(false);
    expect(rh.minIntervalMs).toBe(30_000);
    expect(rh.appsPerTick).toBe(10);
    expect(rh.storefront).toBe("gb");
    expect(rh.pageDelayMs).toBe(200);
    expect(rh.maxConsecutiveEmptyHarvests).toBe(3);
    expect(rh.memoryIndexing).toBe("all");
    expect(rh.dailyRequestBudget).toBe(5_000);
    expect(rh.cohortRefresh.signatureHitCap).toBe(20);
    expect(rh.ledgerPrune.maxAgeMs).toBe(3600_000);
  });

  test("rejects a storefront code that isn't 2 characters", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        appstoreReviewHarvest: { storefront: "usa" },
      }),
    ).toThrow();
  });

  test("rejects an unknown memoryIndexing value", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        appstoreReviewHarvest: { memoryIndexing: "bogus" },
      }),
    ).toThrow();
  });

  test("rejects a negative appsPerTick", () => {
    expect(() =>
      opencrowConfigSchema.parse({
        appstoreReviewHarvest: { appsPerTick: -1 },
      }),
    ).toThrow();
  });
});
