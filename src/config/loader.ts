import { opencrowConfigSchema, agentDefinitionSchema, type OpenCrowConfig } from "./schema";
import { getAllOverrides, getOverride, type ConfigOverride } from "../store/config-overrides";
import { getAgentOverrides, type AgentOverride } from "../store/agent-overrides";
import type { AgentDefinition } from "../agents/types";

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };

  // --- channels.telegram ---
  const channels = (result.channels ?? {}) as Record<string, unknown>;
  let telegram = { ...((channels.telegram ?? {}) as Record<string, unknown>) };

  if (process.env.TELEGRAM_BOT_TOKEN) {
    telegram = {
      ...telegram,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    };
  }

  if (process.env.TELEGRAM_ALLOWED_USER_IDS) {
    const ids = process.env.TELEGRAM_ALLOWED_USER_IDS.split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => !Number.isNaN(id));
    telegram = { ...telegram, allowedUserIds: ids };
  }

  result.channels = { ...channels, telegram };

  // --- web ---
  const web = { ...((result.web ?? {}) as Record<string, unknown>) };
  if (process.env.OPENCROW_WEB_HOST) {
    web.host = process.env.OPENCROW_WEB_HOST;
  }
  if (process.env.OPENCROW_WEB_PORT) {
    web.port = Number(process.env.OPENCROW_WEB_PORT);
  }
  result.web = web;

  // --- postgres ---
  if (process.env.DATABASE_URL) {
    const postgres = {
      ...((result.postgres ?? {}) as Record<string, unknown>),
    };
    postgres.url = process.env.DATABASE_URL;
    result.postgres = postgres;
  }

  // --- logLevel ---
  if (process.env.LOG_LEVEL) {
    result.logLevel = process.env.LOG_LEVEL;
  }

  // --- browser ---
  if (process.env.OPENCROW_BROWSER_ENABLED === "true") {
    const existing = (result.browser ?? {}) as Record<string, unknown>;
    result.browser = { ...existing, enabled: true };
  }

  // --- embeddings ---
  const embeddings = {
    ...((result.embeddings ?? {}) as Record<string, unknown>),
  };
  let embeddingsChanged = false;
  if (process.env.OPENCROW_EMBEDDINGS_PROVIDER) {
    embeddings.provider = process.env.OPENCROW_EMBEDDINGS_PROVIDER;
    embeddingsChanged = true;
  }
  if (process.env.OPENCROW_EMBEDDINGS_BASE_URL) {
    embeddings.baseUrl = process.env.OPENCROW_EMBEDDINGS_BASE_URL;
    embeddingsChanged = true;
  }
  if (process.env.OPENCROW_EMBEDDINGS_MODEL) {
    embeddings.model = process.env.OPENCROW_EMBEDDINGS_MODEL;
    embeddingsChanged = true;
  }
  if (process.env.OPENCROW_EMBEDDINGS_DIMENSIONS) {
    const dims = Number(process.env.OPENCROW_EMBEDDINGS_DIMENSIONS);
    if (!Number.isNaN(dims)) {
      embeddings.dimensions = dims;
      embeddingsChanged = true;
    }
  }
  if (embeddingsChanged) {
    result.embeddings = embeddings;
  }

  // --- memorySearch.backend ---
  // Selects the memory storage backend (qdrant | mem0). When set, ensure the
  // memorySearch block exists so the override has somewhere to land; the schema
  // fills the rest of the block with its defaults.
  if (process.env.OPENCROW_MEMORY_BACKEND) {
    const memorySearch = {
      ...((result.memorySearch ?? {}) as Record<string, unknown>),
    };
    memorySearch.backend = process.env.OPENCROW_MEMORY_BACKEND;
    result.memorySearch = memorySearch;
  }

  // --- pipelines.ideas.smart (env toggles for the smart-pipeline feature flags) ---
  const smartEnv: Record<string, unknown> = {};
  const boolEnv = (name: string): boolean | undefined => {
    const v = process.env[name];
    if (v === undefined) return undefined;
    return v === "true" || v === "1";
  };
  const smartFacets = boolEnv("OPENCROW_SMART_SIGNAL_FACETS");
  if (smartFacets !== undefined) smartEnv.signalFacets = smartFacets;
  const smartRanking = boolEnv("OPENCROW_SMART_SIGNAL_RANKING");
  if (smartRanking !== undefined) smartEnv.signalRanking = smartRanking;
  if (process.env.OPENCROW_SMART_SIGNAL_IMPORTANCE_FLOOR) {
    smartEnv.signalImportanceFloor = process.env.OPENCROW_SMART_SIGNAL_IMPORTANCE_FLOOR;
  }
  // OPENCROW_SMART_SIGE_AUTO_* overrides for the autonomous SIGE feature block.
  const sigeAutoEnv: Record<string, unknown> = {};
  const sigeAutoEnabled = boolEnv("OPENCROW_SMART_SIGE_AUTO_ENABLED");
  if (sigeAutoEnabled !== undefined) sigeAutoEnv.enabled = sigeAutoEnabled;
  const sigeAutoMaxDeepFrontiers = Number(
    process.env.OPENCROW_SMART_SIGE_AUTO_MAX_DEEP_FRONTIERS ?? "",
  );
  if (
    !Number.isNaN(sigeAutoMaxDeepFrontiers) &&
    process.env.OPENCROW_SMART_SIGE_AUTO_MAX_DEEP_FRONTIERS !== undefined
  ) {
    sigeAutoEnv.maxDeepFrontiers = sigeAutoMaxDeepFrontiers;
  }
  const sigeAutoBroadFrontierCap = Number(
    process.env.OPENCROW_SMART_SIGE_AUTO_BROAD_FRONTIER_CAP ?? "",
  );
  if (
    !Number.isNaN(sigeAutoBroadFrontierCap) &&
    process.env.OPENCROW_SMART_SIGE_AUTO_BROAD_FRONTIER_CAP !== undefined
  ) {
    sigeAutoEnv.broadFrontierCap = sigeAutoBroadFrontierCap;
  }
  const sigeAutoBroadPoolSize = Number(process.env.OPENCROW_SMART_SIGE_AUTO_BROAD_POOL_SIZE ?? "");
  if (
    !Number.isNaN(sigeAutoBroadPoolSize) &&
    process.env.OPENCROW_SMART_SIGE_AUTO_BROAD_POOL_SIZE !== undefined
  ) {
    sigeAutoEnv.broadPoolSize = sigeAutoBroadPoolSize;
  }
  if (process.env.OPENCROW_SMART_SIGE_AUTO_CADENCE) {
    sigeAutoEnv.cadence = process.env.OPENCROW_SMART_SIGE_AUTO_CADENCE;
  }
  const sigeAutoMaxConcurrent = Number(process.env.OPENCROW_SMART_SIGE_AUTO_MAX_CONCURRENT ?? "");
  if (
    !Number.isNaN(sigeAutoMaxConcurrent) &&
    process.env.OPENCROW_SMART_SIGE_AUTO_MAX_CONCURRENT !== undefined
  ) {
    sigeAutoEnv.maxConcurrent = sigeAutoMaxConcurrent;
  }
  const sigeAutoMemoryWriteback = boolEnv("OPENCROW_SMART_SIGE_AUTO_MEMORY_WRITEBACK");
  if (sigeAutoMemoryWriteback !== undefined) sigeAutoEnv.memoryWriteback = sigeAutoMemoryWriteback;

  // OPENCROW_SMART_OUTCOME_MEMORY_* overrides for the outcome-memory feature block.
  const outcomeMemoryEnv: Record<string, unknown> = {};
  const outcomeMemoryWriteBack = boolEnv("OPENCROW_SMART_OUTCOME_MEMORY_WRITEBACK");
  if (outcomeMemoryWriteBack !== undefined) outcomeMemoryEnv.writeBack = outcomeMemoryWriteBack;
  const outcomeMemoryReadAtSynthesis = boolEnv("OPENCROW_SMART_OUTCOME_MEMORY_READ_AT_SYNTHESIS");
  if (outcomeMemoryReadAtSynthesis !== undefined)
    outcomeMemoryEnv.readAtSynthesis = outcomeMemoryReadAtSynthesis;
  const outcomeMemoryReinforceCap = Number(
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_REINFORCE_CAP ?? "",
  );
  if (
    !Number.isNaN(outcomeMemoryReinforceCap) &&
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_REINFORCE_CAP !== undefined
  ) {
    outcomeMemoryEnv.reinforceCap = outcomeMemoryReinforceCap;
  }
  const outcomeMemoryAvoidCap = Number(process.env.OPENCROW_SMART_OUTCOME_MEMORY_AVOID_CAP ?? "");
  if (
    !Number.isNaN(outcomeMemoryAvoidCap) &&
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_AVOID_CAP !== undefined
  ) {
    outcomeMemoryEnv.avoidCap = outcomeMemoryAvoidCap;
  }
  const outcomeMemorySearchLimit = Number(
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_SEARCH_LIMIT ?? "",
  );
  if (
    !Number.isNaN(outcomeMemorySearchLimit) &&
    process.env.OPENCROW_SMART_OUTCOME_MEMORY_SEARCH_LIMIT !== undefined
  ) {
    outcomeMemoryEnv.searchLimit = outcomeMemorySearchLimit;
  }

  // OPENCROW_SMART_GRAPH_REASONING_* overrides for the graph-reasoning block.
  // An EXPLICIT block (like outcomeMemoryEnv): the generic deep-merge above does
  // NOT reach nested smart sub-blocks, so each field is read and merged by hand.
  const graphReasoningEnv: Record<string, unknown> = {};
  const graphReasoningEnabled = boolEnv("OPENCROW_SMART_GRAPH_REASONING_ENABLED");
  if (graphReasoningEnabled !== undefined) graphReasoningEnv.enabled = graphReasoningEnabled;
  const graphReasoningMaxHops = Number(process.env.OPENCROW_SMART_GRAPH_REASONING_MAX_HOPS ?? "");
  if (
    !Number.isNaN(graphReasoningMaxHops) &&
    process.env.OPENCROW_SMART_GRAPH_REASONING_MAX_HOPS !== undefined
  ) {
    graphReasoningEnv.maxHops = graphReasoningMaxHops;
  }
  const graphReasoningMaxPaths = Number(process.env.OPENCROW_SMART_GRAPH_REASONING_MAX_PATHS ?? "");
  if (
    !Number.isNaN(graphReasoningMaxPaths) &&
    process.env.OPENCROW_SMART_GRAPH_REASONING_MAX_PATHS !== undefined
  ) {
    graphReasoningEnv.maxPaths = graphReasoningMaxPaths;
  }
  const graphReasoningSearchLimit = Number(
    process.env.OPENCROW_SMART_GRAPH_REASONING_SEARCH_LIMIT ?? "",
  );
  if (
    !Number.isNaN(graphReasoningSearchLimit) &&
    process.env.OPENCROW_SMART_GRAPH_REASONING_SEARCH_LIMIT !== undefined
  ) {
    graphReasoningEnv.searchLimit = graphReasoningSearchLimit;
  }
  const graphReasoningMinDegree = Number(
    process.env.OPENCROW_SMART_GRAPH_REASONING_MIN_DEGREE ?? "",
  );
  if (
    !Number.isNaN(graphReasoningMinDegree) &&
    process.env.OPENCROW_SMART_GRAPH_REASONING_MIN_DEGREE !== undefined
  ) {
    graphReasoningEnv.minDegree = graphReasoningMinDegree;
  }
  const graphReasoningMaxDegree = Number(
    process.env.OPENCROW_SMART_GRAPH_REASONING_MAX_DEGREE ?? "",
  );
  if (
    !Number.isNaN(graphReasoningMaxDegree) &&
    process.env.OPENCROW_SMART_GRAPH_REASONING_MAX_DEGREE !== undefined
  ) {
    graphReasoningEnv.maxDegree = graphReasoningMaxDegree;
  }

  // OPENCROW_SMART_INCUMBENT_EXCLUSION_* overrides for the Layer-C feature block.
  const incumbentExclusionEnv: Record<string, unknown> = {};
  const incumbentEnabled = boolEnv("OPENCROW_SMART_INCUMBENT_EXCLUSION_ENABLED");
  if (incumbentEnabled !== undefined) incumbentExclusionEnv.enabled = incumbentEnabled;
  const incumbentTopN = Number(process.env.OPENCROW_SMART_INCUMBENT_EXCLUSION_TOP_N ?? "");
  if (
    !Number.isNaN(incumbentTopN) &&
    process.env.OPENCROW_SMART_INCUMBENT_EXCLUSION_TOP_N !== undefined
  ) {
    incumbentExclusionEnv.topN = incumbentTopN;
  }

  // OPENCROW_SMART_COMPETABILITY_* overrides for the Layer-B feature block.
  const competabilityEnv: Record<string, unknown> = {};
  const competabilityEnabled = boolEnv("OPENCROW_SMART_COMPETABILITY_ENABLED");
  if (competabilityEnabled !== undefined) competabilityEnv.enabled = competabilityEnabled;
  const competabilityEnforce = boolEnv("OPENCROW_SMART_COMPETABILITY_ENFORCE_GATE");
  if (competabilityEnforce !== undefined) competabilityEnv.enforceGate = competabilityEnforce;
  const competabilityReject = Number(
    process.env.OPENCROW_SMART_COMPETABILITY_REJECT_THRESHOLD ?? "",
  );
  if (
    !Number.isNaN(competabilityReject) &&
    process.env.OPENCROW_SMART_COMPETABILITY_REJECT_THRESHOLD !== undefined
  ) {
    competabilityEnv.rejectThreshold = competabilityReject;
  }
  const competabilitySoft = Number(
    process.env.OPENCROW_SMART_COMPETABILITY_SOFT_PENALTY_THRESHOLD ?? "",
  );
  if (
    !Number.isNaN(competabilitySoft) &&
    process.env.OPENCROW_SMART_COMPETABILITY_SOFT_PENALTY_THRESHOLD !== undefined
  ) {
    competabilityEnv.softPenaltyThreshold = competabilitySoft;
  }
  const competabilityTopN = Number(process.env.OPENCROW_SMART_COMPETABILITY_TOP_N_INCUMBENTS ?? "");
  if (
    !Number.isNaN(competabilityTopN) &&
    process.env.OPENCROW_SMART_COMPETABILITY_TOP_N_INCUMBENTS !== undefined
  ) {
    competabilityEnv.topNIncumbents = competabilityTopN;
  }

  // OPENCROW_SMART_COMPETABILITY_BUILDER_* — the builder profile sub-block.
  const builderProfileEnv: Record<string, unknown> = {};
  if (process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL) {
    builderProfileEnv.capital = process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_CAPITAL;
  }
  const builderTeamSize = Number(process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_TEAM_SIZE ?? "");
  if (
    !Number.isNaN(builderTeamSize) &&
    process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_TEAM_SIZE !== undefined
  ) {
    builderProfileEnv.teamSize = builderTeamSize;
  }
  if (process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_REGULATORY_APPETITE) {
    builderProfileEnv.regulatoryAppetite =
      process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_REGULATORY_APPETITE;
  }
  if (process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_OPS_APPETITE) {
    builderProfileEnv.opsAppetite = process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_OPS_APPETITE;
  }
  if (process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_EXPERTISE_DOMAINS) {
    const domains = process.env.OPENCROW_SMART_COMPETABILITY_BUILDER_EXPERTISE_DOMAINS.split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    builderProfileEnv.expertiseDomains = domains;
  }
  if (Object.keys(builderProfileEnv).length > 0) {
    competabilityEnv.builderProfile = builderProfileEnv;
  }

  // OPENCROW_SMART_DEMAND_* overrides for the demand-grounding probe levers.
  const demandEnv: Record<string, unknown> = {};
  const demandWeakIntent = boolEnv("OPENCROW_SMART_DEMAND_WEAK_INTENT");
  if (demandWeakIntent !== undefined) demandEnv.weakIntent = demandWeakIntent;
  const demandFuzzyMatch = boolEnv("OPENCROW_SMART_DEMAND_FUZZY_MATCH");
  if (demandFuzzyMatch !== undefined) demandEnv.fuzzyMatch = demandFuzzyMatch;
  const demandXIntent = boolEnv("OPENCROW_SMART_DEMAND_X_INTENT");
  if (demandXIntent !== undefined) demandEnv.xIntent = demandXIntent;
  const demandWeakFactor = Number(
    process.env.OPENCROW_SMART_DEMAND_WEAK_INTENT_FACTOR ?? "",
  );
  if (
    !Number.isNaN(demandWeakFactor) &&
    process.env.OPENCROW_SMART_DEMAND_WEAK_INTENT_FACTOR !== undefined
  ) {
    demandEnv.weakIntentFactor = demandWeakFactor;
  }
  const demandWeakMinEngagement = Number(
    process.env.OPENCROW_SMART_DEMAND_WEAK_INTENT_MIN_ENGAGEMENT ?? "",
  );
  if (
    !Number.isNaN(demandWeakMinEngagement) &&
    process.env.OPENCROW_SMART_DEMAND_WEAK_INTENT_MIN_ENGAGEMENT !== undefined
  ) {
    demandEnv.weakIntentMinEngagement = demandWeakMinEngagement;
  }

  // OPENCROW_SMART_DIVERSITY_GUARD_* overrides for the within-run diversity guard.
  const diversityGuardEnv: Record<string, unknown> = {};
  const diversityGuardEnabled = boolEnv("OPENCROW_SMART_DIVERSITY_GUARD_ENABLED");
  if (diversityGuardEnabled !== undefined) diversityGuardEnv.enabled = diversityGuardEnabled;
  const diversityGuardShare = Number(
    process.env.OPENCROW_SMART_DIVERSITY_GUARD_MAX_BUCKET_SHARE ?? "",
  );
  if (
    !Number.isNaN(diversityGuardShare) &&
    process.env.OPENCROW_SMART_DIVERSITY_GUARD_MAX_BUCKET_SHARE !== undefined
  ) {
    diversityGuardEnv.maxBucketShare = diversityGuardShare;
  }
  if (process.env.OPENCROW_SMART_DIVERSITY_GUARD_BUCKET_BY) {
    diversityGuardEnv.bucketBy = process.env.OPENCROW_SMART_DIVERSITY_GUARD_BUCKET_BY;
  }
  const diversityGuardSignal = boolEnv("OPENCROW_SMART_DIVERSITY_GUARD_SIGNAL_GUARD");
  if (diversityGuardSignal !== undefined) diversityGuardEnv.signalGuard = diversityGuardSignal;
  const diversityGuardSignalShare = Number(
    process.env.OPENCROW_SMART_DIVERSITY_GUARD_MAX_SIGNAL_SHARE ?? "",
  );
  if (
    !Number.isNaN(diversityGuardSignalShare) &&
    process.env.OPENCROW_SMART_DIVERSITY_GUARD_MAX_SIGNAL_SHARE !== undefined
  ) {
    diversityGuardEnv.maxSignalShare = diversityGuardSignalShare;
  }

  // OPENCROW_SMART_SEED_DIVERSITY_* overrides for the seed-diversity levers.
  const seedDiversityEnv: Record<string, unknown> = {};
  const seedDiversityEnabled = boolEnv("OPENCROW_SMART_SEED_DIVERSITY_ENABLED");
  if (seedDiversityEnabled !== undefined) seedDiversityEnv.enabled = seedDiversityEnabled;
  const seedDiversityFocusRotation = boolEnv("OPENCROW_SMART_SEED_DIVERSITY_FOCUS_ROTATION");
  if (seedDiversityFocusRotation !== undefined) {
    seedDiversityEnv.focusRotation = seedDiversityFocusRotation;
  }
  const seedDiversityFocusSpread = Number(
    process.env.OPENCROW_SMART_SEED_DIVERSITY_FOCUS_SPREAD ?? "",
  );
  if (
    !Number.isNaN(seedDiversityFocusSpread) &&
    process.env.OPENCROW_SMART_SEED_DIVERSITY_FOCUS_SPREAD !== undefined
  ) {
    seedDiversityEnv.focusSpread = seedDiversityFocusSpread;
  }
  const seedDiversityHighOppSlice = Number(
    process.env.OPENCROW_SMART_SEED_DIVERSITY_HIGH_OPPORTUNITY_SLICE ?? "",
  );
  if (
    !Number.isNaN(seedDiversityHighOppSlice) &&
    process.env.OPENCROW_SMART_SEED_DIVERSITY_HIGH_OPPORTUNITY_SLICE !== undefined
  ) {
    seedDiversityEnv.highOpportunitySlice = seedDiversityHighOppSlice;
  }
  const seedDiversityAnchorLookback = Number(
    process.env.OPENCROW_SMART_SEED_DIVERSITY_RECENT_ANCHOR_LOOKBACK ?? "",
  );
  if (
    !Number.isNaN(seedDiversityAnchorLookback) &&
    process.env.OPENCROW_SMART_SEED_DIVERSITY_RECENT_ANCHOR_LOOKBACK !== undefined
  ) {
    seedDiversityEnv.recentAnchorLookback = seedDiversityAnchorLookback;
  }
  const seedDiversityPainLead = boolEnv("OPENCROW_SMART_SEED_DIVERSITY_PAIN_THEMES_LEAD_SUMMARY");
  if (seedDiversityPainLead !== undefined) {
    seedDiversityEnv.painThemesLeadSummary = seedDiversityPainLead;
  }
  const seedDiversityMaxLeadingThemes = Number(
    process.env.OPENCROW_SMART_SEED_DIVERSITY_MAX_LEADING_PAIN_THEMES ?? "",
  );
  if (
    !Number.isNaN(seedDiversityMaxLeadingThemes) &&
    process.env.OPENCROW_SMART_SEED_DIVERSITY_MAX_LEADING_PAIN_THEMES !== undefined
  ) {
    seedDiversityEnv.maxLeadingPainThemes = seedDiversityMaxLeadingThemes;
  }
  const seedDiversityEchoDownweight = boolEnv(
    "OPENCROW_SMART_SEED_DIVERSITY_ECHO_CHAMBER_DOWNWEIGHT",
  );
  if (seedDiversityEchoDownweight !== undefined) {
    seedDiversityEnv.echoChamberDownweight = seedDiversityEchoDownweight;
  }
  const seedDiversityEchoFactor = Number(
    process.env.OPENCROW_SMART_SEED_DIVERSITY_ECHO_CHAMBER_FACTOR ?? "",
  );
  if (
    !Number.isNaN(seedDiversityEchoFactor) &&
    process.env.OPENCROW_SMART_SEED_DIVERSITY_ECHO_CHAMBER_FACTOR !== undefined
  ) {
    seedDiversityEnv.echoChamberFactor = seedDiversityEchoFactor;
  }

  // OPENCROW_SMART_INDEPENDENT_JURY_* overrides for the MAIN-pipeline jury.
  const independentJuryEnv: Record<string, unknown> = {};
  const independentJuryEnabled = boolEnv("OPENCROW_SMART_INDEPENDENT_JURY_ENABLED");
  if (independentJuryEnabled !== undefined) independentJuryEnv.enabled = independentJuryEnabled;
  const independentJuryWeight = Number(
    process.env.OPENCROW_SMART_INDEPENDENT_JURY_PENALTY_WEIGHT ?? "",
  );
  if (
    !Number.isNaN(independentJuryWeight) &&
    process.env.OPENCROW_SMART_INDEPENDENT_JURY_PENALTY_WEIGHT !== undefined
  ) {
    independentJuryEnv.penaltyWeight = independentJuryWeight;
  }

  // OPENCROW_SMART_SHALLOW_IDEATION_* — Stage 2 broad-shallow ideation block.
  const shallowIdeationEnv: Record<string, unknown> = {};
  const shallowEnabled = boolEnv("OPENCROW_SMART_SHALLOW_IDEATION_ENABLED");
  if (shallowEnabled !== undefined) shallowIdeationEnv.enabled = shallowEnabled;
  const shallowCandidateCount = Number(
    process.env.OPENCROW_SMART_SHALLOW_IDEATION_CANDIDATE_COUNT ?? "",
  );
  if (
    !Number.isNaN(shallowCandidateCount) &&
    process.env.OPENCROW_SMART_SHALLOW_IDEATION_CANDIDATE_COUNT !== undefined
  ) {
    shallowIdeationEnv.candidateCount = shallowCandidateCount;
  }
  const shallowBatchSize = Number(process.env.OPENCROW_SMART_SHALLOW_IDEATION_BATCH_SIZE ?? "");
  if (
    !Number.isNaN(shallowBatchSize) &&
    process.env.OPENCROW_SMART_SHALLOW_IDEATION_BATCH_SIZE !== undefined
  ) {
    shallowIdeationEnv.batchSize = shallowBatchSize;
  }
  if (process.env.OPENCROW_SMART_SHALLOW_IDEATION_MODEL) {
    shallowIdeationEnv.model = process.env.OPENCROW_SMART_SHALLOW_IDEATION_MODEL;
  }

  // OPENCROW_SMART_DEEP_DEVELOP_COUNT — Stage 3 deep-develop count (top-level).
  const deepDevelopCount = Number(process.env.OPENCROW_SMART_DEEP_DEVELOP_COUNT ?? "");
  if (
    !Number.isNaN(deepDevelopCount) &&
    process.env.OPENCROW_SMART_DEEP_DEVELOP_COUNT !== undefined
  ) {
    smartEnv.deepDevelopCount = deepDevelopCount;
  }

  if (
    Object.keys(smartEnv).length > 0 ||
    Object.keys(sigeAutoEnv).length > 0 ||
    Object.keys(outcomeMemoryEnv).length > 0 ||
    Object.keys(graphReasoningEnv).length > 0 ||
    Object.keys(incumbentExclusionEnv).length > 0 ||
    Object.keys(competabilityEnv).length > 0 ||
    Object.keys(demandEnv).length > 0 ||
    Object.keys(diversityGuardEnv).length > 0 ||
    Object.keys(seedDiversityEnv).length > 0 ||
    Object.keys(independentJuryEnv).length > 0 ||
    Object.keys(shallowIdeationEnv).length > 0
  ) {
    const pipelines = { ...((result.pipelines ?? {}) as Record<string, unknown>) };
    const ideas = { ...((pipelines.ideas ?? {}) as Record<string, unknown>) };
    const existingSmart = (ideas.smart ?? {}) as Record<string, unknown>;
    const smart: Record<string, unknown> = { ...existingSmart, ...smartEnv };
    if (Object.keys(sigeAutoEnv).length > 0) {
      const existingSigeAuto = (existingSmart.sigeAuto ?? {}) as Record<string, unknown>;
      smart.sigeAuto = { ...existingSigeAuto, ...sigeAutoEnv };
    }
    if (Object.keys(outcomeMemoryEnv).length > 0) {
      const existingOutcomeMemory = (existingSmart.outcomeMemory ?? {}) as Record<string, unknown>;
      smart.outcomeMemory = { ...existingOutcomeMemory, ...outcomeMemoryEnv };
    }
    if (Object.keys(graphReasoningEnv).length > 0) {
      const existing = (existingSmart.graphReasoning ?? {}) as Record<string, unknown>;
      smart.graphReasoning = { ...existing, ...graphReasoningEnv };
    }
    if (Object.keys(incumbentExclusionEnv).length > 0) {
      const existing = (existingSmart.incumbentExclusion ?? {}) as Record<string, unknown>;
      smart.incumbentExclusion = { ...existing, ...incumbentExclusionEnv };
    }
    if (Object.keys(competabilityEnv).length > 0) {
      const existing = (existingSmart.competability ?? {}) as Record<string, unknown>;
      const mergedComp: Record<string, unknown> = { ...existing, ...competabilityEnv };
      // The shallow spread above would CLOBBER existing.builderProfile with a
      // PARTIAL env profile. Merge the profile field-wise so sibling profile
      // fields survive.
      if (competabilityEnv.builderProfile) {
        const existingBP = (existing.builderProfile ?? {}) as Record<string, unknown>;
        mergedComp.builderProfile = {
          ...existingBP,
          ...(competabilityEnv.builderProfile as Record<string, unknown>),
        };
      }
      smart.competability = mergedComp;
    }
    if (Object.keys(demandEnv).length > 0) {
      const existing = (existingSmart.demand ?? {}) as Record<string, unknown>;
      smart.demand = { ...existing, ...demandEnv };
    }
    if (Object.keys(diversityGuardEnv).length > 0) {
      const existing = (existingSmart.diversityGuard ?? {}) as Record<string, unknown>;
      smart.diversityGuard = { ...existing, ...diversityGuardEnv };
    }
    if (Object.keys(seedDiversityEnv).length > 0) {
      const existing = (existingSmart.seedDiversity ?? {}) as Record<string, unknown>;
      smart.seedDiversity = { ...existing, ...seedDiversityEnv };
    }
    if (Object.keys(independentJuryEnv).length > 0) {
      const existing = (existingSmart.independentJury ?? {}) as Record<string, unknown>;
      smart.independentJury = { ...existing, ...independentJuryEnv };
    }
    if (Object.keys(shallowIdeationEnv).length > 0) {
      const existing = (existingSmart.shallowIdeation ?? {}) as Record<string, unknown>;
      smart.shallowIdeation = { ...existing, ...shallowIdeationEnv };
    }
    result.pipelines = { ...pipelines, ideas: { ...ideas, smart } };
  }

  // --- sige (Strategic Intelligence Game Engine) ---
  // Env-based enable so SIGE can be turned on consistently across both
  // loadConfig() (no DB) and loadConfigWithOverrides() (DB), instead of
  // relying solely on a DB override that only the override-aware loader sees.
  const sigeEnabled = boolEnv("OPENCROW_SIGE_ENABLED");
  const sigeMem0Url = process.env.OPENCROW_SIGE_MEM0_URL;
  // Bearer token for the mem0 sidecar. Reuse the already-shared internal token
  // (the same value compose hands to mem0 as MEM0_API_TOKEN) so the app and the
  // sidecar agree without introducing a 4th secret. Empty string is treated as
  // unset so a blank env var doesn't send "Bearer ".
  const sigeMem0Token = process.env.OPENCROW_INTERNAL_TOKEN || undefined;
  // Read-only Neo4j Bolt connection (graph reasoning). Password is intentionally
  // NOT read here — it is resolved via getSecret("NEO4J_PASSWORD") so it never
  // lands in the config object or logs.
  const sigeNeo4jEnabled = boolEnv("OPENCROW_SIGE_NEO4J_ENABLED");
  const sigeNeo4jUrl = process.env.OPENCROW_SIGE_NEO4J_URL;
  const sigeNeo4jUser = process.env.OPENCROW_SIGE_NEO4J_USER;
  if (
    sigeEnabled !== undefined ||
    sigeMem0Url ||
    sigeMem0Token ||
    sigeNeo4jEnabled !== undefined ||
    sigeNeo4jUrl ||
    sigeNeo4jUser
  ) {
    const sige = { ...((result.sige ?? {}) as Record<string, unknown>) };
    if (sigeEnabled !== undefined) sige.enabled = sigeEnabled;
    if (sigeMem0Url || sigeMem0Token) {
      const mem0 = { ...((sige.mem0 ?? {}) as Record<string, unknown>) };
      if (sigeMem0Url) mem0.baseUrl = sigeMem0Url;
      if (sigeMem0Token) mem0.apiToken = sigeMem0Token;
      sige.mem0 = mem0;
    }
    if (sigeNeo4jEnabled !== undefined || sigeNeo4jUrl || sigeNeo4jUser) {
      const neo4j = { ...((sige.neo4j ?? {}) as Record<string, unknown>) };
      if (sigeNeo4jEnabled !== undefined) neo4j.enabled = sigeNeo4jEnabled;
      if (sigeNeo4jUrl) neo4j.boltUrl = sigeNeo4jUrl;
      if (sigeNeo4jUser) neo4j.user = sigeNeo4jUser;
      sige.neo4j = neo4j;
    }
    result.sige = sige;
  }

  // --- ingestion (data ingestion → mem0; shared infra, independent of sige) ---
  // Autonomous mem0-extraction on/off. Set false for "manual only" operation:
  // SIGE and the pipeline keep running and read whatever corpus already exists,
  // but the unsupervised extraction loop is not spawned.
  const ingestionEnabled = boolEnv("OPENCROW_INGESTION_ENABLED");
  // Ingestion shares the same mem0 instance as sige — reuse the same env so the
  // connection config stays in parity, while remaining its OWN config domain.
  if (ingestionEnabled !== undefined || sigeMem0Url || sigeMem0Token) {
    const ingestion = { ...((result.ingestion ?? {}) as Record<string, unknown>) };
    if (ingestionEnabled !== undefined) ingestion.enabled = ingestionEnabled;
    if (sigeMem0Url || sigeMem0Token) {
      const mem0 = { ...((ingestion.mem0 ?? {}) as Record<string, unknown>) };
      if (sigeMem0Url) mem0.baseUrl = sigeMem0Url;
      if (sigeMem0Token) mem0.apiToken = sigeMem0Token;
      ingestion.mem0 = mem0;
    }
    result.ingestion = ingestion;
  }

  // --- tools (OS sandbox mode + dev-tool network egress) ---
  // The canonical Docker image sets OPENCROW_TOOLS_SANDBOX=required so that a
  // container missing a sandbox mechanism (bubblewrap) FAILS CLOSED instead of
  // silently running shell commands unsandboxed. Operators can also use this to
  // harden any deployment without editing a config file.
  const toolsSandbox = process.env.OPENCROW_TOOLS_SANDBOX;
  const devToolsNet = boolEnv("OPENCROW_DEV_TOOLS_ALLOW_NETWORK");
  // Opt-in escape hatch (default OFF / fail-closed) that lets the dev-tool exec
  // path run without an active OS sandbox. Exposed as env so a trusted-host
  // deployment can flip it without a config file edit; leave unset to fail closed.
  const allowUnsandboxedDevTools = boolEnv("OPENCROW_ALLOW_UNSANDBOXED_DEV_TOOLS");
  if (
    (toolsSandbox && ["off", "best-effort", "required"].includes(toolsSandbox)) ||
    devToolsNet !== undefined ||
    allowUnsandboxedDevTools !== undefined
  ) {
    const tools = { ...((result.tools ?? {}) as Record<string, unknown>) };
    if (toolsSandbox && ["off", "best-effort", "required"].includes(toolsSandbox)) {
      tools.sandbox = toolsSandbox;
    }
    if (devToolsNet !== undefined) tools.devToolsAllowNetwork = devToolsNet;
    if (allowUnsandboxedDevTools !== undefined) {
      tools.allowUnsandboxedDevTools = allowUnsandboxedDevTools;
    }
    result.tools = tools;
  }

  return result;
}

