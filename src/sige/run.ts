/**
 * Headless SIGE session library.
 *
 * This module contains the SIGE session pipeline as exported, library-style
 * functions so they can be driven from anywhere (the polling entrypoint in
 * `src/entries/sige.ts`, tests, or other processes) without forking the
 * standalone-process lifecycle.
 *
 * The full session path (`runSession`) preserves the exact behavior that
 * previously lived inline in `src/entries/sige.ts`:
 *   knowledge construction → game formulation → expert game →
 *   social simulation → scoring → report generation.
 */

import { formulateGame } from "./game-formulation";
import { getFullGraph } from "./knowledge/graph-query";
import { Mem0Client } from "./knowledge/mem0-client";
import {
  type DivergentCandidate,
  type GenerateDivergentCandidatesOptions,
  generateDivergentCandidates,
  runExpertGame,
} from "./simulation/expert-game";

// Re-export the divergent-candidate shape so pipeline-phase callers (the ideas
// pipeline's generate-wide pool merge) can import it from the same module that
// exposes `generateDivergentIdeas`, rather than reaching into `expert-game`.
export type { DivergentCandidate } from "./simulation/expert-game";

import { loadConfig } from "../config/loader";
import { createLogger } from "../logger";
import type { MemoryManager } from "../memory/types";
import {
  crossWriteSigeIdeas,
  DEFAULT_SIGE_CROSS_WRITE_LIMIT,
  SIGE_AGENT_ID,
} from "./cross-write";
import type { CollectorContext } from "../pipelines/ideas/collectors";
import { analyzeAppLandscape, clusterReviews, scanCapabilities } from "../pipelines/ideas/collectors";
import type { BroadCorpus, DiscoverFrontiersOptions, DiscoveryResult } from "./discovery/frontier-discovery";
import { discoverFrontiers } from "./discovery/frontier-discovery";
import { applyIncentives, computeIncentives } from "./incentives";
import { generateReport } from "./report-agent";
import { enrichSeedWithProjectData } from "./seed-enricher";
import { signalsToPromptContext, synthesizeSignals } from "./signal-synthesis";
import { computeSocialViabilityScore, fuseScores } from "./simulation/score-fusion";
import { runSocialSimulation } from "./simulation/social-sim";
import { startCancelWatcher } from "./cancel-watcher";
import { loadResumeContext, saveIdeaScore, saveResumeContext, touchSessionActivity, updateSessionStatus } from "./store";
import type { ResumeContext } from "./store";
import type { FusedScore, ScoredIdea, SigeReport, SigeSession, SigeSessionConfig } from "./types";

const log = createLogger("sige:run");

/**
 * Best-effort construction of a vector MemoryManager for SIGE's cross-write
 * semantic dedup layer.
 *
 * Mirrors the wiring in `src/process/bootstrap.ts` (embedding provider + Qdrant
 * client + memory manager) but is fully self-contained and NEVER throws: if
 * memory search is unconfigured (no `memorySearch` block), a secret/embedding
 * provider is missing, or the Qdrant client can't be reached, it returns
 * `null` so the caller transparently falls back to the exact-title + pg_trgm
 * dedup layers (the prior behavior). A failure here must never break a SIGE
 * session.
 *
 * The returned client is short-lived — SIGE uses it only for the cross-write
 * dedup/index and discards it; no long-lived disposal lifecycle is needed.
 */
