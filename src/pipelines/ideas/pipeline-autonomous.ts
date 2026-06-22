/**
 * Autonomous SIGE Pipeline.
 *
 * Top-level entry point for a fully seedless, autonomously-scheduled run.
 * Matches the {@link PipelineDispatcher} signature so it can be swapped in
 * place of {@link runIdeasPipeline} anywhere a pipeline is dispatched.
 *
 * Flow:
 *   discovery (frontier-discovery) → deep game(s) → merge candidates →
 *   EXISTING back-half (dedup → demand → GIANT → selectWithNoveltyReserve →
 *   enforceSegmentSpread → store → generated_ideas table)
 *
 * Default-OFF invariant: this module is only reached when
 * `smart.sigeAuto.enabled` is true (via the scheduler or the explicit route).
 * With the default config nothing calls this function.
 */

import { loadConfig } from "../../config/loader";
import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import type { MemoryManager } from "../../memory/types";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import type { BroadCorpus } from "../../sige/discovery/frontier-discovery";
import { discoverFrontiers } from "../../sige/discovery/frontier-discovery";
import { generateDivergentIdeas } from "../../sige/run";
import { acquireSigeRunSlot } from "../../sige/auto/run-guard";
import { getDb } from "../../store/db";
import { getModelRoute } from "../../store/model-routing";
import {
  createPipelineStep,
  findCompletedStep,
  updatePipelineRun,
  updatePipelineStep,
} from "../store";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import { resolveGeneratorRoute } from "./generator-route";
import type { CollectorContext } from "./collectors";
import { analyzeAppLandscape, clusterReviews, scanCapabilities } from "./collectors";
import { getConsumedIds, markConsumed } from "./consumption";
import { DEFAULT_DEMAND_PROBES, enrichDemand } from "./demand-probes";
import { selectWithNoveltyReserve } from "./generate-wide";
import { selectDiverseBy } from "./idea-diversity";
import { loadGiantWeights } from "./feedback-bootstrap";
import type { GiantConfig } from "../../config/schema";
import { insertIdea } from "../../sources/ideas/store";
import {
  buildRecallQuery,
  fetchOutcomeMemoryBlock,
  renderOutcomeSentence,
  toOutcomeMemory,
  writeOutcomeMemories,
  type OutcomeMemoryItem,
} from "./outcome-memory";
import { annotateOriginality, checkForDuplicates, verifyEvidence } from "./validate";
import {
  applyDemandRescore,
  buildEnrichDemandConfig,
  enforceSegmentSpread,
  evaluateCandidateGiantGate,
  mapDivergentToCandidate,
  mergeSigeCandidates,
  summarizeDemandCoverage,
  toDemandCandidateText,
} from "./pipeline";
import type { PipelineRunResult } from "./pipeline";
import { candidateJoinId, resolveCandidateSegment } from "./pipeline-sige-math";
import type { GeneratedIdeaCandidate } from "./types";

export const AUTONOMOUS_SIGE_PIPELINE_ID = "autonomous-sige";

const log = createLogger("pipeline:autonomous");

const AGENT_ID = "autonomous-sige-pipeline";

/** Prompt provenance stamped on outcome memories written from this pipeline. */
const PROMPT_VERSION = "autonomous-sige-v1";

/** Wall-clock ceiling for a single autonomous pipeline run (mirrors sige/run.ts). */
const RUN_TIMEOUT_MS = 90 * 60 * 1_000;

function nowMs(): number {
  return Date.now();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgresql:\/\/[^\s]+/gi, "[redacted]")
    .replace(/\/Users\/[^\s]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[redacted]")
    .slice(0, 500);
}

async function runStep<T>(
  runId: string,
  stepName: string,
  work: () => Promise<T>,
  formatOutput: (result: T) => string,
): Promise<T> {
  const cached = await findCompletedStep(runId, stepName);
  if (cached.found && cached.hasOutput) {
    log.info("Resuming autonomous pipeline step from checkpoint", { runId, stepName });
    return cached.outputJson as T;
  }

  const step = await createPipelineStep({ runId, stepName });
  const start = nowMs();
  try {
    const result = await work();
    await updatePipelineStep(step.id, {
      status: "completed",
      outputSummary: formatOutput(result),
      outputJson: result,
      durationMs: nowMs() - start,
    });
    return result;
  } catch (err) {
    await updatePipelineStep(step.id, {
      status: "failed",
      error: sanitizeError(err),
      durationMs: nowMs() - start,
    });
    throw err;
  }
}

