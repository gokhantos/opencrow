/**
 * Standalone entry point for the SIGE (Strategic Intelligence Game Engine) process.
 *
 * Polls for pending SIGE sessions and runs the full pipeline:
 *   knowledge construction → game formulation → expert game →
 *   social simulation → scoring → report generation
 *
 * Usage:
 *   bun src/entries/sige.ts
 */
import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { createProcessSupervisor } from "../process/supervisor";
import { ZepClient } from "../sige/knowledge/zep-client";
import { generateOntology } from "../sige/knowledge/ontology-generator";
import { processDocument, toZepEpisodes } from "../sige/knowledge/entity-extractor";
import { getFullGraph } from "../sige/knowledge/graph-query";
import { formulateGame } from "../sige/game-formulation";
import { runExpertGame } from "../sige/simulation/expert-game";
import { runSocialSimulation } from "../sige/simulation/social-sim";
import { fuseScores, computeSocialViabilityScore } from "../sige/simulation/score-fusion";
import { computeIncentives, applyIncentives } from "../sige/incentives";
import { generateReport } from "../sige/report-agent";
import {
  getPendingSessions,
  updateSessionStatus,
  saveIdeaScore,
} from "../sige/store";
import type { SigeSession, SigeReport, ScoredIdea, FusedScore } from "../sige/types";
import { enrichSeedWithProjectData } from "../sige/seed-enricher";
import { createLogger } from "../logger";

const log = createLogger("sige-entry");

const POLL_INTERVAL_MS = 5_000;
const ZEP_INGEST_WAIT_MS = 1_500;

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runSession(
  session: SigeSession,
  zep: ZepClient,
  signal: AbortSignal,
): Promise<void> {
  const { id: sessionId, seedInput, config } = session;
  const userId = `sige:${sessionId}`;

  log.info("Starting SIGE session pipeline", { sessionId });

  // ── Step 1: Knowledge construction ──────────────────────────────────────────

  await updateSessionStatus(sessionId, "knowledge_construction");
  log.info("Status → knowledge_construction", { sessionId });

  // Enrich seed with existing project data before knowledge construction
  const enrichedSeed = await enrichSeedWithProjectData(seedInput);

  await zep.ensureUser(userId);

  // Add enriched seed as an initial episode
  await zep.addEpisodes(userId, [
    { content: enrichedSeed, source: "seed_input", sourceDescription: "session seed" },
  ]);

  const ontology = await generateOntology(enrichedSeed, { model: config.model, provider: config.provider });

  const extraction = await processDocument(enrichedSeed, ontology, {
    model: config.model,
    provider: config.provider,
    maxConcurrent: config.maxConcurrentAgents,
  });

  const entityEpisodes = toZepEpisodes(extraction, "entity_extraction");
  if (entityEpisodes.length > 0) {
    await zep.addEpisodes(userId, entityEpisodes);
  }

  // Brief wait for Zep to process ingested episodes before querying the graph
  await Bun.sleep(ZEP_INGEST_WAIT_MS);

  // ── Step 2: Game formulation ─────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "game_formulation");
  log.info("Status → game_formulation", { sessionId });

  const graphView = await getFullGraph(zep, userId);

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
    zep,
    userId,
    config,
    signal,
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

  await updateSessionStatus(sessionId, "scoring", {
    fusedScoresJson: JSON.stringify(fusedScores),
  });

  // ── Step 6: Report generation ────────────────────────────────────────────────

  await updateSessionStatus(sessionId, "report_generation");
  log.info("Status → report_generation", { sessionId });

  const report = await generateReport({
    session: {
      ...session,
      gameFormulation,
      expertResult,
      socialResult,
      fusedScores,
    },
    fusedScores,
    zep,
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

function reportToMarkdown(report: SigeReport): string {
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
  ]
  return sections.join("\n")
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

async function pollAndProcess(
  zep: ZepClient,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  let pendingSessions: readonly SigeSession[];

  try {
    pendingSessions = await getPendingSessions();
  } catch (err) {
    log.error("Failed to query pending sessions", { err });
    return;
  }

  if (pendingSessions.length === 0) return;

  // Process sessions sequentially — each is already highly parallel internally
  for (const session of pendingSessions) {
    if (signal.aborted) break;

    try {
      await runSession(session, zep, signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("SIGE session pipeline failed", { sessionId: session.id, err });

      try {
        await updateSessionStatus(session.id, "failed", { error: msg });
      } catch (updateErr) {
        log.error("Failed to mark session as failed", {
          sessionId: session.id,
          err: updateErr,
        });
      }
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "sige",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 5,
  });

  const config = await loadConfigWithOverrides();

  if (config.sige === undefined || !config.sige.enabled) {
    log.info("SIGE not configured or disabled, exiting");
    process.exit(0);
  }

  const sigeConfig = config.sige;

  const zep = new ZepClient({
    apiKey: sigeConfig.zep.apiKey,
    baseUrl: sigeConfig.zep.baseUrl,
  });

  log.info("SIGE process started");

  const supervisor = createProcessSupervisor("sige", { type: "sige" });

  const controller = new AbortController();
  const { signal } = controller;

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  supervisor.onShutdown(() => {
    controller.abort();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  // Run an immediate first poll, then schedule subsequent polls
  await pollAndProcess(zep, signal);

  pollTimer = setInterval(() => {
    pollAndProcess(zep, signal).catch((err) => {
      log.error("Unexpected error in poll cycle", { err });
    });
  }, POLL_INTERVAL_MS);

  await supervisor.start();

  log.info("SIGE process stopped");
}

process.on("unhandledRejection", (reason: unknown) => {
  log.error("Unhandled promise rejection (non-fatal)", { error: reason });
});

process.on("uncaughtException", (error: Error) => {
  log.error("Uncaught exception — exiting", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

main().catch((err) => {
  log.error("SIGE process failed to start", { error: err });
  process.exit(1);
});