async function buildSigeMemoryManager(): Promise<MemoryManager | null> {
  try {
    const config = loadConfig();
    if (config.memorySearch === undefined) {
      return null;
    }

    const { getSecret } = await import("../config/secrets");
    const { getOverride } = await import("../store/config-overrides");
    const { embeddingsConfigSchema } = await import("../config/schema");
    const { createEmbeddingProviderFromConfig } = await import("../memory/embeddings");
    const { createQdrantClient } = await import("../memory/qdrant");
    const { createMemoryManager } = await import("../memory/manager");

    const embeddingsOverride = await getOverride("features", "embeddings");
    const embeddingsConfig = embeddingsConfigSchema.parse(
      embeddingsOverride ?? config.embeddings ?? {},
    );
    const apiKey =
      (await getSecret("OPENROUTER_API_KEY")) ?? (await getSecret("VOYAGE_API_KEY")) ?? undefined;
    const embeddingProvider = createEmbeddingProviderFromConfig(embeddingsConfig, apiKey);

    const memSearch = config.memorySearch;
    const qdrantUrl = (await getSecret("QDRANT_URL")) ?? memSearch.qdrant.url;
    const qdrantCollection = memSearch.qdrant.collection;
    const qdrantClient = await createQdrantClient({
      url: qdrantUrl,
      apiKey: memSearch.qdrant.apiKey,
    });

    if (qdrantClient.available) {
      await qdrantClient.ensureCollection(qdrantCollection, embeddingsConfig.dimensions);
    }

    return createMemoryManager({
      embeddingProvider,
      qdrantClient,
      qdrantCollection,
      shared: memSearch.shared,
      defaultLimit: memSearch.defaultLimit,
      minScore: memSearch.minScore,
      vectorWeight: memSearch.vectorWeight,
      textWeight: memSearch.textWeight,
      mmrLambda: memSearch.mmrLambda,
    });
  } catch (err) {
    log.warn(
      "Could not build MemoryManager for SIGE cross-write — semantic dedup layer disabled (non-fatal)",
      { err },
    );
    return null;
  }
}

// ─── Default Session Config ─────────────────────────────────────────────────
//
// Mirrors the DEFAULT_CONFIG used by the web route (src/web/routes/sige.ts) so
// that headless callers that do not have a persisted SigeSession (e.g. the
// ideas pipeline calling evaluateCandidates) can construct a valid
// SigeSessionConfig without duplicating magic numbers throughout the codebase.

export const DEFAULT_SIGE_SESSION_CONFIG: SigeSessionConfig = {
  expertRounds: 4,
  socialAgentCount: 20,
  socialRounds: 3,
  maxConcurrentAgents: 4,
  alpha: 0.5,
  incentiveWeights: {
    diversity: 0.25,
    building: 0.2,
    surprise: 0.15,
    accuracyPenalty: 0.1,
    socialViability: 0.3,
  },
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  agentModel: "claude-sonnet-4-6",
};

/**
 * Merge a partial override onto the default session config.
 *
 * Handy for headless callers that only want to tweak a couple of fields
 * (e.g. provider/model) without restating the whole config object.
 */
export function buildSessionConfig(partial?: Partial<SigeSessionConfig>): SigeSessionConfig {
  if (!partial) return DEFAULT_SIGE_SESSION_CONFIG;
  return {
    ...DEFAULT_SIGE_SESSION_CONFIG,
    ...partial,
    incentiveWeights: partial.incentiveWeights
      ? { ...DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights, ...partial.incentiveWeights }
      : DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights,
  };
}

// ─── Session Pipeline ─────────────────────────────────────────────────────────

/**
 * Run the full SIGE session pipeline for a single persisted session.
 *
 * Behaviorally identical to the function that previously lived inline in
 * `src/entries/sige.ts` — it drives session-status transitions, persists
 * per-step artifacts, and writes the top ideas back into Mem0 for future
 * sessions. The polling entrypoint is now a thin wrapper around this.
 */