export function loadConfig(): OpenCrowConfig {
  const withEnv = applyEnvOverrides({});
  return opencrowConfigSchema.parse(withEnv);
}

function mergeChannelOverrides(
  base: OpenCrowConfig,
  channelOverrides: readonly ConfigOverride[],
): OpenCrowConfig {
  let channels = base.channels as Record<string, unknown>;
  for (const override of channelOverrides) {
    const existing = (channels[override.key] ?? {}) as Record<string, unknown>;
    const fields = override.value as Record<string, unknown>;
    channels = {
      ...channels,
      [override.key]: { ...existing, ...fields },
    };
  }

  return opencrowConfigSchema.parse({
    ...base,
    channels,
  });
}

/**
 * Deep-merge a DB sige override onto the base sige object derived from
 * env/file configuration.
 *
 * Semantics:
 * - Scalar values present in `override` win over `base`.
 * - Nested object values are shallow-merged (one level deep): keys present in
 *   the override's nested object win; keys absent in the override survive from
 *   `base`. This ensures a DB override of `{"enabled":true}` does not discard
 *   env-derived `mem0.baseUrl`, while a DB override of
 *   `{"mem0":{"baseUrl":"http://x"}}` still lets `mem0.userId` survive from
 *   `base`.
 * - Never mutates either input — builds and returns a new object.
 */
