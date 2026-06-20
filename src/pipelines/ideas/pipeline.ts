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
import { Neo4jReadClient } from "../../sige/knowledge/neo4j-client";
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
import { fetchOutcomeMemoryGuidance } from "./outcome-memory";
import { fetchGraphReasoningDirective } from "./graph-reasoning";
import { selectWithNoveltyReserve } from "./generate-wide";
import { getDb } from "../../store/db";
import { getModelRoute } from "../../store/model-routing";
import { resolveGeneratorRoute } from "./generator-route";
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
import { computeDiversityReport, selectDiverse } from "./idea-diversity";
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

/**
 * Merge a collector's selectedIds into a mutable accumulator map.
 *
 * On a FRESH run `ids` is a real `Map<string, readonly string[]>` (iterable
 * via `for...of`). On a RESUMED run the step output was round-tripped through
 * `JSON.stringify` → JSONB → `JSON.parse`, which silently converts any `Map`
 * to `{}` (Maps do not serialize to JSON). In that case `ids` comes back as a
 * plain `Record<string, string[]>` — an ordinary object whose keys are the
 * table names. This helper normalises both shapes so the caller always gets a
 * correct merge regardless of whether the value is live in-process or was
 * replayed from a persisted checkpoint.
 *
 * Exported so it can be unit-tested without exercising the full pipeline.
 */