export async function runSession(
  session: SigeSession,
  mem0: Mem0Client,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const { id: sessionId, seedInput, mode } = session;

  log.info("Starting SIGE session pipeline", { sessionId, userId, mode: mode ?? "seeded" });

  // ── Cross-process cancellation watcher ──────────────────────────────────────
  //
  // A cancel request lands in the WEB process and only flips this session's DB
  // status to `cancelled` — it cannot reach this signal directly. The watcher
  // polls that status and, on a terminal value, aborts `cancelController`. Its
  // signal is combined with the process-level signal into one run-wide signal
  // (already threaded into chat() and every round), so cancelling stops in-flight
  // LLM calls and the round loop promptly instead of leaving a zombie run.
  const cancelController = new AbortController();
  const runSignal = AbortSignal.any([signal, cancelController.signal]);
  const stopCancelWatcher = startCancelWatcher({ sessionId, controller: cancelController });

  try {
    // ── RESUME PATH ────────────────────────────────────────────────────────────
    //
    // If a resume context was persisted before the process died, skip all
    // discovery/enrichment and jump straight into runSeededSteps. The function is
    // idempotent: already-persisted stages are detected via the session's artifact
    // fields and skipped.
    const resumeCtx = await loadResumeContext(sessionId);
    if (resumeCtx !== null) {
      log.info("Resuming interrupted SIGE session", {
        sessionId,
        fromStatus: session.status,
        isScrapedSeed: resumeCtx.isScrapedSeed,
      });
      await runSeededSteps(
        session,
        mem0,
        userId,
        runSignal,
        resumeCtx.enrichedSeed,
        resumeCtx.isScrapedSeed,
        resumeCtx,
      );
      return;
    }

    // ── AUTONOMOUS PATH (new, default-OFF) ─────────────────────────────────────
    //
    // When the session has no seedInput (origin='auto', mode='autonomous'), run
    // the seedless frontier-discovery → depth-game path. Each top frontier
    // provides a synthetic enrichedSeed that drives the EXISTING steps 1-6
    // byte-for-byte unchanged; the broad pool feeds pipeline-autonomous.ts.
    //
    // A per-run wall-clock timeout (90 min) is combined with the run signal
    // (process + cancel) via AbortSignal.any so a stuck game never outlasts its
    // budget.
    if (mode === "autonomous" || seedInput === undefined) {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => {
        timeoutController.abort();
        log.warn("Autonomous SIGE session timed out (90 min wall-clock)", { sessionId });
      }, 90 * 60 * 1_000);

      const combinedSignal = AbortSignal.any([runSignal, timeoutController.signal]);

      try {
        await runAutonomousSession(session, mem0, userId, combinedSignal);
      } finally {
        clearTimeout(timeoutId);
      }
      return;
    }

    // ── SEEDED PATH (byte-for-byte unchanged) ──────────────────────────────────

    // Enrich seed with existing project data before knowledge construction
    const enrichedSeed = await enrichSeedWithProjectData(seedInput);

    await runSeededSteps(session, mem0, userId, runSignal, enrichedSeed);
  } finally {
    // Clear the watcher interval — no leaked timer regardless of how the run ends.
    stopCancelWatcher();
  }
}

/**
 * Autonomous (seedless) SIGE run: frontier discovery → per-frontier depth game.
 *
 * Collects a real signal corpus (trends × pains × capabilities — the same
 * collectors the demoted ideas pipeline persists continuously) so discovery has
 * grounding to self-pick a frontier. Each collector is fault-tolerant: a failure
 * degrades that section to empty rather than aborting the run. (The pipeline
 * path in `pipeline-autonomous.ts` additionally does markConsumed bookkeeping;
 * the session path only needs the corpus to seed the depth game.)
 *
 * With maxDeepFrontiers=1 (default) the status transitions fire exactly once
 * per stage — identical to a seeded run. With maxDeepFrontiers>1 they repeat
 * (one cycle per frontier); documented and capped at 3 by config.
 */