export function deepMergeSigeOverride(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    // Skip prototype-polluting keys. The override originates from a JSON-parsed
    // DB row (config_overrides), so a crafted value could carry an own
    // "__proto__"/"constructor"/"prototype" key. The schema parse downstream
    // strips them, but guard here so the helper stays safe in isolation.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      // Both sides are plain objects: shallow-merge so override keys win but
      // base keys absent from override survive.
      merged[key] = {
        ...(baseVal as Record<string, unknown>),
        ...(overrideVal as Record<string, unknown>),
      };
    } else {
      merged[key] = overrideVal;
    }
  }
  return merged;
}

/**
 * Smart-pipeline sub-blocks that are DB-driven via per-subtree `config/smart.<sub>`
 * overrides. Each entry stores a PARTIAL JSON object that is deep-merged
 * (one level, via deepMergeSigeOverride) onto
 * `pipelines.ideas.smart.<sub>` — exactly the way `config/competability` merges
 * onto `smart.competability`. Kept as a typed tuple of the literal smart keys so
 * the override key (`config/smart.signal`) maps unambiguously to the config field
 * (`smart.signal`) without loosening the rest of the config to `any`.
 *
 * NOTE: `signal` is the UI-facing grouping of the three flat smart fields
 * (signalFacets / signalRanking / signalImportanceFloor). Its merge is handled
 * separately (FLAT, not a nested sub-block) — see mergeSmartSignalOverride.
 */
