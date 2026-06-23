/**
 * Declarative field-spec map for config-as-data introspection + seeding.
 *
 * This is the SINGLE SOURCE OF TRUTH shared by:
 *   - src/web/routes/config-introspect.ts  (GET /api/config/effective)
 *   - src/config/seed-overrides.ts          (seedOverridesFromEnv)
 *
 * Each spec ties together three coordinates the rest of the system already
 * agrees on:
 *   - `path`        — dotted path INTO the parsed OpenCrowConfig object (what the
 *                     app actually reads); used to surface the effective value.
 *   - `envVars`     — the env var(s) that populate `path` via applyEnvOverrides
 *                     in src/config/loader.ts. First present one is the seed
 *                     source. Empty array = no env input (schema-default only).
 *   - `overrideKey` — the "namespace/key" config_overrides row that drives the
 *                     SUBTREE this field lives in (per the CONFIG-AS-DATA scheme),
 *                     or null if the field is not (yet) DB-driven.
 *   - `subKey`      — the key INSIDE the override JSON object that maps to this
 *                     field (the scheme's partial-object shape). Used by the
 *                     seeder to build the partial override payload.
 *   - `parse`       — coerces a raw env string into the typed value the override
 *                     JSON should store (number/boolean/string/list).
 *
 * The map intentionally mirrors the merge handlers in loader.ts field-for-field
 * so introspection and seeding never drift from what the loader honors.
 */

export type EnvParse = "string" | "number" | "boolean" | "csv-string" | "csv-number";

export interface ConfigFieldSpec {
  /** Dotted path into the parsed OpenCrowConfig. */
  readonly path: string;
  /** Env var(s) that populate this field (precedence: first present wins). */
  readonly envVars: readonly string[];
  /** "namespace/key" config_overrides row driving this field's subtree, or null. */
  readonly overrideKey: string | null;
  /** Key inside the override JSON object for this field (scheme partial shape). */
  readonly subKey: string | null;
  /** How to coerce the raw env string into the stored override value. */
  readonly parse: EnvParse;
}

export interface ConfigDomainSpec {
  readonly domain: string;
  readonly fields: readonly ConfigFieldSpec[];
}

const f = (
  path: string,
  envVars: readonly string[],
  overrideKey: string | null,
  subKey: string | null,
  parse: EnvParse = "string",
): ConfigFieldSpec => ({ path, envVars, overrideKey, subKey, parse });