async function runAutonomousSession(
  session: SigeSession,
  mem0: Mem0Client,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const { id: sessionId } = session;
  const smartConfig = loadConfig().pipelines.ideas.smart;
  const sigeAutoConfig = smartConfig.sigeAuto;

  // Collect a real signal corpus so discovery has grounding to self-pick a
  // frontier. Fault-tolerant: a failing collector degrades to an empty section.
  const collectorModel = session.config.model;
  const collectorCtx: CollectorContext = {
    consumed: new Map(),
    selected: new Map(),
    credibilityPosteriors: new Map(),
  };
  const [trends, pains, capabilities] = await Promise.all([
    analyzeAppLandscape(collectorModel, collectorCtx).catch((err) => {
      log.warn("autonomous: landscape collector failed", { sessionId, err });
      return { trendingCategories: [], risingApps: [], summary: "" };
    }),
    clusterReviews(undefined, collectorModel, collectorCtx).catch((err) => {
      log.warn("autonomous: reviews collector failed", { sessionId, err });
      return { clusters: [], summary: "" };
    }),
    scanCapabilities(collectorModel, collectorCtx).catch((err) => {
      log.warn("autonomous: capabilities collector failed", { sessionId, err });
      return { capabilities: [], summary: "" };
    }),
  ]);
  const corpus: BroadCorpus = { trends, pains, capabilities };
  log.info("autonomous: collected signal corpus", {
    sessionId,
    trends: trends.trendingCategories.length,
    pains: pains.clusters.length,
    capabilities: capabilities.capabilities.length,
  });

  const discoveryOpts: DiscoverFrontiersOptions = {
    broadPoolSize: sigeAutoConfig.broadPoolSize,
    maxDeepFrontiers: sigeAutoConfig.maxDeepFrontiers,
    userId,
    config: session.config,
    signal,
  };

  const discovery: DiscoveryResult = await discoverFrontiers(corpus, mem0, discoveryOpts);

  if (discovery.frontiers.length === 0) {
    log.warn("autonomous: no frontiers discovered — completing without deep game", { sessionId });
    const finishedAt = Math.floor(Date.now() / 1000);
    await updateSessionStatus(sessionId, "completed", { finishedAt });
    return;
  }

  // Run the EXISTING steps 1-6 on each top frontier's seedText as enrichedSeed.
  const topFrontiers = discovery.frontiers.slice(0, sigeAutoConfig.maxDeepFrontiers);

  log.info("autonomous: running depth game on top frontiers", {
    sessionId,
    topFrontiers: topFrontiers.length,
    broadPool: discovery.candidates.length,
  });

  for (const frontier of topFrontiers) {
    if (signal.aborted) break;
    log.info("autonomous: depth game for frontier", {
      sessionId,
      theme: frontier.theme,
      score: frontier.score,
    });
    // Use frontier.seedText as the enrichedSeed for the standard steps 1-6.
    // isScrapedSeed=true: frontier.seedText is scraper-derived and must be
    // sanitized before entering game-formulation LLM prompts.
    await runSeededSteps(session, mem0, userId, signal, frontier.seedText, true);
  }
}

/**
 * Run SIGE steps 1-6 with a pre-built enrichedSeed. Called by the seeded path
 * (with the actual operator seed), the autonomous path (with a frontier seedText),
 * and the resume path (with the persisted enrichedSeed from resumeCtx).
 *
 * Each stage is guarded so that already-persisted artifacts are skipped on
 * resume: the session's artifact fields (gameFormulation, expertResult, etc.)
 * are hydrated by rowToSession when the session is loaded from the DB, so a
 * resume will skip stages whose results are already stored.
 *
 * @param isScrapedSeed When true (autonomous path), `enrichedSeed` is
 *   scraper-derived and must be sanitized before entering LLM prompts.
 * @param resumeCtx When provided, signal synthesis is skipped and the persisted
 *   signalsContext is used instead.
 */