const SMART_SUBTREE_KEYS = [
  "sigeAuto",
  "outcomeMemory",
  "graphReasoning",
  "incumbentExclusion",
  "diversityGuard",
] as const;
type SmartSubtreeKey = (typeof SMART_SUBTREE_KEYS)[number];

/**
 * Deep-merge a partial DB override for a single nested `smart.<sub>` block onto
 * the smart object, rebuilding every level immutably. Returns a NEW smart object;
 * never mutates the input. Reuses deepMergeSigeOverride for the one-level-deep
 * field merge so a partial `{ enabled: true }` override keeps sibling fields.
 */
function mergeSmartSubtreeOverride(
  smart: Record<string, unknown>,
  subKey: SmartSubtreeKey,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const baseSub = (smart[subKey] ?? {}) as Record<string, unknown>;
  return {
    ...smart,
    [subKey]: deepMergeSigeOverride(baseSub, override),
  };
}

/**
 * Merge the FLAT `config/smart.signal` override. The signal "subtree" is a UI
 * grouping of three flat smart fields, not a nested object, so its override keys
 * map field-wise: { facets, ranking, importanceFloor } →
 * { signalFacets, signalRanking, signalImportanceFloor }. Unknown keys are
 * ignored; absent keys leave the base value intact. Returns a NEW smart object.
 */