export const CONFIG_FIELD_SPECS: readonly ConfigDomainSpec[] = [
  {
    domain: "server",
    fields: [
      f("web.host", ["OPENCROW_WEB_HOST"], "config/server", "webHost"),
      f("web.port", ["OPENCROW_WEB_PORT"], "config/server", "webPort", "number"),
      f("logLevel", ["LOG_LEVEL"], "config/server", "logLevel"),
      f(
        "browser.enabled",
        ["OPENCROW_BROWSER_ENABLED"],
        "config/server",
        "browserEnabled",
        "boolean",
      ),
    ],
  },
  {
    domain: "sandbox",
    fields: [
      f("tools.sandbox", ["OPENCROW_TOOLS_SANDBOX"], "config/sandbox", "toolsSandbox"),
      f(
        "tools.devToolsAllowNetwork",
        ["OPENCROW_DEV_TOOLS_ALLOW_NETWORK"],
        "config/sandbox",
        "devToolsAllowNetwork",
        "boolean",
      ),
      f(
        "tools.allowUnsandboxedDevTools",
        ["OPENCROW_ALLOW_UNSANDBOXED_DEV_TOOLS"],
        "config/sandbox",
        "allowUnsandboxedDevTools",
        "boolean",
      ),
    ],
  },
  {
    domain: "memory",
    fields: [f("memorySearch.backend", ["OPENCROW_MEMORY_BACKEND"], "config/memory", "backend")],
  },
  {
    domain: "sige",
    fields: [
      f("sige.enabled", ["OPENCROW_SIGE_ENABLED"], "config/sige", "enabled", "boolean"),
      f("sige.mem0.baseUrl", ["OPENCROW_SIGE_MEM0_URL"], "config/sige", "mem0.baseUrl"),
      f(
        "sige.neo4j.enabled",
        ["OPENCROW_SIGE_NEO4J_ENABLED"],
        "config/sige",
        "neo4j.enabled",
        "boolean",
      ),
      f("sige.neo4j.boltUrl", ["OPENCROW_SIGE_NEO4J_URL"], "config/sige", "neo4j.boltUrl"),
      f("sige.neo4j.user", ["OPENCROW_SIGE_NEO4J_USER"], "config/sige", "neo4j.user"),
    ],
  },
  {
    domain: "smart.signal",
    fields: [
      f(
        "pipelines.ideas.smart.signalFacets",
        ["OPENCROW_SMART_SIGNAL_FACETS"],
        "config/smart.signal",
        "facets",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.signalRanking",
        ["OPENCROW_SMART_SIGNAL_RANKING"],
        "config/smart.signal",
        "ranking",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.signalImportanceFloor",
        ["OPENCROW_SMART_SIGNAL_IMPORTANCE_FLOOR"],
        "config/smart.signal",
        "importanceFloor",
      ),
    ],
  },
  {
    domain: "smart.sigeAuto",
    fields: [
      f(
        "pipelines.ideas.smart.sigeAuto.enabled",
        ["OPENCROW_SMART_SIGE_AUTO_ENABLED"],
        "config/smart.sigeAuto",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.sigeAuto.cadence",
        ["OPENCROW_SMART_SIGE_AUTO_CADENCE"],
        "config/smart.sigeAuto",
        "cadence",
      ),
      f(
        "pipelines.ideas.smart.sigeAuto.maxDeepFrontiers",
        ["OPENCROW_SMART_SIGE_AUTO_MAX_DEEP_FRONTIERS"],
        "config/smart.sigeAuto",
        "maxDeepFrontiers",
        "number",
      ),
      f(
        "pipelines.ideas.smart.sigeAuto.broadPoolSize",
        ["OPENCROW_SMART_SIGE_AUTO_BROAD_POOL_SIZE"],
        "config/smart.sigeAuto",
        "broadPoolSize",
        "number",
      ),
      f(
        "pipelines.ideas.smart.sigeAuto.maxConcurrent",
        ["OPENCROW_SMART_SIGE_AUTO_MAX_CONCURRENT"],
        "config/smart.sigeAuto",
        "maxConcurrent",
        "number",
      ),
      f(
        "pipelines.ideas.smart.sigeAuto.memoryWriteback",
        ["OPENCROW_SMART_SIGE_AUTO_MEMORY_WRITEBACK"],
        "config/smart.sigeAuto",
        "memoryWriteback",
        "boolean",
      ),
    ],
  },
  {
    domain: "smart.outcomeMemory",
    fields: [
      f(
        "pipelines.ideas.smart.outcomeMemory.writeBack",
        ["OPENCROW_SMART_OUTCOME_MEMORY_WRITEBACK"],
        "config/smart.outcomeMemory",
        "writeback",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.readAtSynthesis",
        ["OPENCROW_SMART_OUTCOME_MEMORY_READ_AT_SYNTHESIS"],
        "config/smart.outcomeMemory",
        "readAtSynthesis",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.reinforceCap",
        ["OPENCROW_SMART_OUTCOME_MEMORY_REINFORCE_CAP"],
        "config/smart.outcomeMemory",
        "reinforceCap",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.avoidCap",
        ["OPENCROW_SMART_OUTCOME_MEMORY_AVOID_CAP"],
        "config/smart.outcomeMemory",
        "avoidCap",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.searchLimit",
        ["OPENCROW_SMART_OUTCOME_MEMORY_SEARCH_LIMIT"],
        "config/smart.outcomeMemory",
        "searchLimit",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.halfLifeDays",
        ["OPENCROW_SMART_OUTCOME_MEMORY_HALF_LIFE_DAYS"],
        "config/smart.outcomeMemory",
        "halfLifeDays",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.stalePromptPenalty",
        ["OPENCROW_SMART_OUTCOME_MEMORY_STALE_PROMPT_PENALTY"],
        "config/smart.outcomeMemory",
        "stalePromptPenalty",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.mmrLambda",
        ["OPENCROW_SMART_OUTCOME_MEMORY_MMR_LAMBDA"],
        "config/smart.outcomeMemory",
        "mmrLambda",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.supersedePriorOnRerun",
        ["OPENCROW_SMART_OUTCOME_MEMORY_SUPERSEDE_PRIOR_ON_RERUN"],
        "config/smart.outcomeMemory",
        "supersedePriorOnRerun",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.writePendingMemories",
        ["OPENCROW_SMART_OUTCOME_MEMORY_WRITE_PENDING_MEMORIES"],
        "config/smart.outcomeMemory",
        "writePendingMemories",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.trustWeighting",
        ["OPENCROW_SMART_OUTCOME_MEMORY_TRUST_WEIGHTING"],
        "config/smart.outcomeMemory",
        "trustWeighting",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.proxyAvoidCap",
        ["OPENCROW_SMART_OUTCOME_MEMORY_PROXY_AVOID_CAP"],
        "config/smart.outcomeMemory",
        "proxyAvoidCap",
        "number",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.reprobe.enabled",
        ["OPENCROW_SMART_OUTCOME_MEMORY_REPROBE_ENABLED"],
        "config/smart.outcomeMemory",
        "reprobe.enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.outcomeMemory.reprobe.delayDays",
        ["OPENCROW_SMART_OUTCOME_MEMORY_REPROBE_DELAY_DAYS"],
        "config/smart.outcomeMemory",
        "reprobe.delayDays",
        "number",
      ),
    ],
  },
  {
    domain: "smart.graphReasoning",
    fields: [
      f(
        "pipelines.ideas.smart.graphReasoning.enabled",
        ["OPENCROW_SMART_GRAPH_REASONING_ENABLED"],
        "config/smart.graphReasoning",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.maxHops",
        ["OPENCROW_SMART_GRAPH_REASONING_MAX_HOPS"],
        "config/smart.graphReasoning",
        "maxHops",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.maxPaths",
        ["OPENCROW_SMART_GRAPH_REASONING_MAX_PATHS"],
        "config/smart.graphReasoning",
        "maxPaths",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.searchLimit",
        ["OPENCROW_SMART_GRAPH_REASONING_SEARCH_LIMIT"],
        "config/smart.graphReasoning",
        "searchLimit",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.minDegree",
        ["OPENCROW_SMART_GRAPH_REASONING_MIN_DEGREE"],
        "config/smart.graphReasoning",
        "minDegree",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.maxDegree",
        ["OPENCROW_SMART_GRAPH_REASONING_MAX_DEGREE"],
        "config/smart.graphReasoning",
        "maxDegree",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.neutralWeight",
        ["OPENCROW_SMART_GRAPH_REASONING_NEUTRAL_WEIGHT"],
        "config/smart.graphReasoning",
        "neutralWeight",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphReasoning.noveltyHalfLifeRuns",
        ["OPENCROW_SMART_GRAPH_REASONING_NOVELTY_HALF_LIFE_RUNS"],
        "config/smart.graphReasoning",
        "noveltyHalfLifeRuns",
        "number",
      ),
    ],
  },
  {
    domain: "smart.graphFeedback",
    fields: [
      f(
        "pipelines.ideas.smart.graphFeedback.enabled",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_ENABLED"],
        "config/smart.graphFeedback",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.validatedWeight",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_VALIDATED_WEIGHT"],
        "config/smart.graphFeedback",
        "validatedWeight",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.killedWeight",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_KILLED_WEIGHT"],
        "config/smart.graphFeedback",
        "killedWeight",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.weightHalfLifeDays",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_WEIGHT_HALF_LIFE_DAYS"],
        "config/smart.graphFeedback",
        "weightHalfLifeDays",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.maxSeedWeight",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_MAX_SEED_WEIGHT"],
        "config/smart.graphFeedback",
        "maxSeedWeight",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.projectToNeo4j",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_PROJECT_TO_NEO4J"],
        "config/smart.graphFeedback",
        "projectToNeo4j",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.anchorRetentionDays",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_ANCHOR_RETENTION_DAYS"],
        "config/smart.graphFeedback",
        "anchorRetentionDays",
        "number",
      ),
      f(
        "pipelines.ideas.smart.graphFeedback.pruneTickIntervalMs",
        ["OPENCROW_SMART_GRAPH_FEEDBACK_PRUNE_TICK_INTERVAL_MS"],
        "config/smart.graphFeedback",
        "pruneTickIntervalMs",
        "number",
      ),
    ],
  },
  {
    domain: "smart.abHoldout",
    fields: [
      f(
        "pipelines.ideas.smart.abHoldout.enabled",
        ["OPENCROW_SMART_AB_HOLDOUT_ENABLED"],
        "config/smart.abHoldout",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.abHoldout.holdoutRatio",
        ["OPENCROW_SMART_AB_HOLDOUT_RATIO"],
        "config/smart.abHoldout",
        "holdoutRatio",
        "number",
      ),
    ],
  },
  {
    domain: "smart.incumbentExclusion",
    fields: [
      f(
        "pipelines.ideas.smart.incumbentExclusion.enabled",
        ["OPENCROW_SMART_INCUMBENT_EXCLUSION_ENABLED"],
        "config/smart.incumbentExclusion",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.incumbentExclusion.topN",
        ["OPENCROW_SMART_INCUMBENT_EXCLUSION_TOP_N"],
        "config/smart.incumbentExclusion",
        "topN",
        "number",
      ),
    ],
  },
  {
    domain: "smart.diversityGuard",
    fields: [
      f(
        "pipelines.ideas.smart.diversityGuard.enabled",
        ["OPENCROW_SMART_DIVERSITY_GUARD_ENABLED"],
        "config/smart.diversityGuard",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.diversityGuard.maxBucketShare",
        ["OPENCROW_SMART_DIVERSITY_GUARD_MAX_BUCKET_SHARE"],
        "config/smart.diversityGuard",
        "maxBucketShare",
        "number",
      ),
      f(
        "pipelines.ideas.smart.diversityGuard.bucketBy",
        ["OPENCROW_SMART_DIVERSITY_GUARD_BUCKET_BY"],
        "config/smart.diversityGuard",
        "bucketBy",
      ),
    ],
  },
  {
    domain: "smart.competability",
    fields: [
      f(
        "pipelines.ideas.smart.competability.enabled",
        ["OPENCROW_SMART_COMPETABILITY_ENABLED"],
        "config/competability",
        "enabled",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.competability.enforceGate",
        ["OPENCROW_SMART_COMPETABILITY_ENFORCE_GATE"],
        "config/competability",
        "enforceGate",
        "boolean",
      ),
      f(
        "pipelines.ideas.smart.competability.rejectThreshold",
        ["OPENCROW_SMART_COMPETABILITY_REJECT_THRESHOLD"],
        "config/competability",
        "rejectThreshold",
        "number",
      ),
      f(
        "pipelines.ideas.smart.competability.softPenaltyThreshold",
        ["OPENCROW_SMART_COMPETABILITY_SOFT_PENALTY_THRESHOLD"],
        "config/competability",
        "softPenaltyThreshold",
        "number",
      ),
      f(
        "pipelines.ideas.smart.competability.topNIncumbents",
        ["OPENCROW_SMART_COMPETABILITY_TOP_N_INCUMBENTS"],
        "config/competability",
        "topNIncumbents",
        "number",
      ),
      f(
        "pipelines.ideas.smart.competability.builderProfile.capital",
        ["OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL"],
        "config/competability",
        "builderProfile.capital",
      ),
      f(
        "pipelines.ideas.smart.competability.builderProfile.teamSize",
        ["OPENCROW_SMART_COMPETABILITY_BUILDER_TEAM_SIZE"],
        "config/competability",
        "builderProfile.teamSize",
        "number",
      ),
      f(
        "pipelines.ideas.smart.competability.builderProfile.regulatoryAppetite",
        ["OPENCROW_SMART_COMPETABILITY_BUILDER_REGULATORY_APPETITE"],
        "config/competability",
        "builderProfile.regulatoryAppetite",
      ),
      f(
        "pipelines.ideas.smart.competability.builderProfile.opsAppetite",
        ["OPENCROW_SMART_COMPETABILITY_BUILDER_OPS_APPETITE"],
        "config/competability",
        "builderProfile.opsAppetite",
      ),
      f(
        "pipelines.ideas.smart.competability.builderProfile.expertiseDomains",
        ["OPENCROW_SMART_COMPETABILITY_BUILDER_EXPERTISE_DOMAINS"],
        "config/competability",
        "builderProfile.expertiseDomains",
        "csv-string",
      ),
    ],
  },
  {
    domain: "embeddings",
    fields: [
      f("embeddings.provider", ["OPENCROW_EMBEDDINGS_PROVIDER"], "features/embeddings", "provider"),
      f("embeddings.baseUrl", ["OPENCROW_EMBEDDINGS_BASE_URL"], "features/embeddings", "baseUrl"),
      f("embeddings.model", ["OPENCROW_EMBEDDINGS_MODEL"], "features/embeddings", "model"),
      f(
        "embeddings.dimensions",
        ["OPENCROW_EMBEDDINGS_DIMENSIONS"],
        "features/embeddings",
        "dimensions",
        "number",
      ),
    ],
  },
];