async function runSeededSteps(
  session: SigeSession,
  mem0: Mem0Client,
  userId: string,
  signal: AbortSignal,
  enrichedSeed: string,
  isScrapedSeed = false,
  resumeCtx?: ResumeContext,
): Promise<void> {
  const { id: sessionId, config } = session;

  // ── Load already-persisted artifacts from session ────────────────────────────
  // These fields are hydrated by rowToSession when a session is loaded from DB.
  // On a fresh run they're all undefined; on resume some may already be set.
  let gameFormulation = session.gameFormulation;
  let expertResult = session.expertResult;
  let socialResult = session.socialResult;
  let fusedScores = session.fusedScores;

  // ── Step 1: Knowledge construction ──────────────────────────────────────────
  // Only run signal synthesis if we still need it (gameFormulation not yet done).
  // On resume, we restore signalsContext from the resume context to avoid
  // re-running the LLM call.

  let signalsContext: string | undefined;

  const needsSignals = gameFormulation === undefined || expertResult === undefined;

  if (needsSignals) {
    await updateSessionStatus(sessionId, "knowledge_construction");
    await touchSessionActivity(sessionId);
    log.info("Status → knowledge_construction", { sessionId });

    if (resumeCtx !== undefined) {
      // Resume path: restore signalsContext from persisted context.
      signalsContext = resumeCtx.signalsContext;
      log.info("Restored signalsContext from resume context", { sessionId });
    } else {
      // Fresh path: run signal synthesis in parallel with graph query.
      signalsContext = await synthesizeSignals(enrichedSeed, {
        model: config.model,
        provider: config.provider,
      })
        .then((signals) => signalsToPromptContext(signals))
        .catch((err) => {
          log.warn("Signal synthesis failed — continuing without synthesized signals", {
            sessionId,
            err,
          });
          return undefined;
        });

      // Persist resume context now that we have signalsContext, before any
      // expensive LLM stage. If the process dies after this point, we can
      // resume from here without re-running signal synthesis.
      await saveResumeContext(sessionId, { enrichedSeed, signalsContext, isScrapedSeed });
    }
  }

  // graphView is always re-fetched (Mem0 read, fast, degrades to empty on error).
  const graphView = await getFullGraph(mem0, userId);

  // ── Step 2: Game formulation ─────────────────────────────────────────────────
  if (gameFormulation === undefined) {
    await updateSessionStatus(sessionId, "game_formulation");
    await touchSessionActivity(sessionId);
    log.info("Status → game_formulation", { sessionId });

    gameFormulation = await formulateGame(graphView, enrichedSeed, {
      model: config.model,
      provider: config.provider,
      sessionId,
      isScrapedSeed,
    });

    await updateSessionStatus(sessionId, "game_formulation", {
      gameFormulationJson: JSON.stringify(gameFormulation),
    });
  } else {
    log.info("Skipping game_formulation — already persisted", { sessionId });
  }

  // ── Step 3: Expert game ──────────────────────────────────────────────────────
  if (expertResult === undefined) {
    await updateSessionStatus(sessionId, "expert_game");
    await touchSessionActivity(sessionId);
    log.info("Status → expert_game", { sessionId });

    expertResult = await runExpertGame({
      sessionId,
      gameFormulation,
      graphView,
      mem0,
      userId,
      config,
      signal,
      signalsContext,
      enrichedSeed,
    });

    await updateSessionStatus(sessionId, "expert_game", {
      expertResultJson: JSON.stringify(expertResult),
    });
  } else {
    log.info("Skipping expert_game — already persisted", { sessionId });
  }

  // ── Step 4: Social simulation ────────────────────────────────────────────────
  if (socialResult === undefined) {
    await updateSessionStatus(sessionId, "social_simulation");
    await touchSessionActivity(sessionId);
    log.info("Status → social_simulation", { sessionId });

    socialResult = await runSocialSimulation({
      sessionId,
      ideas: expertResult.rankedIdeas,
      citizenCount: config.socialAgentCount,
      rounds: config.socialRounds,
      config,
      signal,
    });

    await updateSessionStatus(sessionId, "social_simulation", {
      socialResultJson: JSON.stringify(socialResult),
    });
  } else {
    log.info("Skipping social_simulation — already persisted", { sessionId });
  }

  // ── Step 5: Scoring ──────────────────────────────────────────────────────────
  // fusedScores presence means scoring is done. The cross-write and idea score
  // rows are also skipped because they were already written (saveIdeaScore uses
  // INSERT, not upsert; re-running would duplicate rows).
  if (fusedScores === undefined) {
    await updateSessionStatus(sessionId, "scoring");
    await touchSessionActivity(sessionId);
    log.info("Status → scoring", { sessionId });

    // socialResult is guaranteed non-null here: either just assigned above or
    // already loaded from the DB (session.socialResult was set). The outer guard
    // `fusedScores === undefined` ensures we only reach this block when scoring
    // hasn't happened yet, so social_simulation must have run.
    const confirmedSocialResult = socialResult;
    if (confirmedSocialResult === undefined) {
      throw new Error(`SIGE session ${sessionId}: socialResult missing before scoring — unexpected state`);
    }

    fusedScores = fuseScores(expertResult.rankedIdeas, confirmedSocialResult, config.alpha);

    // Apply incentives to each ranked idea and persist idea scores
    const allIdeas: readonly ScoredIdea[] = expertResult.rankedIdeas;

    await Promise.all(
      fusedScores.map(async (fused: FusedScore) => {
        const idea = allIdeas.find((i) => i.id === fused.ideaId);
        if (!idea) return;

        const socialViabilityScore = computeSocialViabilityScore(
          fused.ideaId,
          confirmedSocialResult,
        );

        const incentiveBreakdown = computeIncentives(idea, {
          allIdeas,
          socialViabilityScore,
          weights: config.incentiveWeights,
        });

        const adjustedScore = applyIncentives(
          fused.fusedScore,
          incentiveBreakdown,
          config.incentiveWeights,
        );

        await saveIdeaScore({
          id: crypto.randomUUID(),
          ideaId: fused.ideaId,
          sessionId,
          expertScore: fused.expertScore,
          socialScore: fused.socialScore,
          fusedScore: adjustedScore,
          incentiveJson: JSON.stringify(incentiveBreakdown),
          strategicMetadataJson: JSON.stringify(idea.strategicMetadata),
        });
      }),
    );

    // Build a fused score lookup and enrich ranked ideas with final scores
    const scoreMap = new Map(fusedScores.map((f) => [f.ideaId, f]));
    const enrichedRankedIdeas: readonly ScoredIdea[] = expertResult.rankedIdeas.map((idea) => {
      const fused = scoreMap.get(idea.id);
      return fused
        ? { ...idea, fusedScore: fused.fusedScore, socialScore: fused.socialScore }
        : idea;
    });

    const enrichedExpertResult = { ...expertResult, rankedIdeas: enrichedRankedIdeas };

    await updateSessionStatus(sessionId, "scoring", {
      fusedScoresJson: JSON.stringify(fusedScores),
      expertResultJson: JSON.stringify(enrichedExpertResult),
    });

    // Update local variable to the enriched version for report generation.
    expertResult = enrichedExpertResult;

    // ── Step 5b: SIGE → generated_ideas cross-write (#11 part2) ────────────────────
    //
    // GATED, default OFF. Only when smart.sigeValuation is on AND config.sige is
    // enabled do we promote the top scored ideas into the shared generated_ideas
    // table (routed through the same 3-layer dedup the ideas pipeline uses). When
    // off, SIGE behavior is completely unchanged. Degrades gracefully — a failure
    // here never breaks the session.
    //
    // On resume after scoring (fusedScores was already set): this block is skipped
    // entirely — the ideas were already cross-written in the original run.
    try {
      const appConfig = loadConfig();
      const sigeCrossWriteEnabled =
        appConfig.pipelines.ideas.smart.sigeValuation && appConfig.sige?.enabled === true;

      if (sigeCrossWriteEnabled) {
        const memoryManager = await buildSigeMemoryManager();

        // Layer B competability gate on SIGE ideas — reuses the shared
        // smart.competability config and the session's own model/provider.
        const competabilityConfig = appConfig.pipelines.ideas.smart.competability;
        const result = await crossWriteSigeIdeas(
          enrichedRankedIdeas,
          sessionId,
          memoryManager,
          DEFAULT_SIGE_CROSS_WRITE_LIMIT,
          {
            config: competabilityConfig,
            model: session.config.model,
            provider: session.config.provider,
          },
        );
        log.info("SIGE cross-write into generated_ideas", {
          sessionId,
          inserted: result.inserted,
          rejected: result.rejected.length,
          semanticDedup: memoryManager !== null,
        });

        if (memoryManager !== null && result.insertedIdeas.length > 0) {
          await Promise.all(
            result.insertedIdeas.map((idea) =>
              memoryManager
                .indexIdea(SIGE_AGENT_ID, {
                  id: idea.id,
                  title: idea.title,
                  summary: idea.description,
                  category: "sige",
                  reasoning: idea.description,
                })
                .catch((err) => {
                  log.warn("Failed to index SIGE idea into memory (non-fatal)", {
                    sessionId,
                    ideaId: idea.id,
                    err,
                  });
                }),
            ),
          );
        }
      }
    } catch (err) {
      log.warn("SIGE cross-write step failed (non-fatal)", { sessionId, err });
    }
  } else {
    log.info("Skipping scoring — already persisted", { sessionId });
    // On resume after scoring: expertResult loaded from DB already has the
    // enriched rankedIdeas (stored during the scoring update). Use it as-is.
  }

  // ── Step 6: Report generation ────────────────────────────────────────────────
  // Always run if status != completed (report generation is idempotent — it just
  // overwrites the report column, and generateReport has no side effects beyond that).

  await updateSessionStatus(sessionId, "report_generation");
  await touchSessionActivity(sessionId);
  log.info("Status → report_generation", { sessionId });

  // ── Cross-session write-back: persist top ideas to Mem0 for future sessions ─
  //
  // Seeded (origin='human') sessions are operator-initiated and write back
  // exactly as before. Autonomous (origin='auto') sessions are NOT operator-
  // reviewed before write-back, so they close a memory-poisoning feedback loop
  // (scraped injection → idea → Mem0 → next session's graph context). They are
  // therefore gated behind smart.sigeAuto.memoryWriteback (default OFF) and
  // tagged trust:'autonomous-unvetted' so the graph reader can treat them as
  // untrusted downstream.
  const isAutonomous = session.origin === "auto";
  const autonomousWritebackEnabled = loadConfig().pipelines.ideas.smart.sigeAuto.memoryWriteback;
  const shouldWriteBack = !isAutonomous || autonomousWritebackEnabled;

  // expertResult.rankedIdeas has fusedScore/socialScore merged in from scoring
  // (either just computed above, or loaded from DB with the enriched form).
  const rankedIdeasForReport = expertResult.rankedIdeas;

  if (shouldWriteBack) {
    const topIdeasForMemory = rankedIdeasForReport.slice(0, 5);
    await mem0
      .addMemories({
        items: topIdeasForMemory.map((idea) => ({
          content: `SIGE finding: "${idea.title}" — ${idea.description}. Score: ${idea.fusedScore?.toFixed(3) ?? "N/A"}`,
          metadata: isAutonomous
            ? {
                source: "sige_session",
                sessionId,
                ideaId: idea.id,
                trust: "autonomous-unvetted",
              }
            : { source: "sige_session", sessionId, ideaId: idea.id },
        })),
        userId,
        enableGraph: true,
        maxConcurrent: 2,
      })
      .catch((err) => {
        log.warn("Failed to write top ideas back to Mem0 (non-fatal)", { sessionId, err });
      });
  } else {
    log.info("Skipping autonomous Mem0 write-back (memoryWriteback disabled)", { sessionId });
  }

  const confirmedFusedScores = fusedScores;
  if (confirmedFusedScores === undefined) {
    throw new Error(
      `SIGE session ${sessionId}: fusedScores missing before report generation — unexpected state`,
    );
  }

  const report = await generateReport({
    session: {
      ...session,
      gameFormulation,
      expertResult,
      socialResult,
      fusedScores: confirmedFusedScores,
    },
    fusedScores: confirmedFusedScores,
    mem0,
    userId,
    model: config.model,
    provider: config.provider,
  });

  const finishedAt = Math.floor(Date.now() / 1000);

  await updateSessionStatus(sessionId, "completed", {
    report: reportToMarkdown(report),
    finishedAt,
  });

  log.info("SIGE session completed", { sessionId });
}