function mergeSmartSignalOverride(
  smart: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...smart };
  if (typeof override.facets === "boolean") next.signalFacets = override.facets;
  if (typeof override.ranking === "boolean") {
    next.signalRanking = override.ranking;
  }
  if (typeof override.importanceFloor === "string") {
    next.signalImportanceFloor = override.importanceFloor;
  }
  return next;
}

/**
 * Apply feature toggle overrides from DB:
 * - features.enabledScrapers → sets scraperProcesses.scraperIds
 * - features.qdrantEnabled → toggles memorySearch on/off
 * - config/sige, config/competability → deep-merged onto their subtrees
 * - config/smart.<sub> → deep-merged onto pipelines.ideas.smart.<sub>
 * - config/server, config/sandbox, config/memory → mapped onto web/logLevel/
 *   browser, tools, and memorySearch.backend respectively
 *
 * Precedence is preserved: env (already applied in `base`) is the fallback; a DB
 * row deep-merges ON TOP of it, so DB > env > schema default.
 */
async function mergeFeatureOverrides(
  base: OpenCrowConfig,
): Promise<OpenCrowConfig> {
  const [
    enabledScrapers,
    qdrantEnabled,
    sigeOverride,
    competabilityOverride,
    signalOverride,
    smartSubtreeOverrides,
    serverOverride,
    sandboxOverride,
    memoryOverride,
  ] = await Promise.all([
    getOverride("features", "enabledScrapers"),
    getOverride("features", "qdrantEnabled"),
    getOverride("config", "sige"),
    getOverride("config", "competability"),
    getOverride("config", "smart.signal"),
    Promise.all(
      SMART_SUBTREE_KEYS.map(
        async (k) =>
          [k, await getOverride("config", `smart.${k}`)] as const,
      ),
    ),
    getOverride("config", "server"),
    getOverride("config", "sandbox"),
    getOverride("config", "memory"),
  ]);

  let result: Record<string, unknown> = { ...base };

  if (enabledScrapers !== null) {
    const ids = enabledScrapers as string[];
    const processes = { ...(base.processes as Record<string, unknown>) };
    const scraperProcesses = {
      ...(processes.scraperProcesses as Record<string, unknown>),
      scraperIds: ids,
    };
    result = { ...result, processes: { ...processes, scraperProcesses } };
  }

  if (qdrantEnabled !== null) {
    if (Boolean(qdrantEnabled)) {
      // Enable memorySearch with defaults if not already configured
      if (base.memorySearch === undefined) {
        result = { ...result, memorySearch: {} };
      }
    } else {
      // Disable by removing the memorySearch key
      const { memorySearch: _dropped, ...rest } = result as Record<string, unknown> & {
        memorySearch?: unknown;
      };
      result = rest;
    }
  }

  if (sigeOverride !== null && typeof sigeOverride === "object") {
    const baseSige = (result.sige ?? {}) as Record<string, unknown>;
    result = {
      ...result,
      sige: deepMergeSigeOverride(baseSige, sigeOverride as Record<string, unknown>),
    };
  }

  // config/competability override → pipelines.ideas.smart.competability. Reuse
  // deepMergeSigeOverride: it shallow-merges one level deep, which is EXACTLY
  // deep enough — `builderProfile` sits exactly one level below `competability`,
  // so a partial `{"builderProfile":{"capital":"funded"}}` override has its
  // nested keys shallow-merged onto the base profile (sibling profile fields AND
  // sibling competability fields survive). Rebuild each nested level immutably.
  if (competabilityOverride !== null && typeof competabilityOverride === "object") {
    const pipelines = { ...((result.pipelines ?? {}) as Record<string, unknown>) };
    const ideas = { ...((pipelines.ideas ?? {}) as Record<string, unknown>) };
    const smart = { ...((ideas.smart ?? {}) as Record<string, unknown>) };
    const baseComp = (smart.competability ?? {}) as Record<string, unknown>;
    smart.competability = deepMergeSigeOverride(
      baseComp,
      competabilityOverride as Record<string, unknown>,
    );
    result = {
      ...result,
      pipelines: { ...pipelines, ideas: { ...ideas, smart } },
    };
  }

  // config/smart.signal + config/smart.<sub> overrides → pipelines.ideas.smart.*
  // Each per-subtree key stores a PARTIAL object deep-merged onto its smart
  // sub-block (so two Settings forms never clobber each other). Rebuild the
  // pipelines → ideas → smart chain once, immutably, only if any smart override
  // is present.
  const hasSmartSubtree = smartSubtreeOverrides.some(
    ([, value]) => value !== null && typeof value === "object",
  );
  if (
    (signalOverride !== null && typeof signalOverride === "object") ||
    hasSmartSubtree
  ) {
    const pipelines = { ...((result.pipelines ?? {}) as Record<string, unknown>) };
    const ideas = { ...((pipelines.ideas ?? {}) as Record<string, unknown>) };
    let smart = { ...((ideas.smart ?? {}) as Record<string, unknown>) };
    if (signalOverride !== null && typeof signalOverride === "object") {
      smart = mergeSmartSignalOverride(
        smart,
        signalOverride as Record<string, unknown>,
      );
    }
    for (const [subKey, value] of smartSubtreeOverrides) {
      if (value !== null && typeof value === "object") {
        smart = mergeSmartSubtreeOverride(
          smart,
          subKey,
          value as Record<string, unknown>,
        );
      }
    }
    result = {
      ...result,
      pipelines: { ...pipelines, ideas: { ...ideas, smart } },
    };
  }

  // config/server → web.host / web.port / logLevel / browser.enabled. The
  // override field names map onto the existing schema fields the matching env
  // vars already populate (do NOT invent a new shape). Only fields present in
  // the override are applied; absent fields fall through to env/default.
  if (serverOverride !== null && typeof serverOverride === "object") {
    const o = serverOverride as Record<string, unknown>;
    if (typeof o.webHost === "string" || typeof o.webPort === "number") {
      const web = { ...((result.web ?? {}) as Record<string, unknown>) };
      if (typeof o.webHost === "string") web.host = o.webHost;
      if (typeof o.webPort === "number") web.port = o.webPort;
      result = { ...result, web };
    }
    if (typeof o.logLevel === "string") {
      result = { ...result, logLevel: o.logLevel };
    }
    if (typeof o.browserEnabled === "boolean") {
      const browser = { ...((result.browser ?? {}) as Record<string, unknown>) };
      browser.enabled = o.browserEnabled;
      result = { ...result, browser };
    }
  }

  // config/sandbox → tools.sandbox / tools.devToolsAllowNetwork /
  // tools.allowUnsandboxedDevTools (reuse the existing tools schema fields the
  // OPENCROW_TOOLS_SANDBOX / *_ALLOW_NETWORK / *_ALLOW_UNSANDBOXED_DEV_TOOLS env
  // vars already set).
  if (sandboxOverride !== null && typeof sandboxOverride === "object") {
    const o = sandboxOverride as Record<string, unknown>;
    const tools = { ...((result.tools ?? {}) as Record<string, unknown>) };
    let toolsChanged = false;
    if (
      typeof o.toolsSandbox === "string" &&
      ["off", "best-effort", "required"].includes(o.toolsSandbox)
    ) {
      tools.sandbox = o.toolsSandbox;
      toolsChanged = true;
    }
    if (typeof o.devToolsAllowNetwork === "boolean") {
      tools.devToolsAllowNetwork = o.devToolsAllowNetwork;
      toolsChanged = true;
    }
    if (typeof o.allowUnsandboxedDevTools === "boolean") {
      tools.allowUnsandboxedDevTools = o.allowUnsandboxedDevTools;
      toolsChanged = true;
    }
    if (toolsChanged) result = { ...result, tools };
  }

  // config/memory → memorySearch.backend (qdrant | mem0). Ensure the
  // memorySearch block exists so the override has somewhere to land; the schema
  // fills the rest of the block with its defaults (mirrors the env path).
  if (memoryOverride !== null && typeof memoryOverride === "object") {
    const o = memoryOverride as Record<string, unknown>;
    if (o.backend === "qdrant" || o.backend === "mem0") {
      const memorySearch = {
        ...((result.memorySearch ?? {}) as Record<string, unknown>),
      };
      memorySearch.backend = o.backend;
      result = { ...result, memorySearch };
    }
  }

  return opencrowConfigSchema.parse(result);
}

