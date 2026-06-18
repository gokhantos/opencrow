/**
 * Trend-Intersection Idea Pipeline.
 *
 * Steps:
 * 1. trends — Detect what's moving in app store rankings
 * 2. pain_points — Cluster complaints in trending categories
 * 3. capabilities — Scan PH/HN/GitHub/News/Reddit/X for new capabilities
 * 4. deep_search — Qdrant semantic search for supporting evidence
 * 5. synthesis — AI finds intersections: trend + pain + capability = idea
 * 6. validate — Semantic dedup via Qdrant
 * 7. store — Save ideas
 *
 * This file is the orchestrator entry point and public barrel.
 * Helpers extracted to co-located siblings:
 *   - pipeline-sige-math.ts   pure SIGE math + candidate mappers
 *   - pipeline-stamps.ts      stamping, provenance, demand, taste helpers
 *   - pipeline-context.ts     theme/ngram, exemplars, taste loop, credibility
 *   - pipeline-runner.ts      async SIGE valuation + store sub-phases
 */

import type { MemoryManager } from "../../memory/types";
import { loadConfig } from "../../config/loader";
import { createLogger } from "../../logger";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import {
  findCompletedStep,
  getPipelineRun,
  markRunFailed,
  updatePipelineRun,
} from "../store";
import { beginRun, endRun } from "../active-runs";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import type { CollectorContext } from "./collectors";
import { analyzeAppLandscape, clusterReviews, scanCapabilities } from "./collectors";
import { getConsumedIds, markConsumed } from "./consumption";
import type { DemandArtifact } from "./demand";
import { DEFAULT_DEMAND_PROBES, enrichDemand } from "./demand-probes";
import { loadGiantWeights } from "./feedback-bootstrap";
import type { GiantConfig } from "../../config/schema";
import { fetchOutcomeMemoryBlock } from "./outcome-memory";
import { selectWithNoveltyReserve } from "./generate-wide";
import { getDb } from "../../store/db";
import { annotateOriginality, checkForDuplicates, verifyEvidence } from "./validate";
import { buildValidatedExemplars, deepSearch, synthesizeFromTrends } from "./synthesizer";

// ── public barrel: re-export everything external code imports from this module ─
export {
  // pipeline-sige-math
  combineGiantScores,
  normalizeDissent,
  buildJuryPanel,
  buildPairwiseWins,
  buildSignalsContext,
  mapDivergentToCandidate,
  mapDeepGameRankedToCandidate,
  mergeSigeCandidates,
  synthesizeEnrichedSeed,
  enforceSegmentSpread,
  paretoSelect,
  computeSigeConvergenceVeto,
  summarizeSegmentSpread,
  mapEvolvedEvaluation,
  type SigeSignals,
  type SigeHardenedResult,
  type SegmentSpreadStats,
} from "./pipeline-sige-math";
export {
  // pipeline-stamps
  candidateHasDemandEvidence,
  evaluateCandidateGiantGate,
  toDemandCandidateText,
  buildEnrichDemandConfig,
  applyDemandRescore,
  buildDemandEvidenceString,
  summarizeDemandCoverage,
  rotationSeedFromRunId,
  toScoredIdeaForProxy,
  type CandidateGiantGate,
  type DemandCoverageStats,
  type ProvenanceEntry,
} from "./pipeline-stamps";
export {
  // pipeline-context
  extractThemesByNgrams,
  buildTasteBlocks,
  toScoredIdeaRow,
  type TasteBlocks,
} from "./pipeline-context";

import {
  evaluateCandidateGiantGate,
  toDemandCandidateText,
  buildEnrichDemandConfig,
  applyDemandRescore,
  summarizeDemandCoverage,
  rotationSeedFromRunId,
  type CandidateGiantGate,
  type ProvenanceEntry,
} from "./pipeline-stamps";
import {
  buildSaturatedThemes,
  fetchValidatedExemplars,
  fetchScoredIdeaRows,
  buildTasteBlocks,
  buildDeepSearchOptions,
  loadCredibilityPosteriors,
} from "./pipeline-context";
import {
  enforceSegmentSpread,
  summarizeSegmentSpread,
  paretoSelect,
  computeSigeConvergenceVeto,
  buildSignalsContext,
  type SigeSignals,
} from "./pipeline-sige-math";
import {
  applySigeValuation,
  fetchDivergentCandidates,
  now,
  nowMs,
  runOutcomeMemoryWriteBack,
  runProxyLabelPhase,
  runStep,
  runStorePhase,
  sanitizeError,
} from "./pipeline-runner";
import type { GeneratedIdeaCandidate } from "./types";