// ─── Report Serialization ─────────────────────────────────────────────────

/**
 * Render a SigeReport into the markdown shape persisted on the session row.
 * Exported so callers that build their own reports can reuse the serializer.
 */
export function reportToMarkdown(report: SigeReport): string {
  const sections: string[] = [
    "# Strategic Intelligence Report\n",
    "## Executive Summary\n",
    report.executiveSummary,
    "\n\n## Top Ideas\n",
    report.topIdeas
      .map(
        (idea, i) =>
          `${i + 1}. **${idea.title}** (score: ${idea.fusedScore?.toFixed(3) ?? "N/A"})\n   ${idea.description}`,
      )
      .join("\n\n"),
    "\n\n## Per-Idea Analysis\n",
    report.perIdeaAnalysis
      .map(
        (a) =>
          `### ${a.idea.title}\n\n${a.gameContext}\n\nEquilibria: ${a.equilibriumMembership.join(", ") || "none"}\n\nSocial reception: ${a.socialReception}`,
      )
      .join("\n\n"),
    "\n\n## Opportunity Map\n",
    report.opportunityMap,
    "\n\n## Risk Assessment\n",
    report.riskAssessment,
    "\n\n## Meta-Game Health\n",
    `- Diversity index: ${report.metaGameHealth.diversityIndex.toFixed(3)}`,
    `- Convergence rate: ${report.metaGameHealth.convergenceRate.toFixed(3)}`,
    `- Novelty score: ${report.metaGameHealth.noveltyScore.toFixed(3)}`,
    "\n\n## Recommended Next Session\n",
    report.recommendedNextSession,
  ];
  return sections.join("\n");
}