/**
 * Loads config from file and applies both channel AND agent overrides from DB.
 * This is the primary loader for runtime use — file stays read-only.
 */
export async function loadConfigWithOverrides(): Promise<OpenCrowConfig> {
  const base = loadConfig();
  const channelOverrides = await getAllOverrides("channels");
  const agentOverrides = await getAgentOverrides();
  const withChannels = mergeChannelOverrides(base, channelOverrides);
  const withAgents = mergeAgentOverrides(withChannels, agentOverrides);
  return mergeFeatureOverrides(withAgents);
}

export type AgentSource = "file" | "file+db" | "db";

export interface AgentWithSource extends AgentDefinition {
  readonly _source: AgentSource;
}

/**
 * Merge agent overrides on top of file-defined agents.
 * - File agent with no override → keep as-is (source: "file")
 * - File agent with DB override → spread DB fields on top (source: "file+db")
 * - File agent with _deleted tombstone → exclude
 * - DB-only agent (not in file) → add (source: "db")
 */
function mergeAgentOverrides(
  base: OpenCrowConfig,
  overrides: readonly AgentOverride[],
): OpenCrowConfig {
  const overrideMap = new Map(overrides.map((o) => [o.id, o]));
  const fileAgentIds = new Set(base.agents.map((a) => a.id));

  // Process file agents
  const merged: AgentDefinition[] = [];
  for (const agent of base.agents) {
    const override = overrideMap.get(agent.id);
    if (!override) {
      merged.push(agent);
      continue;
    }

    // Tombstoned — skip
    if ("_deleted" in override.definition && override.definition._deleted) {
      continue;
    }

    // Merge DB fields on top of file agent
    const { _deleted, ...fields } = override.definition as unknown as Record<string, unknown>;
    const combined = { ...agent, ...fields, id: agent.id };
    merged.push(agentDefinitionSchema.parse(combined));
  }

  // Add DB-only agents
  for (const override of overrides) {
    if (fileAgentIds.has(override.id)) continue;
    if ("_deleted" in override.definition && override.definition._deleted) continue;
    merged.push(agentDefinitionSchema.parse(override.definition));
  }

  return opencrowConfigSchema.parse({ ...base, agents: merged });
}

