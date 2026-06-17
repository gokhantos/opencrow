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
import { Mem0Client } from "./knowledge/mem0-client";
import { getFullGraph } from "./knowledge/graph-query";
import { formulateGame } from "./game-formulation";
import { runExpertGame } from "./simulation/expert-game";
import { runSocialSimulation } from "./simulation/social-sim";
import { fuseScores, computeSocialViabilityScore } from "./simulation/score-fusion";
import { computeIncentives, applyIncentives } from "./incentives";
import { generateReport } from "./report-agent";
import {
  updateSessionStatus,
  saveIdeaScore,
} from "./store";
import type {
  SigeSession,
  SigeSessionConfig,
  SigeReport,
  ScoredIdea,
  FusedScore,
} from "./types";
import { enrichSeedWithProjectData } from "./seed-enricher";
import { synthesizeSignals, signalsToPromptContext } from "./signal-synthesis";
import { crossWriteSigeIdeas, SIGE_AGENT_ID } from "./cross-write";
import { loadConfig } from "../config/loader";
import { createLogger } from "../logger";
import type { MemoryManager } from "../memory/types";

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
      (await getSecret("OPENROUTER_API_KEY")) ??
      (await getSecret("VOYAGE_API_KEY")) ??
      undefined;
    const embeddingProvider = createEmbeddingProviderFromConfig(
      embeddingsConfig,
      apiKey,
    );

    const memSearch = config.memorySearch;
    const qdrantUrl = (await getSecret("QDRANT_URL")) ?? memSearch.qdrant.url;
    const qdrantCollection = memSearch.qdrant.collection;
    const qdrantClient = await createQdrantClient({
      url: qdrantUrl,
      apiKey: memSearch.qdrant.apiKey,
    });

    if (qdrantClient.available) {
      await qdrantClient.ensureCollection(
        qdrantCollection,
        embeddingsConfig.dimensions,
      );
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
export function buildSessionConfig(
  partial?: Partial<SigeSessionConfig>,
): SigeSessionConfig {
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
  const { id: sessionId, seedInput, config } = session;

  log.info("Starting SIGE session pipeline", { sessionId, userId });

  // ── Step 1: Knowledge construction ──────────────────────────────────────────

  await updateSessionStatus(sessionId, "knowledge_construction");
  log.info("Status → knowledge_construction", { sessionId });

  // Enrich seed with existing project data before knowledge construction
  const enrichedSeed = await enrichSeedWithProjectData(seedInput);

  // Run signal synthesis (LLM) and graph query (Mem0) in parallel — they're independent
  const signalSynthesisPromise = synthesizeSignals(enrichedSeed, {
    model: config.model,
    provider: config.provider,
  })
    .then((signals) => signalsToPromptContext(signals))
    .catch((err) => {
      log.warn("Signal synthesis failed — continuing without synthesized signals", { sessionId, err });
      return undefined;
    });

  const graphViewPromise = getFullGraph(mem0, userId);

  const [signalsContext, graphView] = await Promise.all([
    signalSynthesisPromise,
    graphViewPromise,
  ]);

  // ── Step 2: Game formulation ─────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "game_formulation");
  log.info("Status → game_formulation", { sessionId });

  const gameFormulation = await formulateGame(graphView, enrichedSeed, {
    model: config.model,
    provider: config.provider,
    sessionId,
  });

  await updateSessionStatus(sessionId, "game_formulation", {
    gameFormulationJson: JSON.stringify(gameFormulation),
  });

  // ── Step 3: Expert game ──────────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "expert_game");
  log.info("Status → expert_game", { sessionId });

  const expertResult = await runExpertGame({
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

  // ── Step 4: Social simulation ────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "social_simulation");
  log.info("Status → social_simulation", { sessionId });

  const socialResult = await runSocialSimulation({
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

  // ── Step 5: Scoring ──────────────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "scoring");
  log.info("Status → scoring", { sessionId });

  const fusedScores = fuseScores(expertResult.rankedIdeas, socialResult, config.alpha);

  // Apply incentives to each ranked idea and persist idea scores
  const allIdeas: readonly ScoredIdea[] = expertResult.rankedIdeas;

  await Promise.all(
    fusedScores.map(async (fused: FusedScore) => {
      const idea = allIdeas.find((i) => i.id === fused.ideaId);
      if (!idea) return;

      const socialViabilityScore = computeSocialViabilityScore(fused.ideaId, socialResult);

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

  // ── Step 5b: SIGE → generated_ideas cross-write (#11 part2) ────────────────────
  //
  // GATED, default OFF. Only when smart.sigeValuation is on AND config.sige is
  // enabled do we promote the top scored ideas into the shared generated_ideas
  // table (routed through the same 3-layer dedup the ideas pipeline uses). When
  // off, SIGE behavior is completely unchanged. Degrades gracefully — a failure
  // here never breaks the session.
  try {
    const appConfig = loadConfig();
    const sigeCrossWriteEnabled =
      appConfig.pipelines.ideas.smart.sigeValuation &&
      appConfig.sige?.enabled === true;

    if (sigeCrossWriteEnabled) {
      // Build a vector MemoryManager so the Qdrant (>0.65) semantic dedup layer
      // runs. Falls back to null when memory/Qdrant is unconfigured or
      // construction fails — then only the exact-title + pg_trgm layers run
      // (the prior behavior). Never breaks the session.
      const memoryManager = await buildSigeMemoryManager();

      const result = await crossWriteSigeIdeas(
        enrichedRankedIdeas,
        sessionId,
        memoryManager,
      );
      log.info("SIGE cross-write into generated_ideas", {
        sessionId,
        inserted: result.inserted,
        rejected: result.rejected.length,
        semanticDedup: memoryManager !== null,
      });

      // Mirror the trend pipeline (pipeline.ts step 7): index the cross-written
      // ideas into memory so future dedup/search can see them. Best-effort and
      // gated by the same try/catch — failures here never break the session.
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

  // ── Step 6: Report generation ────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "report_generation");
  log.info("Status → report_generation", { sessionId });

  // ── Cross-session write-back: persist top ideas to Mem0 for future sessions ─

  const topIdeasForMemory = enrichedRankedIdeas.slice(0, 5);
  await mem0
    .addMemories({
      items: topIdeasForMemory.map((idea) => ({
        content: `SIGE finding: "${idea.title}" — ${idea.description}. Score: ${idea.fusedScore?.toFixed(3) ?? "N/A"}`,
        metadata: { source: "sige_session", sessionId, ideaId: idea.id },
      })),
      userId,
      enableGraph: true,
      maxConcurrent: 2,
    })
    .catch((err) => {
      log.warn("Failed to write top ideas back to Mem0 (non-fatal)", { sessionId, err });
    });

  const report = await generateReport({
    session: {
      ...session,
      gameFormulation,
      expertResult: enrichedExpertResult,
      socialResult,
      fusedScores,
    },
    fusedScores,
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