// ─── Generation-Only Divergent Entry (pool-merge for the ideas pipeline) ──────
//
// Lightweight, generation-only doorway into SIGE's strongly-divergent personas
// (contrarian_investor + explorer, plus founder + user_researcher by default).
// Runs ONLY Round-1 divergent generation — no rounds 2–4, no social sim, no
// scoring. The returned candidates are meant to be MERGED into the synthesizer
// pool (Phase 1 "generate wide"); evaluation/scoring happens later (Phase 3).
//
// Candidates are fed the pipeline's grounded chain-of-evidence signals via
// `signalsContext`, so they stay tethered to real evidence rather than
// free-associating. Independent of config.sige.enabled — the ideas pipeline
// gates this behind smart.generateWide.sigeDivergent.
//
// Pipeline-phase entry signature (for the synthesizer):
//   generateDivergentIdeas(signalsContext, opts?) =>
//     Promise<{ title, summary, supportingSignalIds?, proposedBy }[]>

/**
 * Options accepted by {@link generateDivergentIdeas}. Mirrors the underlying
 * {@link GenerateDivergentCandidatesOptions} but omits `signalsContext`, which
 * is passed as the dedicated first argument (the grounded signals are the
 * load-bearing input that keeps candidates tethered).
 */
export type GenerateDivergentIdeasOptions = Omit<
  GenerateDivergentCandidatesOptions,
  "signalsContext"
>;

/**
 * Run SIGE's Round-1 divergent personas in generation-only mode and return
 * candidate ideas for the synthesizer pool.
 *
 * Fully fault-tolerant: any failure inside the divergent path (LLM error,
 * Mem0 unreachable, parse failure) is logged and yields an empty array so the
 * caller's pipeline is never broken by enabling this optional widening path.
 *
 * @param signalsContext Grounded chain-of-evidence signals prompt context from
 *   the ideas pipeline. Optional, but strongly recommended — without it the
 *   personas have no real evidence to ground against.
 * @param opts Optional overrides (personas, caps, config, mem0 wiring).
 */
export async function generateDivergentIdeas(
  signalsContext?: string,
  opts: GenerateDivergentIdeasOptions = {},
): Promise<readonly DivergentCandidate[]> {
  try {
    return await generateDivergentCandidates({ ...opts, signalsContext });
  } catch (err) {
    log.warn("generateDivergentIdeas failed — returning no divergent candidates (non-fatal)", {
      err,
    });
    return [];
  }
}