/**
 * Returns merged agents with source annotations for the UI.
 */
export async function getMergedAgentsWithSource(): Promise<readonly AgentWithSource[]> {
  const base = loadConfig();
  const overrides = await getAgentOverrides();
  const overrideMap = new Map(overrides.map((o) => [o.id, o]));
  const fileAgentIds = new Set(base.agents.map((a) => a.id));

  const result: AgentWithSource[] = [];

  for (const agent of base.agents) {
    const override = overrideMap.get(agent.id);
    if (!override) {
      result.push({ ...agent, _source: "file" });
      continue;
    }
    if ("_deleted" in override.definition && override.definition._deleted) {
      continue;
    }
    const { _deleted, ...fields } = override.definition as unknown as Record<string, unknown>;
    const combined = agentDefinitionSchema.parse({
      ...agent,
      ...fields,
      id: agent.id,
    });
    result.push({ ...combined, _source: "file+db" });
  }

  for (const override of overrides) {
    if (fileAgentIds.has(override.id)) continue;
    if ("_deleted" in override.definition && override.definition._deleted) continue;
    const parsed = agentDefinitionSchema.parse(override.definition);
    result.push({ ...parsed, _source: "db" });
  }

  return result;
}

/**
 * Compute a hash of the merged agent list for optimistic concurrency.
 */
export function computeMergedAgentHash(agents: readonly AgentDefinition[]): string {
  const canonical = JSON.stringify(agents.map((a) => a.id).sort());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex").slice(0, 16);
}