export function mergeSelectedIds(
  into: Map<string, string[]>,
  ids: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]> | undefined,
): void {
  if (ids == null) return;
  const entries: Iterable<[string, readonly string[]]> =
    ids instanceof Map ? ids.entries() : (Object.entries(ids) as [string, readonly string[]][]);
  for (const [table, tableIds] of entries) {
    const existing = into.get(table) ?? [];
    into.set(table, [...existing, ...tableIds]);
  }
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

  // Hoisted so the `finally` can release the shared Neo4j driver regardless of
  // where the run exits. Stays null unless graph reasoning is enabled (default).
  let graphClient: Neo4jReadClient | null = null;

  try {
    // Model-routing is the source of truth for the idea generator's provider AND
    // model. CRITICAL: model and provider must be resolved as a COUPLED PAIR
    // from the SAME source — a model id is only valid for its own provider
    // (e.g. `claude-sonnet-4-6` only on `anthropic`, `glm-5.2` only on
    // `alibaba`). Resolving them independently (config.model ?? route.model with
    // config.provider ?? route.provider) can mix a config model with the route's
    // provider and send the model to the wrong API → "Model not exist". So an
    // explicit operator override only applies when BOTH model and provider are
    // set together; otherwise the `pipeline.generator` route (DB-backed, hot
    // reloaded, dashboard-controlled) supplies BOTH. The provider is threaded
    // through the synthesizer generation passes into buildChatOptions so a
    // non-Anthropic route actually dispatches to that provider.
    const { model, provider } = resolveGeneratorRoute(
      config,
      await getModelRoute("pipeline.generator"),
    );
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

    // ── Graph reasoning: build a read-only Neo4j client ONCE, gated on BOTH the
    //    feature flag AND the connection flag so neither alone constructs a
    //    client (and the neo4j-driver import never loads when off — default).
    const graphReasoningCfg = smart.graphReasoning;
    graphClient =
      graphReasoningCfg.enabled && sigeConfig?.neo4j.enabled
        ? new Neo4jReadClient({
            boltUrl: sigeConfig.neo4j.boltUrl,
            user: sigeConfig.neo4j.user,
            queryTimeoutMs: sigeConfig.neo4j.queryTimeoutMs,
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
      () => analyzeAppLandscape(model, collectorCtx, provider),
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
      () => clusterReviews(focusCategories, model, collectorCtx, provider),
      (p) =>
        `${p.clusters.length} review clusters across ${[...new Set(p.clusters.map((c) => c.category))].length} categories (complaints + praises)${p.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Step 3: Scan capabilities ─────────────────────────────────────────
    const capabilities = await runStep(
      runId,
      "capabilities",
      () => scanCapabilities(model, collectorCtx, provider),
      (c) =>
        `${c.capabilities.length} capabilities from PH, HN, GitHub, Reddit, News, X${c.insights ? " (with LLM insights)" : ""}`,
    );

    // B7 — merge selected IDs from each collector's result into a single map.
    // On resume, selectedIds arrives as a plain Record (JSON round-trip erases
    // Map). mergeSelectedIds normalises both shapes — see its JSDoc.
    const mergedSelected = new Map<string, string[]>();
    mergeSelectedIds(mergedSelected, trends.selectedIds);
    mergeSelectedIds(mergedSelected, pains.selectedIds);
    mergeSelectedIds(mergedSelected, capabilities.selectedIds);

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

    // ── Step 4: Deep search (optional) ────────────────────────────────────
    let deepSearchContext = "";
    if (memoryManager && trends.trendingCategories.length > 0) {
      const searchThemes = trends.trendingCategories
        .slice(0, 6)
        .map((c) => `${c.category} mobile app opportunity`);

      const deepSearchOptions = buildDeepSearchOptions(model, smart, sigeConfig, provider);

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

    // ── Outcome-memory READ hook (gated readAtSynthesis, default ON) ──────────
    // ONE mem0 read yields BOTH the Pass-2 REINFORCE/AVOID block (outcomeMemory)
    // and the Pass-1 SEED segment-diversity directive (segmentDirective). Still
    // guarded on outcomeMem0 !== null and returns "" on any failure or when mem0
    // is empty (fetchOutcomeMemoryGuidance never throws), so a run with no learned
    // history is byte-identical to the pre-feature path. rotationSeed (run-id
    // derived) rotates WHICH under-explored segments lead so consecutive runs
    // explore different corners.
    const guidance =
      outcomeMemoryCfg.readAtSynthesis && outcomeMem0 !== null
        ? await fetchOutcomeMemoryGuidance({
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
            rotationSeed,
          })
        : { block: "", segmentDirective: "" };
    const outcomeMemory: string = guidance.block;
    const segmentDirective: string = guidance.segmentDirective;

    // ── Graph-reasoning READ hook (gated on BOTH flags, default OFF) ──────────
    // A single bounded Neo4j traversal → the Pass-1 OPPORTUNITY PATHS directive.
    // Guarded on graphClient !== null and returns "" on any failure / empty
    // graph / timeout (fetchGraphReasoningDirective never throws), so a default
    // run is byte-identical to the pre-feature path.
    const graphDirective: string =
      graphReasoningCfg.enabled && graphClient !== null
        ? await fetchGraphReasoningDirective({
            client: graphClient,
            userId: sigeConfig?.mem0.userId ?? "sige-global",
            maxHops: graphReasoningCfg.maxHops,
            maxPaths: graphReasoningCfg.maxPaths,
            searchLimit: graphReasoningCfg.searchLimit,
            minDegree: graphReasoningCfg.minDegree,
            maxDegree: graphReasoningCfg.maxDegree,
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
          provider,
          extraCandidates,
          outcomeMemory,
          segmentDirective,
          graphDirective,
          // Audit the Pass-3 competability gate against this run, stamped with the
          // shared epoch-seconds `now()` helper (keeps synthesizer clock-free).
          pipelineRunId: runId,
          competabilityDecidedAt: now(),
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

    // ── WITHIN-RUN diversity guard: cap any single archetype/category's share of
    // the kept set so the funnel can't collapse into one monoculture. Soft +
    // anti-starvation: re-orders the already-sized set, never shrinks it. ────────
    const diversityGuard = smart.diversityGuard;
    if (diversityGuard.enabled) {
      finalSelected = selectDiverse(finalSelected, {
        maxIdeas: config.maxIdeas,
        maxBucketShare: diversityGuard.maxBucketShare,
        bucketBy: diversityGuard.bucketBy,
      });
    }
    const diversityReport = computeDiversityReport(finalSelected, {
      bucketBy: diversityGuard.bucketBy,
    });
    log.info("Diversity summary", {
      kept: diversityReport.total,
      bucketBy: diversityReport.bucketBy,
      distinctArchetypes: diversityReport.distinctArchetypes,
      distinctCategories: diversityReport.distinctCategories,
      dominantArchetype: diversityReport.dominantArchetype,
      dominantShare: Number(diversityReport.dominantArchetypeShare.toFixed(2)),
      archetypeEntropy: Number(diversityReport.archetypeEntropy.toFixed(2)),
    });

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

        // ── Outcome-memory WRITE hook (gated writeBack, default ON) ────────
        // Writes one verdict memory per stored idea (+ one per dedup-rejected
        // title) back to mem0 so future synthesis rounds learn from them. Still
        // guarded on outcomeMem0 !== null; runOutcomeMemoryWriteBack is best-effort
        // (writeOutcomeMemories swallows failures), so a down mem0 sidecar no-ops
        // rather than breaking the run.
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
      dominantArchetype: diversityReport.dominantArchetype,
      dominantArchetypeShare: diversityReport.dominantArchetypeShare,
      archetypeEntropy: diversityReport.archetypeEntropy,
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
    // Release the shared Neo4j driver (best-effort, no-op when never connected).
    await graphClient?.close();
    endRun(runId);
  }
}