/**
 * Run the full autonomous SIGE pipeline.
 *
 * Matches {@link PipelineDispatcher} so it can be used in resume.ts and the
 * explicit POST /pipelines/autonomous-sige/run route.
 */
export async function runAutonomousSige(
  _pipelineId: string,
  config: PipelineConfig,
  runId: string,
  memoryManager?: MemoryManager | null,
): Promise<PipelineRunResult> {
  const startTime = nowMs();

  await updatePipelineRun(runId, {
    status: "running",
    category: config.category,
    config,
    startedAt: now(),
  });

  // FIX 3 — Single-flight slot: prevent concurrent autonomous pipeline runs.
  // acquireSigeRunSlot uses pg_try_advisory_lock (non-blocking) so a second
  // caller (route OR resume path) returns immediately rather than queuing.
  const slot = await acquireSigeRunSlot(1);
  if (!slot.acquired) {
    log.warn("runAutonomousSige: another run holds the slot — skipping", { runId });
    const summary = buildEmptySummary(nowMs() - startTime);
    await updatePipelineRun(runId, {
      status: "completed",
      resultSummary: {
        ...summary,
        topThemes: ["busy — another autonomous SIGE run holds the slot"],
      },
      finishedAt: now(),
    });
    return { runId, summary };
  }

  // FIX 3 — Per-run wall-clock timeout: abort a stuck run after 90 minutes.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
    log.warn("runAutonomousSige: wall-clock timeout reached (90 min)", { runId });
  }, RUN_TIMEOUT_MS);
  const runSignal = timeoutController.signal;

  try {
    const appConfig = loadConfig();
    const smart = appConfig.pipelines.ideas.smart;
    const sigeAutoConfig = smart.sigeAuto;
    const sigeConfig = appConfig.sige;

    if (!sigeConfig?.enabled) {
      log.warn("runAutonomousSige: sige.enabled is false — completing early", { runId });
      const summary = buildEmptySummary(nowMs() - startTime);
      await updatePipelineRun(runId, {
        status: "completed",
        resultSummary: summary,
        finishedAt: now(),
      });
      return { runId, summary };
    }

    const mem0 = new Mem0Client({
      baseUrl: sigeConfig.mem0.baseUrl,
      apiToken: sigeConfig.mem0.apiToken,
    });
    const userId = sigeConfig.mem0.userId;
    // Collectors run on the dashboard-controlled `pipeline.generator` route
    // (model + provider as a coupled pair — see resolveGeneratorRoute). No
    // hardcoded model: a bare config.model would mismatch the route provider.
    const { model, provider } = resolveGeneratorRoute(
      config,
      await getModelRoute("pipeline.generator"),
    );

    // ── Outcome-memory parity with the seeded pipeline ────────────────────────
    // Read past verdicts at synthesis (gated readAtSynthesis) and write fresh
    // ones post-persist (gated writeBack). Both default OFF: when off the SIGE
    // graph client (`mem0`) is reused for nothing here and no extra mem0 call is
    // made, so the autonomous call-graph is byte-identical to before.
    const outcomeMemoryCfg = smart.outcomeMemory;
    const ideasUserId = sigeConfig.mem0.ideasUserId;

    // ── GIANT axis weights (calibrated when enabled; neutral otherwise) ─────────
    const giantCalibration = await loadGiantWeights();
    const effectiveGiant: GiantConfig = giantCalibration.neutral
      ? smart.giant
      : { ...smart.giant, weights: { ...giantCalibration.weights } };

    // ── Pre-collectors: consumed-signal bookkeeping ───────────────────────────
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
      credibilityPosteriors: new Map(),
    };

    // ── Step: collectors (discovery corpus) ──────────────────────────────────
    const [trends, pains, capabilities] = await Promise.all([
      runStep(
        runId,
        "landscape",
        () => analyzeAppLandscape(model, collectorCtx, provider),
        (t) => `${t.trendingCategories.length} trend categories`,
      ).catch((err) => {
        log.warn("autonomous: landscape collector failed", { runId, err: getErrorMessage(err) });
        return { trendingCategories: [], risingApps: [], summary: "" };
      }),
      runStep(
        runId,
        "reviews",
        () => clusterReviews(undefined, model, collectorCtx, provider),
        (p) => `${p.clusters.length} review clusters`,
      ).catch((err) => {
        log.warn("autonomous: reviews collector failed", { runId, err: getErrorMessage(err) });
        return { clusters: [], summary: "" };
      }),
      runStep(
        runId,
        "capabilities",
        () => scanCapabilities(model, collectorCtx, provider),
        (c) => `${c.capabilities.length} capabilities`,
      ).catch((err) => {
        log.warn("autonomous: capabilities collector failed", { runId, err: getErrorMessage(err) });
        return { capabilities: [], summary: "" };
      }),
    ]);

    const corpus: BroadCorpus = { trends, pains, capabilities };

    // ── Outcome-memory READ hook (gated readAtSynthesis, default OFF) ─────────
    // Mirror the seeded pipeline: pull past validated/archived/dedup verdicts as
    // a fenced GUIDANCE block and prepend it to each frontier's seedText so the
    // divergent (synthesis-equivalent) pass leans toward proven rigor and away
    // from archived patterns. When OFF this is "" → seedText is byte-identical.
    const outcomeMemory: string = outcomeMemoryCfg.readAtSynthesis
      ? await fetchOutcomeMemoryBlock({
          mem0,
          userId: ideasUserId,
          // Direction-keyed recall: pain-cluster themes lead, trending
          // categories next, configured category last. pains.clusters is
          // populated in the BroadCorpus path (defaults to [] on collector
          // failure), so buildRecallQuery still yields a non-empty query from
          // trendingCategories+category — never regressing recall to empty.
          query: buildRecallQuery({
            painThemes: pains.clusters.slice(0, 6).map((cluster) => cluster.theme),
            trendingCategories: trends.trendingCategories.slice(0, 6).map((cat) => cat.category),
            category: config.category,
          }),
          reinforceCap: outcomeMemoryCfg.reinforceCap,
          avoidCap: outcomeMemoryCfg.avoidCap,
          searchLimit: outcomeMemoryCfg.searchLimit,
          // Relevance/recency-aware selection (gated by config; no-op values
          // degrade to legacy first-N).
          rank: {
            now: now(),
            halfLifeDays: outcomeMemoryCfg.halfLifeDays,
            stalePromptPenalty: outcomeMemoryCfg.stalePromptPenalty,
            mmrLambda: outcomeMemoryCfg.mmrLambda,
            currentPromptVersion: PROMPT_VERSION,
            currentModel: model,
          },
        }).catch(() => "")
      : "";

    // ── Step: discovery ───────────────────────────────────────────────────────
    const discovery = await runStep(
      runId,
      "discovery",
      () =>
        discoverFrontiers(corpus, mem0, {
          broadPoolSize: sigeAutoConfig.broadPoolSize,
          broadFrontierCap: sigeAutoConfig.broadFrontierCap,
          maxDeepFrontiers: sigeAutoConfig.maxDeepFrontiers,
          userId,
          signal: runSignal,
        }),
      (d) => `${d.frontiers.length} frontiers from ${d.candidates.length} broad candidates`,
    );

    if (discovery.frontiers.length === 0 && discovery.candidates.length === 0) {
      log.warn("autonomous: empty discovery — no frontiers or broad pool", { runId });
      const summary = buildEmptySummary(nowMs() - startTime);
      await updatePipelineRun(runId, {
        status: "completed",
        resultSummary: summary,
        finishedAt: now(),
      });
      return { runId, summary };
    }

    // ── Step: deep game(s) per top frontier ──────────────────────────────────
    //
    // PHASE C PLACEHOLDER — second-pass divergent generation only.
    //
    // The spec (section 10, steps 3-4) describes this step as a full expert game
    // (`runExpertGame` / `runSocialSimulation` / `fuseScores`) producing `ScoredIdea[]`
    // that `mapDeepGameRankedToCandidate` maps into pre-scored candidates.
    //
    // Phase C ships a CHEAPER approximation: a second round of `generateDivergentIdeas`
    // scoped to the frontier's seedText. This adds frontier-specific signal without
    // the full 45-minute per-frontier game cost. The output is UNSCORED (qualityScore=0)
    // exactly like the broad discovery pool — the GIANT back-half sets real scores.
    //
    // Phase D will integrate `runExpertGame` per frontier and call
    // `mapDeepGameRankedToCandidate` on its `rankedIdeas`, producing true expert-game
    // valuation for the depth stage. Until then, the depth stage and breadth stage
    // provide equivalent signal quality; the value is the frontier's scoped seedText.
    // Select a DIVERSE subset of frontiers to deep-develop. Sort by score desc
    // first, then apply selectDiverseBy to cap any single theme at 50% of the
    // selected set — prevents one-theme monoculture when maxDeepFrontiers > 1.
    const topFrontiers = selectDiverseBy(
      [...discovery.frontiers].sort((a, b) => b.score - a.score),
      {
        maxIdeas: sigeAutoConfig.maxDeepFrontiers,
        maxBucketShare: 0.5,
        resolveBucket: (f) => f.theme,
      },
    );
    const deepCandidates: GeneratedIdeaCandidate[] = [];

    for (let i = 0; i < topFrontiers.length; i++) {
      const frontier = topFrontiers[i]!;
      const stepName = `sige_game_${i}`;

      const frontierCandidates = await runStep(
        runId,
        stepName,
        async () => {
          // Prepend the outcome-memory GUIDANCE block (empty when the flag is
          // OFF → seedText unchanged). The block is already untrusted-fenced and
          // re-sanitized inside fetchOutcomeMemoryBlock.
          const seedText = outcomeMemory
            ? `${outcomeMemory}\n\n${frontier.seedText}`
            : frontier.seedText;
          const divergent = await generateDivergentIdeas(seedText, {
            maxCandidates: sigeAutoConfig.broadPoolSize,
            userId,
            signal: runSignal,
          });
          return divergent.map((d) => mapDivergentToCandidate(d, { sourceTag: "sige-frontier" }));
        },
        (cs) => `${cs.length} candidates from frontier "${frontier.theme}"`,
      ).catch((err) => {
        log.warn("autonomous: frontier deep game failed — skipping", {
          runId,
          theme: frontier.theme,
          err: getErrorMessage(err),
        });
        return [] as GeneratedIdeaCandidate[];
      });

      deepCandidates.push(...frontierCandidates);
    }

    // ── Step: candidates — merge broad pool + deep frontier candidates ────────
    const broadMapped = discovery.candidates.map((d) =>
      mapDivergentToCandidate(d, { sourceTag: "sige-discovery" }),
    );
    const merged = await runStep(
      runId,
      "candidates",
      async () => mergeSigeCandidates(broadMapped, deepCandidates),
      (cs) =>
        `${cs.length} merged candidates (${deepCandidates.length} deep + ${broadMapped.length} broad)`,
    );

    log.info("autonomous: candidate pool built", {
      runId,
      broad: broadMapped.length,
      deep: deepCandidates.length,
      merged: merged.length,
    });

    // ── Back-half: validate ──────────────────────────────────────────────────
    let kept: readonly GeneratedIdeaCandidate[] = merged;
    if (kept.length > 0) {
      const dedupResult = await checkForDuplicates([...kept], memoryManager);
      kept = dedupResult.kept;

      try {
        kept = await annotateOriginality([...kept], memoryManager, { agentId: AGENT_ID });
      } catch (err) {
        log.warn("autonomous: originality annotation failed — proceeding unannotated", { err });
      }

      if (smart.chainOfEvidence) {
        const verification = verifyEvidence([...kept], capabilities.capabilities);
        kept = verification.kept;
      }
    }

    // ── Back-half: demand enrichment ─────────────────────────────────────────
    // Keyed by candidateJoinId(title), NOT object reference — mirrors the seeded
    // pipeline so the artifact survives the GIANT-gate / selection transforms that
    // replace each candidate object. (Autonomous does not yet persist demand_json,
    // so this currently only feeds summarizeDemandCoverage; the stable key keeps it
    // correct if/when a persistence consumer is added — and keeps the map type
    // aligned with summarizeDemandCoverage.)
    const demandByCandidate = new Map<string, Awaited<ReturnType<typeof enrichDemand>>>();
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
          demandByCandidate.set(candidateJoinId(next.title), artifact);
          rescored.push(next);
        }
        kept = rescored;
        const coverage = summarizeDemandCoverage(kept, demandByCandidate);
        log.info("autonomous: demand coverage", {
          runId,
          cited: coverage.cited,
          citedShare: Number(coverage.citedShare.toFixed(2)),
        });
      } catch (err) {
        log.warn("autonomous: demand enrichment failed — proceeding unenriched", { err });
      }
    }

    // ── Back-half: GIANT gate (shadow mode by default) ───────────────────────
    const giantGateByCandidate = new Map<
      GeneratedIdeaCandidate,
      ReturnType<typeof evaluateCandidateGiantGate>
    >();
    let giantSurvivors: readonly GeneratedIdeaCandidate[] = kept;

    if (smart.giant.enabled && kept.length > 0) {
      try {
        const enforceGiantGates = smart.giant.enforceGates === true;
        for (const candidate of kept) {
          const gate = evaluateCandidateGiantGate(candidate, effectiveGiant);
          giantGateByCandidate.set(candidate, gate);
        }
        if (enforceGiantGates) {
          giantSurvivors = kept.filter((c) => giantGateByCandidate.get(c)?.gated !== true);
        }
      } catch (err) {
        log.warn("autonomous: GIANT gate failed — keeping all candidates", { err });
      }
    }

    // Autonomous candidates are emitted with qualityScore=0 by mapDivergentToCandidate
    // (a sentinel: the back-half GIANT critique is the score-setting pass).
    // The quality filter that guards the seeded path would therefore drop EVERY
    // autonomous candidate. Instead we pass giantSurvivors directly, treating
    // evaluateCandidateGiantGate as the only pre-selection gate — consistent with
    // the spec's "back-half Pass-3 GIANT sets real score" design note.
    const preSelected = giantSurvivors;

    log.info("autonomous: GIANT survivors before selection", {
      runId,
      survivors: preSelected.length,
      giantGated: kept.length - giantSurvivors.length,
    });

    // ── Back-half: final selection ────────────────────────────────────────────
    let finalSelected: readonly GeneratedIdeaCandidate[] = preSelected;
    if (preSelected.length > config.maxIdeas) {
      const reserved = selectWithNoveltyReserve(preSelected, config.maxIdeas);
      finalSelected = enforceSegmentSpread(reserved, config.maxIdeas);
    }

    // ── Back-half: store (idempotent) ─────────────────────────────────────────
    // Captured in the OUTER scope so the post-store outcome-memory write hook can
    // pair each persisted id with its source candidate. On a checkpoint RESUME
    // the store step is skipped (cached) and this stays empty → the write hook is
    // a no-op, which is correct (write-back already ran on the first attempt).
    const storedPairs: Array<{
      readonly ideaId: string;
      readonly candidate: GeneratedIdeaCandidate;
    }> = [];
    const ideaIds = await runStep(
      runId,
      "store",
      async () => {
        // Idempotency: clear any partial write from a previous interrupted attempt.
        await getDb()`DELETE FROM generated_ideas WHERE pipeline_run_id = ${runId}`;

        const ids: string[] = [];
        for (const candidate of finalSelected) {
          try {
            const reasoning = [
              candidate.trendIntersection
                ? `## Trend Intersection\n${candidate.trendIntersection}\n\n`
                : "",
              `## Analysis\n${candidate.reasoning}`,
              candidate.designDescription
                ? `\n\n## Design & UX\n${candidate.designDescription}`
                : "",
              candidate.monetizationDetail
                ? `\n\n## Monetization\n${candidate.monetizationDetail}`
                : candidate.revenueModel
                  ? `\n\n## Revenue Model\n${candidate.revenueModel}`
                  : "",
              `\n\n## Details\n**Target Audience:** ${candidate.targetAudience}`,
              `\n**Key Features:** ${candidate.keyFeatures.join(", ")}`,
            ]
              .join("")
              .trim();

            const idea = await insertIdea({
              agent_id: AGENT_ID,
              title: candidate.title,
              summary: candidate.summary,
              reasoning,
              sources_used: candidate.sourcesUsed,
              category: candidate.category || config.category,
              quality_score: Math.min(Math.max(candidate.qualityScore, 1), 5),
              pipeline_run_id: runId,
              source_ids_json: JSON.stringify([]),
            });

            if (memoryManager) {
              try {
                await memoryManager.indexIdea(AGENT_ID, {
                  id: idea.id,
                  title: candidate.title,
                  summary: candidate.summary,
                  category: candidate.category || config.category,
                  reasoning: candidate.reasoning,
                });
              } catch {
                // non-fatal
              }
            }

            ids.push(idea.id);
            storedPairs.push({ ideaId: idea.id, candidate });
          } catch (err) {
            log.warn("autonomous: failed to save idea", {
              title: candidate.title,
              err: getErrorMessage(err),
            });
          }
        }
        return ids;
      },
      (ids) => `Stored ${ids.length} autonomous ideas`,
    );

    // ── Outcome-memory WRITE hook (gated writeBack, default OFF) ──────────────
    // Mirror the seeded pipeline: distil each persisted idea into a neutral
    // "stored-pending" outcome memory so a future synthesis round can retrieve
    // it. Autonomous has no proxy-label pass, so every persisted idea is
    // stored-pending (verdictSource:"none"); the REAL verdicts arrive later via
    // the human PATCH path. Best-effort + own try/catch — a mem0 failure must
    // never fail the run. Titles are routed through renderOutcomeSentence (which
    // sanitizes) and written with enableGraph:false.
    if (outcomeMemoryCfg.writeBack && storedPairs.length > 0) {
      try {
        const createdAtSec = now();
        const items: OutcomeMemoryItem[] = storedPairs.map(({ ideaId, candidate }) => {
          const memory = toOutcomeMemory(
            {
              ideaId,
              segment: resolveCandidateSegment(candidate),
              archetype: candidate.archetype ?? null,
              giantComposite: candidate.giantComposite ?? null,
            },
            { verdict: "stored-pending", verdictSource: "none" },
            { gate: null, sigeDissent: null, convergenceVeto: null, demand: null },
            { runId, promptVersion: PROMPT_VERSION, model, createdAtSec },
          );
          return { sentence: renderOutcomeSentence(memory, candidate.title), metadata: memory };
        });
        await writeOutcomeMemories(mem0, items, ideasUserId);
        log.info("autonomous: outcome-memory write-back complete", {
          runId,
          count: items.length,
          userId: ideasUserId,
        });
      } catch (err) {
        log.warn("autonomous: outcome-memory write-back failed — skipping", {
          runId,
          err: getErrorMessage(err),
        });
      }
    }

    // ── Mark consumed signals ─────────────────────────────────────────────────
    for (const [table, ids] of collectorCtx.selected) {
      await markConsumed(runId, table, ids);
    }

    const durationMs = nowMs() - startTime;
    const summary: PipelineResultSummary = {
      totalSourcesQueried: 6,
      totalSignalsFound: discovery.candidates.length,
      totalIdeasGenerated: merged.length,
      totalIdeasKept: ideaIds.length,
      totalIdeasDuplicate: merged.length - kept.length,
      topThemes: discovery.frontiers.slice(0, 5).map((f) => f.theme),
      ideaIds,
      durationMs,
    };

    await updatePipelineRun(runId, {
      status: "completed",
      resultSummary: summary,
      finishedAt: now(),
    });

    log.info("autonomous SIGE pipeline complete", {
      runId,
      ideasGenerated: merged.length,
      ideasKept: ideaIds.length,
      durationMs,
    });

    return { runId, summary };
  } catch (err) {
    log.error("autonomous SIGE pipeline failed", { runId, error: err });
    await updatePipelineRun(runId, {
      status: "failed",
      error: sanitizeError(err),
      finishedAt: now(),
    });
    throw err;
  } finally {
    clearTimeout(timeoutId);
    await slot.release();
  }
}

function buildEmptySummary(durationMs: number): PipelineResultSummary {
  return {
    totalSourcesQueried: 0,
    totalSignalsFound: 0,
    totalIdeasGenerated: 0,
    totalIdeasKept: 0,
    totalIdeasDuplicate: 0,
    topThemes: [],
    ideaIds: [],
    durationMs,
  };
}