const log = createLogger("pipeline:ideas");

const AGENT_ID = "idea-pipeline";

/**
 * Version tag stamped on generated_ideas.prompt_version. Bump when the
 * synthesis/critique prompt structure changes so learning loops can segment
 * outcomes by prompt generation.
 */
const PROMPT_VERSION = "trend-intersection-v2";

export interface PipelineRunResult {
  readonly runId: string;
  readonly summary: PipelineResultSummary;
}

/** Zero-value summary returned when a duplicate dispatch is suppressed and the
 *  run has no persisted summary yet. */
const EMPTY_RUN_SUMMARY: PipelineResultSummary = {
  totalSourcesQueried: 0,
  totalSignalsFound: 0,
  totalIdeasGenerated: 0,
  totalIdeasKept: 0,
  totalIdeasDuplicate: 0,
  topThemes: [],
  ideaIds: [],
  durationMs: 0,
};

export async function runIdeasPipeline(
  _pipelineId: string,
  config: PipelineConfig,
  runId: string,
  memoryManager?: MemoryManager | null,
): Promise<PipelineRunResult> {
  // Duplicate-dispatch guard: if this process is already executing this run, do
  // NOT run a second copy (it would re-run incomplete steps and orphan rows).
  if (!beginRun(runId)) {
    log.warn("Duplicate pipeline dispatch suppressed — run already executing", { runId });
    const existing = await getPipelineRun(runId);
    return { runId, summary: existing?.resultSummary ?? EMPTY_RUN_SUMMARY };
  }

  const startTime = nowMs();

  await updatePipelineRun(runId, {
    status: "running",
    category: config.category,
    config,
    startedAt: now(),
  });

  try {
    const model = config.model ?? "claude-sonnet-4-6";
    const smart = loadConfig().pipelines.ideas.smart;
    const sigeConfig = loadConfig().sige;
    const taste = smart.taste;
    const rotationSeed = rotationSeedFromRunId(runId);

    // ── Outcome-memory: build a shared Mem0 client + ideasUserId ONCE, gated
    //    so neither hook constructs anything when both flags are OFF (default).
    const outcomeMemoryCfg = smart.outcomeMemory;
    const ideasUserId = sigeConfig?.mem0.ideasUserId ?? "sige-ideas";
    const outcomeMem0: Mem0Client | null =
      outcomeMemoryCfg.readAtSynthesis || outcomeMemoryCfg.writeBack
        ? new Mem0Client({
            baseUrl: sigeConfig?.mem0.baseUrl ?? "http://127.0.0.1:8050",
            apiToken: sigeConfig?.mem0.apiToken,
          })
        : null;

    // ── PHASE 4 (taste loop): LEARNED GIANT axis weights (gated calibrate-
    //    GiantWeights, default OFF). loadGiantWeights re-checks the flag and
    //    returns NEUTRAL (= GIANT_DEFAULT_WEIGHTS) when off / under-powered /
    //    on error, so the default path keeps the rubric spine untouched.
    const giantCalibration = await loadGiantWeights();
    const effectiveGiant: GiantConfig = giantCalibration.neutral
      ? smart.giant
      : { ...smart.giant, weights: { ...giantCalibration.weights } };
    if (!giantCalibration.neutral) {
      log.info("Phase 4 taste: applying learned GIANT axis weights", {
        effectiveLabelCount: giantCalibration.effectiveLabelCount,
        weights: giantCalibration.weights,
      });
    }

    // ── #4 part2: Load source-credibility posteriors (graceful, [] when no
    //    feedback). Used to bias collection ordering when adaptiveCollection is on.
    const credibilityPosteriors = smart.adaptiveCollection
      ? await loadCredibilityPosteriors()
      : new Map<string, number>();
    if (credibilityPosteriors.size > 0) {
      log.info("Loaded source-credibility posteriors", { keys: credibilityPosteriors.size });
    }

    // ── Pre-collectors: load consumed signals for all capability source tables ─
    const capabilityTables = [
      "ph_products",
      "hn_stories",
      "github_repos",
      "reddit_posts",
      "news_articles",
      "x_scraped_tweets",
    ] as const;

    const consumedEntries = await Promise.all(
      capabilityTables.map(async (table) => [table, await getConsumedIds(table)] as const),
    );
    const collectorCtx: CollectorContext = {
      consumed: new Map(consumedEntries),
      selected: new Map(),
      credibilityPosteriors,
    };

    // ── Step 1: Analyze app landscape ───────────────────────────────────────
    const trends = await runStep(
      runId,
      "landscape",
      () => analyzeAppLandscape(model, collectorCtx),
      (t) =>
        `${t.trendingCategories.length} underserved categories identified from ${t.summary.split("\n").length} data points${t.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Step 2: Cluster reviews (complaints + praises) ────────────────────
    const focusCategories =
      trends.trendingCategories.length > 0
        ? trends.trendingCategories.map((c) => c.category)
        : undefined;

    const pains = await runStep(
      runId,
      "reviews",
      () => clusterReviews(focusCategories, model, collectorCtx),
      (p) =>
        `${p.clusters.length} review clusters across ${[...new Set(p.clusters.map((c) => c.category))].length} categories (complaints + praises)${p.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Step 3: Scan capabilities ─────────────────────────────────────────
    const capabilities = await runStep(
      runId,
      "capabilities",
      () => scanCapabilities(model, collectorCtx),
      (c) =>
        `${c.capabilities.length} capabilities from PH, HN, GitHub, Reddit, News, X${c.insights ? " (with LLM insights)" : ""}`,
    );

    // B7 — merge selected IDs from each collector's result into a single map.
    const mergedSelected = new Map<string, string[]>();
    const mergeIntoSelected = (ids?: ReadonlyMap<string, readonly string[]>): void => {
      if (!ids) return;
      for (const [table, tableIds] of ids) {
        const existing = mergedSelected.get(table) ?? [];
        mergedSelected.set(table, [...existing, ...tableIds]);
      }
    };
    mergeIntoSelected(trends.selectedIds);
    mergeIntoSelected(pains.selectedIds);
    mergeIntoSelected(capabilities.selectedIds);

    // ── Guard: short-circuit if no fresh source data ──────────────────────
    if (
      capabilities.capabilities.length === 0 &&
      trends.trendingCategories.length === 0 &&
      pains.clusters.length === 0
    ) {
      const [lcCheck, rvCheck, cpCheck] = await Promise.all([
        findCompletedStep(runId, "landscape"),
        findCompletedStep(runId, "reviews"),
        findCompletedStep(runId, "capabilities"),
      ]);
      const hasCollectorCheckpoints =
        lcCheck.hasOutput || rvCheck.hasOutput || cpCheck.hasOutput;

      if (hasCollectorCheckpoints) {
        const reason =
          "Resume replay produced empty collectors despite completed checkpoints — replay failure";
        log.error("Resume hollow-success guard triggered — failing run", { runId, reason });
        await markRunFailed(runId, reason);
        throw new Error(reason);
      }

      log.warn(
        "No fresh source data available — all sources already consumed. Skipping synthesis.",
        { runId },
      );

      const summary: PipelineResultSummary = {
        totalSourcesQueried: 8,
        totalSignalsFound: 0,
        totalIdeasGenerated: 0,
        totalIdeasKept: 0,
        totalIdeasDuplicate: 0,
        topThemes: [],
        ideaIds: [],
        durationMs: nowMs() - startTime,
      };

      await updatePipelineRun(runId, { status: "completed", resultSummary: summary, finishedAt: now() });
      return { runId, summary };
    }

    // ── Demotion guard (default-OFF): when autonomous SIGE is the primary idea ─
    if (smart.sigeAuto.enabled) {
      log.info(
        "Pipeline demoted to signal collector (smart.sigeAuto.enabled=true) — skipping synthesis",
        { runId },
      );
      const demotedSummary: PipelineResultSummary = {
        totalSourcesQueried: 8,
        totalSignalsFound: 0,
        totalIdeasGenerated: 0,
        totalIdeasKept: 0,
        totalIdeasDuplicate: 0,
        topThemes: [],
        ideaIds: [],
        durationMs: nowMs() - startTime,
      };
      await updatePipelineRun(runId, {
        status: "completed",
        resultSummary: demotedSummary,
        finishedAt: now(),
      });
      return { runId, summary: demotedSummary };
    }

    // ── Step 4: Deep search (optional) ────────────────────────────────────
    let deepSearchContext = "";
    if (memoryManager && trends.trendingCategories.length > 0) {
      const searchThemes = trends.trendingCategories
        .slice(0, 6)
        .map((c) => `${c.category} mobile app opportunity`);

      const deepSearchOptions = buildDeepSearchOptions(model, smart, sigeConfig);

      deepSearchContext = await runStep(
        runId,
        "deep_search",
        () => deepSearch(searchThemes, memoryManager, deepSearchOptions),
        (ctx) => {
          const count = (ctx.match(/\[.*?\]/g) ?? []).length;
          return `Found ${count} supporting results for ${searchThemes.length} themes`;
        },
      );
    }

    // ── Step 5: Synthesize ideas at trend intersections ───────────────────
    const saturatedThemes = await buildSaturatedThemes(memoryManager);

    // ── PHASE 4 (taste loop): build exemplar blocks ───────────────────────
    const scoredRows =
      taste.syntheticGolden || taste.antiExemplars ? await fetchScoredIdeaRows() : [];
    const tasteBlocks = buildTasteBlocks(scoredRows, taste, rotationSeed);

    const validatedExemplars = taste.syntheticGolden
      ? tasteBlocks.goldenBlock
      : buildValidatedExemplars(await fetchValidatedExemplars());
    const antiExemplars = tasteBlocks.antiBlock;

    log.info("Phase 4 taste: exemplar blocks built", {
      scoredPool: scoredRows.length,
      golden: tasteBlocks.goldenCount,
      syntheticGolden: tasteBlocks.syntheticGoldenCount,
      anti: tasteBlocks.antiCount,
      rotationSeed,
      antiExemplarsOn: taste.antiExemplars,
      syntheticGoldenOn: taste.syntheticGolden,
    });

    // ── PHASE 1 (generate-wide): SIGE divergent pool merge (flag-gated) ──────
    const generateWide = smart.generateWide;
    const signalsContext = buildSignalsContext({
      trendsSummary: trends.summary,
      painsSummary: pains.summary,
      capabilitiesSummary: capabilities.summary,
      deepSearchContext,
    });
    const extraCandidates = await fetchDivergentCandidates(generateWide, signalsContext, model);

    // ── Outcome-memory READ hook (gated readAtSynthesis, default OFF) ─────────
    const outcomeMemory: string =
      outcomeMemoryCfg.readAtSynthesis && outcomeMem0 !== null
        ? await fetchOutcomeMemoryBlock({
            mem0: outcomeMem0,
            userId: ideasUserId,
            query: [
              ...trends.trendingCategories.slice(0, 6).map((c) => c.category),
              config.category,
            ]
              .filter(Boolean)
              .join(", "),
            reinforceCap: outcomeMemoryCfg.reinforceCap,
            avoidCap: outcomeMemoryCfg.avoidCap,
            searchLimit: outcomeMemoryCfg.searchLimit,
          })
        : "";

    const synthesis = await runStep(
      runId,
      "synthesis",
      () =>
        synthesizeFromTrends({
          trends,
          pains,
          capabilities,
          deepSearchContext,
          saturatedThemes,
          validatedExemplars,
          antiExemplars,
          category: config.category,
          maxIdeas: config.maxIdeas,
          model,
          extraCandidates,
          outcomeMemory,
        }),
      (s) =>
        `Generated ${s.totalGenerated} idea candidates from trend intersections` +
        (extraCandidates.length > 0 ? ` (incl. ${extraCandidates.length} SIGE-divergent)` : ""),
    );

    // ── Step 6: Validate (3-layer dedup: exact + fuzzy + semantic) ────────
    let kept = synthesis.candidates;
    let dedupRejected: readonly string[] = [];

    const poolBeforeDedup = kept.length;
    if (kept.length > 0) {
      const dedupResult = await checkForDuplicates(kept, memoryManager);
      kept = dedupResult.kept;
      dedupRejected = dedupResult.rejected;
    }
    log.info("generate-wide: dedup pool sizes", {
      generated: synthesis.totalGenerated,
      beforeDedup: poolBeforeDedup,
      afterDedup: kept.length,
      semanticDupes: dedupRejected.length,
      sigeDivergentMerged: extraCandidates.length,
    });

    // ── PHASE 1 (generate-wide): originality annotation (after dedup) ───────
    if (kept.length > 0) {
      try {
        const annotated = await annotateOriginality(kept, memoryManager, { agentId: AGENT_ID });
        kept = annotated;
        const withPriorArt = annotated.filter((c) => c.nearestProduct !== undefined).length;
        log.info("generate-wide: originality annotated", { candidates: annotated.length, withPriorArt });
      } catch (err) {
        log.warn("Originality annotation failed — proceeding unannotated", { err });
      }
    }

    // ── #8 part3: Chain-of-evidence verification ──────────────────────────
    let groundingByTitle: ReadonlyMap<string, number> = new Map();
    let evidenceNotes: readonly string[] = [];
    if (smart.chainOfEvidence && kept.length > 0) {
      const verification = verifyEvidence(kept, capabilities.capabilities);
      kept = verification.kept;
      groundingByTitle = verification.groundingByTitle;
      evidenceNotes = verification.notes;
      if (evidenceNotes.length > 0) {
        log.info("Chain-of-evidence verification dropped/penalized citations", {
          notes: evidenceNotes.length,
        });
      }
    }

    // ── #7 / PHASE 3: SIGE-hardened valuation gate (DEFAULT OFF) ──────────────
    let sigeSignals: ReadonlyMap<string, SigeSignals> = new Map();
    let sigeOn = false;
    let convergenceVetoed: boolean | undefined;
    if (smart.sigeValuation && sigeConfig?.enabled && kept.length > 0) {
      sigeOn = true;
      const hardened = await applySigeValuation(
        kept,
        sigeConfig,
        smart.sige,
        deepSearchContext,
        capabilities.capabilities,
      );
      kept = hardened.candidates;
      sigeSignals = hardened.signalsByTitle;

      try {
        kept = await annotateOriginality(kept, memoryManager, { agentId: AGENT_ID });
      } catch (err) {
        log.warn("SIGE: re-annotation of originality failed — proceeding", { err });
      }

      const veto = computeSigeConvergenceVeto(sigeSignals, smart.sige.convergenceVetoThreshold);
      convergenceVetoed = veto.vetoed;
      if (veto.vetoed) {
        const widen = smart.sige.convergenceVetoAction === "widen";
        log.warn("SIGE convergence veto fired — consensus is collapse-prone", {
          reasons: veto.reasons,
          convergenceRate: Number(veto.convergenceRate.toFixed(3)),
          diversityIndex: Number(veto.diversityIndex.toFixed(3)),
          action: widen ? "widen (discarding collapsed consensus)" : "log",
        });
        if (widen) {
          sigeSignals = new Map();
        }
      } else {
        log.info("SIGE convergence health OK", {
          convergenceRate: Number(veto.convergenceRate.toFixed(3)),
          diversityIndex: Number(veto.diversityIndex.toFixed(3)),
        });
      }
    }

    // ── PHASE 2 (demand-side grounding): cited demand enrichment + rescore ──
    const demandByCandidate = new Map<GeneratedIdeaCandidate, DemandArtifact>();
    if (smart.demand.enabled && kept.length > 0) {
      try {
        const demandCfg = buildEnrichDemandConfig(smart.demand);
        const rescored: GeneratedIdeaCandidate[] = [];
        for (const candidate of kept) {
          const artifact = await enrichDemand(
            toDemandCandidateText(candidate),
            DEFAULT_DEMAND_PROBES,
            demandCfg,
          );
          const next = applyDemandRescore(candidate, artifact, effectiveGiant);
          demandByCandidate.set(next, artifact);
          rescored.push(next);
        }
        kept = rescored;

        const coverage = summarizeDemandCoverage(kept, demandByCandidate);
        log.info("Phase 2 demand grounding: coverage", {
          candidates: coverage.total,
          cited: coverage.cited,
          citedShare: Number(coverage.citedShare.toFixed(2)),
          meanDemandScore: Number(coverage.meanDemandScore.toFixed(2)),
          meanWhitespace: Number(coverage.meanWhitespace.toFixed(2)),
        });
      } catch (err) {
        log.warn("Demand enrichment failed — keeping un-enriched candidates", { err });
        demandByCandidate.clear();
      }
    }

    // ── PHASE 0 (GIANT): shadow-mode hard-gate evaluation ──────────────────
    const giantGateByCandidate = new Map<GeneratedIdeaCandidate, CandidateGiantGate>();
    let giantSurvivors = kept;

    if (smart.giant.enabled && kept.length > 0) {
      try {
        const enforceGiantGates = smart.giant.enforceGates === true;
        let wouldKillCount = 0;

        for (const candidate of kept) {
          const gate = evaluateCandidateGiantGate(candidate, effectiveGiant);
          giantGateByCandidate.set(candidate, gate);

          if (gate.gated) {
            wouldKillCount += 1;
            log.info(
              enforceGiantGates
                ? "GIANT shadow gate: idea KILLED (enforced)"
                : "GIANT shadow gate: idea WOULD-KILL (shadow mode, kept)",
              { title: candidate.title, composite: gate.composite, gateReasons: gate.gateReasons },
            );
          }
        }

        if (enforceGiantGates) {
          giantSurvivors = kept.filter((c) => giantGateByCandidate.get(c)?.gated !== true);
        }

        log.info("GIANT shadow gate summary", {
          evaluated: kept.length,
          wouldKill: wouldKillCount,
          enforceGates: enforceGiantGates,
          dropped: kept.length - giantSurvivors.length,
        });
      } catch (err) {
        log.warn("GIANT shadow gate evaluation failed — keeping all candidates", { err });
        giantSurvivors = kept;
      }
    }

    const qualityFiltered = giantSurvivors.filter((c) => c.qualityScore >= config.minQualityScore);

    // ── PHASE 1/3: final selection (Pareto when SIGE on, else novelty-reserve) ──
    let finalSelected: readonly GeneratedIdeaCandidate[] = qualityFiltered;
    if (qualityFiltered.length > config.maxIdeas) {
      if (sigeOn) {
        const paretoSelected = paretoSelect(
          qualityFiltered,
          sigeSignals,
          config.maxIdeas,
          smart.sige.dissentWeight,
        );
        finalSelected = enforceSegmentSpread(paretoSelected, config.maxIdeas);
        log.info("SIGE Pareto selection applied", {
          pool: qualityFiltered.length,
          selected: finalSelected.length,
          maxIdeas: config.maxIdeas,
          dissentWeight: smart.sige.dissentWeight,
        });
      } else {
        const reserved = selectWithNoveltyReserve(qualityFiltered, config.maxIdeas);
        finalSelected = enforceSegmentSpread(reserved, config.maxIdeas);
      }
    }

    const spread = summarizeSegmentSpread(finalSelected);
    log.info("generate-wide: final selection spread", {
      poolAfterGiant: qualityFiltered.length,
      selected: finalSelected.length,
      maxIdeas: config.maxIdeas,
      dominantSegment: spread.dominantSegment,
      dominantShare: Number(spread.dominantShare.toFixed(2)),
      segmentsSignalled: spread.signalled,
      counts: spread.counts,
    });

    await runStep(
      runId,
      "validate",
      async () => ({
        kept: finalSelected.length,
        semanticDupes: dedupRejected.length,
        belowThreshold: giantSurvivors.length - qualityFiltered.length,
        giantGated: kept.length - giantSurvivors.length,
        fabricatedDropped: evidenceNotes.length,
      }),
      (r) =>
        `${r.kept} kept, ${r.semanticDupes} semantic duplicates, ${r.belowThreshold} below threshold, ${r.giantGated} GIANT-gated, ${r.fabricatedDropped} evidence-flagged`,
    );

    // ── Step 7: Store ideas ───────────────────────────────────────────────
    const runLevelProvenance: readonly ProvenanceEntry[] = [
      ...mergedSelected.entries(),
    ].flatMap(([table, selectedIds]) => selectedIds.map((id) => ({ table, id })));

    const ideaIds = await runStep(
      runId,
      "store",
      async () => {
        // Resume-safety: clear any ideas already attached to this run so the
        // deterministic finalSelected set is re-stored exactly once.
        await getDb()`DELETE FROM generated_ideas WHERE pipeline_run_id = ${runId}`;

        const { ids, storedPairs } = await runStorePhase({
          runId,
          finalSelected,
          capabilities: capabilities.capabilities,
          runLevelProvenance,
          groundingByTitle,
          demandByCandidate,
          giantGateByCandidate,
          sigeSignals,
          memoryManager,
          giantEnabled: smart.giant.enabled,
          effectiveGiantConfig: effectiveGiant,
          promptVersion: PROMPT_VERSION,
          model,
          pipelineCategory: config.category,
        });

        // ── PHASE 4 (taste loop): AUTO-PROXY LABELS ──────────────────────
        let proxyLabels: readonly import("./feedback-bootstrap").ProxyLabel[] = [];
        if (taste.autoProxyLabels && storedPairs.length > 0) {
          proxyLabels = await runProxyLabelPhase({
            storedPairs,
            demandByCandidate,
            giantGateByCandidate,
            convergenceVetoed,
            runId,
            promptVersion: PROMPT_VERSION,
            model,
          });
        }

        // ── Outcome-memory WRITE hook ─────────────────────────────────────
        if (outcomeMemoryCfg.writeBack && storedPairs.length > 0 && outcomeMem0 !== null) {
          await runOutcomeMemoryWriteBack({
            storedPairs,
            dedupRejected,
            proxyLabels,
            demandByCandidate,
            giantGateByCandidate,
            sigeSignals,
            convergenceVetoed,
            outcomeMem0,
            ideasUserId,
            runId,
            promptVersion: PROMPT_VERSION,
            model,
            createdAtSec: now(),
          });
        }

        return ids;
      },
      (ids) => `Stored ${ids.length} ideas`,
    );

    // ── Mark consumed signals ─────────────────────────────────────────────
    for (const [table, ids] of mergedSelected) {
      await markConsumed(runId, table, ids);
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    const summary: PipelineResultSummary = {
      totalSourcesQueried: 8,
      totalSignalsFound:
        trends.risingApps.length + pains.clusters.length + capabilities.capabilities.length,
      totalIdeasGenerated: synthesis.totalGenerated,
      totalIdeasKept: ideaIds.length,
      totalIdeasDuplicate: dedupRejected.length,
      topThemes: trends.trendingCategories.slice(0, 10).map((c) => c.category),
      ideaIds,
      durationMs: nowMs() - startTime,
    };

    await updatePipelineRun(runId, { status: "completed", resultSummary: summary, finishedAt: now() });

    log.info("Pipeline run complete", {
      runId,
      ideasGenerated: synthesis.totalGenerated,
      ideasKept: ideaIds.length,
      durationMs: summary.durationMs,
    });

    return { runId, summary };
  } catch (err) {
    log.error("Pipeline run failed", { runId, error: err });
    await updatePipelineRun(runId, {
      status: "failed",
      error: sanitizeError(err),
      finishedAt: now(),
    });
    throw err;
  } finally {
    endRun(runId);
  }
}
