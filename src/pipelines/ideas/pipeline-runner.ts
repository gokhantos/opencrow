/**
 * Async sub-phase runners for the ideas pipeline.
 *
 * Contains the impure orchestration helpers that call into SIGE / LLM services:
 *   - applySigeValuation: SIGE expert game + read-back union + independent jury
 *   - runIndependentJury: cross-family anonymized jury scoring
 *   - fetchDivergentCandidates: SIGE divergent-persona pool generation
 *   - runStorePhase: idea insertion + per-idea stamp + memory indexing
 *   - runPostStorePhases: auto-proxy labels + outcome-memory write-back
 * Extracted from pipeline.ts to keep that file under the 800-line ceiling.
 */

import type { GenerateWideConfig, SigeConfig, SigeHardeningConfig } from "../../config/schema";
import { createLogger } from "../../logger";
import type { MemoryManager } from "../../memory/types";
import { getAllModelRoutes } from "../../store/model-routing";
import {
  createPipelineStep,
  findCompletedStep,
  touchPipelineStep,
  updatePipelineStep,
} from "../store";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import { DEFAULT_SIGE_SESSION_CONFIG, generateDivergentIdeas } from "../../sige/run";
import type { CandidateEvaluation, CandidateIdea } from "../../sige/simulation/expert-game";
import { evaluateCandidates } from "../../sige/simulation/expert-game";
import { insertIdea, insertIdeaFeedback } from "../../sources/ideas/store";
import { candidateCompetabilityPersisted } from "./competability";
import { aggregateGiant } from "./giant";
import type { GiantAxisScores } from "./giant";
import { anonymizeCandidates, fuseJury, type JuryVerdict, judgeWithJury } from "./jury";
import {
  deletePriorOutcomeMemories,
  toOutcomeMemory,
  renderOutcomeSentence,
  writeOutcomeMemories,
  type OutcomeMemoryItem,
} from "./outcome-memory";
import { ABSENCE_CONFIDENCE_CAP } from "./demand";
import { enqueueValidatedIdea } from "./deferred-outcome-store";
import { Neo4jWriteClient } from "../../sige/knowledge/neo4j-write-client";
import {
  appendOutcomeEvents,
  buildSeedOutcomeEvents,
  loadRunSeeds,
  projectLearnedWeights,
  recomputeSeedWeights,
  type IdeaVerdict,
} from "./graph-outcome-feedback";
import {
  buildIdeaProvenance,
  candidateHasDemandEvidence,
  demandProvenanceEntries,
  evaluateCandidateGiantGate as evaluateCandidateGiantGateLocal,
  stampIdeaAllMeta,
  toScoredIdeaForProxy,
  type CandidateGiantGate,
  type ProvenanceEntry,
} from "./pipeline-stamps";
import {
  buildJuryPanel,
  candidateJoinId,
  combineGiantScores,
  expertToQuality,
  isGiantAxisScores,
  mapDivergentToCandidate,
  mapEvolvedEvaluation,
  normalizeDissent,
  qualityToExpert,
  remapSignals,
  resolveCandidateSegment,
  synthesizeEnrichedSeed,
  type SigeHardenedResult,
  type SigeSignals,
} from "./pipeline-sige-math";
import { DEFAULT_PROXY_OPTIONS, deriveProxyLabels } from "./feedback-bootstrap";
import { compositeToQualityScore, signalCitationToken } from "./synthesizer";
import type { Capability, GeneratedIdeaCandidate } from "./types";
import { verifyEvidence } from "./validate";

const log = createLogger("pipeline:ideas");

const AGENT_ID = "idea-pipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline step helpers (shared with orchestrator)
// ─────────────────────────────────────────────────────────────────────────────

export function nowMs(): number {
  return Date.now();
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgresql:\/\/[^\s]+/gi, "[redacted]")
    .replace(/\/Users\/[^\s]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[redacted]")
    .slice(0, 500);
}

const DEFAULT_STEP_DEADLINE_MS = 12 * 60 * 1000; // 12 minutes

export async function runStep<T>(
  runId: string,
  stepName: string,
  work: () => Promise<T>,
  formatOutput: (result: T) => string,
  deadlineMs: number = DEFAULT_STEP_DEADLINE_MS,
): Promise<T> {
  // Resume fast-path: if this step already completed (a prior process run that
  // was interrupted by a restart) and its structured output was persisted,
  // replay it WITHOUT re-running work() — no re-scrape, no re-consume, no LLM
  // spend. A missing/unparseable payload falls through to a normal re-run.
  const cached = await findCompletedStep(runId, stepName);
  if (cached.found && cached.hasOutput) {
    log.info("Resuming pipeline step from checkpoint", { runId, stepName });
    return cached.outputJson as T;
  }

  // Step is created 'running' with an initial heartbeat; keep it fresh while
  // work() is in flight. Errors from a heartbeat tick must never disturb the
  // step itself, and the timer is unref'd so it can't hold the process open.
  const step = await createPipelineStep({ runId, stepName });
  const heartbeat = setInterval(() => {
    void touchPipelineStep(step.id).catch((err) => {
      log.warn("Step heartbeat failed", { runId, stepName, error: sanitizeError(err) });
    });
  }, 10_000);
  (heartbeat as { unref?: () => void }).unref?.();

  const start = nowMs();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    // Race work() against a hard deadline. If the deadline fires first we reject
    // with a descriptive error so the catch below marks the step 'failed' and
    // re-throws — the run's outer catch then sets the run 'failed' (resumable /
    // reaper-eligible). The underlying hung promise/socket may leak until process
    // restart; that is acceptable (funnel is freed).
    const workPromise = work();
    workPromise.catch(() => {});
    const result = await Promise.race([
      workPromise,
      new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new Error(`Step exceeded deadline (${deadlineMs}ms): ${stepName}`));
        }, deadlineMs);
        (deadlineTimer as { unref?: () => void }).unref?.();
      }),
    ]);
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
  } finally {
    clearInterval(heartbeat);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — a defensive view over the extended CandidateEvaluation
// ─────────────────────────────────────────────────────────────────────────────

interface SigeEvalView {
  readonly title: string;
  readonly expertScore: number;
  readonly description?: string;
  readonly giantScores?: GiantAxisScores;
  readonly evidenceRef?: readonly string[];
  readonly dissent?: number;
  readonly origin?: "seed" | "evolved";
}

function readEvaluation(ev: CandidateEvaluation): SigeEvalView {
  const raw = ev as CandidateEvaluation & {
    readonly description?: unknown;
    readonly giantScores?: unknown;
    readonly evidenceRef?: unknown;
    readonly dissent?: unknown;
    readonly origin?: unknown;
  };
  const giantScores = isGiantAxisScores(raw.giantScores) ? raw.giantScores : undefined;
  const evidenceRef = Array.isArray(raw.evidenceRef)
    ? raw.evidenceRef.filter((e): e is string => typeof e === "string")
    : undefined;
  const origin = raw.origin === "evolved" || raw.origin === "seed" ? raw.origin : undefined;
  return {
    title: ev.title,
    expertScore: ev.expertScore,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(giantScores !== undefined ? { giantScores } : {}),
    ...(evidenceRef !== undefined && evidenceRef.length > 0 ? { evidenceRef } : {}),
    ...(typeof raw.dissent === "number" && Number.isFinite(raw.dissent)
      ? { dissent: raw.dissent }
      : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — independent jury runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 3 — Run the INDEPENDENT cross-family jury over the (post-union) survivors
 * and combine its GIANT judgment with SIGE's self-grade. Anonymizes candidates
 * (provenance stripped) before judging and joins verdicts back by a STABLE id so
 * the read-back is reliable. An EMPTY jury (no provider key) is a graceful
 * fall-back: the native SIGE expertScore is kept (scores are NEVER zeroed). The
 * combined GIANT re-derives qualityScore; dissent + agreement are surfaced into
 * the side-band signals. Mutates the passed `signals` map in place with the new
 * jury fields (the map is pipeline-internal scratch). Never throws.
 */
async function runIndependentJury(
  candidates: readonly GeneratedIdeaCandidate[],
  signals: Map<GeneratedIdeaCandidate, SigeSignals>,
): Promise<{ readonly candidates: readonly GeneratedIdeaCandidate[] }> {
  try {
    // Model-routing is the source of truth for the three judge slots: read the
    // `sige.judge.0/1/2` routes (DB-backed, hot reloaded per run) instead of the
    // static `sigeHardening.judgeModels` config default. The `judgeModels` schema
    // field is kept for backward compat but no longer drives the runtime panel.
    const routes = await getAllModelRoutes();
    const judgeModels = [routes["sige.judge.0"], routes["sige.judge.1"], routes["sige.judge.2"]];
    const panel = buildJuryPanel(judgeModels);

    const rawCands = candidates.map((c) => ({
      id: candidateJoinId(c.title),
      title: c.title,
      description: c.summary,
    }));
    const juryRaw = await judgeWithJury(anonymizeCandidates(rawCands), panel);

    if (juryRaw.length === 0) {
      log.info("SIGE jury: no judge available — keeping native SIGE scores");
      return { candidates };
    }

    const verdicts = fuseJury(juryRaw);
    const verdictById = new Map<string, JuryVerdict>();
    for (const v of verdicts) verdictById.set(v.candidateId, v);

    const combined = candidates.map((c) => {
      const verdict = verdictById.get(candidateJoinId(c.title));
      if (verdict === undefined) return c;

      const prior = signals.get(c);
      const sigeGiant = prior?.giantScores ?? c.giant;
      const mergedGiant = combineGiantScores(sigeGiant, verdict.giantScores);

      const composite =
        mergedGiant !== undefined ? aggregateGiant(mergedGiant, {}).composite : verdict.juryScore;

      const dissentNorm = normalizeDissent(verdict.dissent);

      signals.set(c, {
        expertScore: prior?.expertScore ?? qualityToExpert(c.qualityScore),
        juryScore: verdict.juryScore,
        juryAgreement: verdict.juryAgreement,
        dissent: dissentNorm,
        judgeCount: verdict.judgeCount,
        ...(prior?.evolved ? { evolved: true } : {}),
        ...(mergedGiant !== undefined ? { giantScores: mergedGiant } : {}),
      });

      return {
        ...c,
        qualityScore: compositeToQualityScore(composite),
        ...(mergedGiant !== undefined ? { giant: mergedGiant } : {}),
      };
    });

    log.info("SIGE independent jury fused", {
      judges: juryRaw.length,
      verdicts: verdicts.length,
      meanAgreement: Number(
        (verdicts.reduce((s, v) => s + v.juryAgreement, 0) / Math.max(verdicts.length, 1)).toFixed(
          2,
        ),
      ),
    });

    return { candidates: combined };
  } catch (err) {
    log.warn("SIGE jury failed — keeping native SIGE scores", { err });
    return { candidates };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — SIGE valuation entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #7 / PHASE 3 — Route survivors through the SIGE expert game, then HARDEN the
 * result against sycophancy collapse:
 *
 *   1. READ-BACK UNION — SIGE Round-3 may EVOLVE/RECOMBINE children (titles not
 *      in the input pool). The old title-join silently dropped them; we now
 *      UNION them back as origin "sige-evolved" candidates and re-bind each via
 *      verifyEvidence so a child that cannot be re-grounded is hard-penalized.
 *   2. INDEPENDENT JURY — when smart.sige.independentJudge is on, an anonymized,
 *      position-switched cross-family jury scores every survivor's GIANT axes.
 *      The jury is the anti-sycophancy CHECK on SIGE's self-grade: the combined
 *      GIANT (SIGE × jury) re-derives qualityScore. No jury key ⇒ graceful
 *      fall-back to the native SIGE expertScore (scores are never zeroed).
 *   3. FIRST-CLASS DISSENT — jury dissent + agreement are surfaced into the
 *      side-band signals (consumed by Pareto/Bradley-Terry), never averaged away.
 *
 * EXPENSIVE: multi-agent SIGE calls + one LLM call per available judge over the
 * whole batch. Caller must already have checked smart.sigeValuation +
 * config.sige.enabled. Wrapped so any SIGE/jury failure degrades to the
 * unchanged critique-scored candidates (never throws).
 */
export async function applySigeValuation(
  candidates: readonly GeneratedIdeaCandidate[],
  sigeConfig: SigeConfig,
  sigeHardening: SigeHardeningConfig,
  deepSearchContext: string,
  capabilities: readonly Capability[],
): Promise<SigeHardenedResult> {
  const passthrough: SigeHardenedResult = {
    candidates,
    signalsByTitle: new Map(),
  };

  try {
    const sigeCandidates: CandidateIdea[] = candidates.map((c) => ({
      title: c.title,
      summary: c.summary,
      description: c.reasoning,
      expertScore: qualityToExpert(c.qualityScore),
    }));

    const enrichedSeed =
      deepSearchContext.trim().length > 0 ? deepSearchContext : synthesizeEnrichedSeed(candidates);

    const evaluations = await evaluateCandidates(sigeCandidates, {
      mem0: new Mem0Client({
        baseUrl: sigeConfig.mem0.baseUrl,
        apiToken: sigeConfig.mem0.apiToken,
      }),
      userId: sigeConfig.mem0.userId,
      enrichedSeed,
    });

    const views = evaluations.map(readEvaluation);

    const inputIds = new Set(candidates.map((c) => candidateJoinId(c.title)));
    const viewByJoinId = new Map<string, SigeEvalView>();
    for (const view of views) {
      viewByJoinId.set(candidateJoinId(view.title), view);
    }

    const evolvedViews = views.filter((v) =>
      v.origin !== undefined ? v.origin === "evolved" : !inputIds.has(candidateJoinId(v.title)),
    );

    let evolvedCandidates: readonly GeneratedIdeaCandidate[] = [];
    if (evolvedViews.length > 0) {
      const mapped = evolvedViews.map(mapEvolvedEvaluation);
      const verified = verifyEvidence(mapped, capabilities);
      evolvedCandidates = verified.kept.map((child) => {
        const grounding = verified.groundingByTitle.get(child.title);
        const penalized =
          grounding === undefined || grounding <= 0
            ? Math.max(1, child.qualityScore * 0.5)
            : child.qualityScore;
        return penalized === child.qualityScore ? child : { ...child, qualityScore: penalized };
      });
      log.info("SIGE read-back: unioned evolved children", {
        evolved: evolvedViews.length,
        keptAfterRebind: evolvedCandidates.length,
      });
    }

    const seedRescored = candidates.map((c) => {
      const view = viewByJoinId.get(candidateJoinId(c.title));
      if (view === undefined) return c;
      const next: GeneratedIdeaCandidate = {
        ...c,
        qualityScore: expertToQuality(view.expertScore),
        ...(view.giantScores !== undefined ? { giant: view.giantScores } : {}),
      };
      return next;
    });

    const unioned: readonly GeneratedIdeaCandidate[] = [...seedRescored, ...evolvedCandidates];

    const signals = new Map<GeneratedIdeaCandidate, SigeSignals>();
    for (const c of seedRescored) {
      const view = viewByJoinId.get(candidateJoinId(c.title));
      signals.set(c, {
        expertScore: view?.expertScore ?? qualityToExpert(c.qualityScore),
        ...(view?.giantScores !== undefined ? { giantScores: view.giantScores } : {}),
        ...(view?.dissent !== undefined ? { dissent: view.dissent } : {}),
      });
    }
    for (const c of evolvedCandidates) {
      const view = viewByJoinId.get(candidateJoinId(c.title));
      signals.set(c, {
        expertScore: view?.expertScore ?? qualityToExpert(c.qualityScore),
        evolved: true,
        ...(view?.giantScores !== undefined ? { giantScores: view.giantScores } : {}),
        ...(view?.dissent !== undefined ? { dissent: view.dissent } : {}),
      });
    }

    let rescored = unioned;
    if (sigeHardening.independentJudge && unioned.length > 0) {
      const juryResult = await runIndependentJury(unioned, signals);
      rescored = juryResult.candidates;
    }

    log.info("SIGE valuation applied (hardened)", {
      candidates: candidates.length,
      evaluated: evaluations.length,
      evolvedUnioned: evolvedCandidates.length,
      jury: sigeHardening.independentJudge,
    });

    return {
      candidates: rescored,
      signalsByTitle: remapSignals(signals),
    };
  } catch (err) {
    log.warn("SIGE valuation failed — keeping critique scores", { err });
    return passthrough;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 (generate-wide) — divergent candidate fetcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 1 (generate-wide) — Flag-gated SIGE divergent generation. When
 * sigeDivergent is OFF (default) returns [] (no-op, no SIGE call). When ON, runs
 * the divergent personas over the run's grounded signals and maps the results to
 * candidates for the synthesizer pool. generateDivergentIdeas NEVER throws (it
 * returns [] on failure) but we still wrap defensively so enabling this optional
 * widening path can never break the run. Capped at maxCandidates.
 */
export async function fetchDivergentCandidates(
  generateWide: GenerateWideConfig,
  signalsContext: string,
  model: string,
): Promise<readonly GeneratedIdeaCandidate[]> {
  if (!generateWide.sigeDivergent) return [];

  try {
    const divergent = await generateDivergentIdeas(signalsContext, {
      maxCandidates: generateWide.maxCandidates,
      config: { ...DEFAULT_SIGE_SESSION_CONFIG, model, agentModel: model },
    });
    const mapped = divergent
      .filter((d) => d.title.trim().length > 0)
      .map((d) => mapDivergentToCandidate(d))
      .slice(0, generateWide.maxCandidates);
    log.info("SIGE divergent pool generated", {
      raw: divergent.length,
      merged: mapped.length,
    });
    return mapped;
  } catch (err) {
    log.warn("SIGE divergent generation failed — merging no divergent ideas", { err });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Store phase
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredIdeaPair {
  readonly ideaId: string;
  readonly candidate: GeneratedIdeaCandidate;
}

/**
 * #step "store" — Insert the final selected candidates into generated_ideas,
 * stamp all optional metadata in a single DB round-trip, and index into
 * memory. Returns the list of stored idea IDs plus the (id, candidate) pairs
 * used by the post-store proxy-label and outcome-memory hooks.
 */
export async function runStorePhase(params: {
  readonly runId: string;
  readonly finalSelected: readonly GeneratedIdeaCandidate[];
  readonly capabilities: readonly Capability[];
  readonly runLevelProvenance: readonly ProvenanceEntry[];
  readonly groundingByTitle: ReadonlyMap<string, number>;
  /** Keyed by candidateJoinId(title), NOT object reference — survives transforms. */
  readonly demandByCandidate: ReadonlyMap<string, import("./demand").DemandArtifact>;
  readonly giantGateByCandidate: ReadonlyMap<GeneratedIdeaCandidate, CandidateGiantGate>;
  readonly sigeSignals: ReadonlyMap<string, SigeSignals>;
  readonly memoryManager: MemoryManager | null | undefined;
  readonly giantEnabled: boolean;
  readonly effectiveGiantConfig: import("../../config/schema").GiantConfig;
  readonly promptVersion: string;
  readonly model: string;
  readonly pipelineCategory: string;
}): Promise<{ readonly ids: readonly string[]; readonly storedPairs: readonly StoredIdeaPair[] }> {
  const {
    runId,
    finalSelected,
    capabilities,
    runLevelProvenance,
    groundingByTitle,
    demandByCandidate,
    giantGateByCandidate,
    sigeSignals,
    memoryManager,
    giantEnabled,
    effectiveGiantConfig,
    promptVersion,
    model,
    pipelineCategory,
  } = params;

  const ids: string[] = [];
  const storedPairs: StoredIdeaPair[] = [];

  for (const candidate of finalSelected) {
    try {
      const sourceLinksText =
        candidate.sourceLinks?.length > 0
          ? candidate.sourceLinks.map((l) => `- [${l.title}](${l.url}) (${l.source})`).join("\n")
          : "";

      const reasoning = [
        "## Trend Intersection",
        candidate.trendIntersection || "",
        "",
        "## Analysis",
        candidate.reasoning,
        "",
        "## Design & UX",
        candidate.designDescription || "Not specified.",
        "",
        "## Monetization",
        candidate.monetizationDetail || candidate.revenueModel,
        "",
        "## Details",
        `**Target Audience:** ${candidate.targetAudience}`,
        `**Key Features:** ${candidate.keyFeatures.join(", ")}`,
        ...(sourceLinksText ? ["", "## Sources", sourceLinksText] : []),
      ].join("\n");

      const baseProvenance = buildIdeaProvenance(
        candidate,
        capabilities,
        runLevelProvenance,
        signalCitationToken,
      );

      const demandArtifact = demandByCandidate.get(candidateJoinId(candidate.title));
      const demandProvenance = demandArtifact ? demandProvenanceEntries(demandArtifact) : [];
      const provenanceSeen = new Set(baseProvenance.map((e) => `${e.table}:${e.id}`));
      const ideaProvenance: readonly ProvenanceEntry[] = [
        ...baseProvenance,
        ...demandProvenance.filter((e) => !provenanceSeen.has(`${e.table}:${e.id}`)),
      ];

      const competabilityPersisted = candidateCompetabilityPersisted(candidate);

      const idea = await insertIdea({
        agent_id: AGENT_ID,
        title: candidate.title,
        summary: candidate.summary,
        reasoning,
        sources_used: candidate.sourcesUsed,
        category: candidate.category || pipelineCategory,
        quality_score: Math.min(Math.max(candidate.qualityScore, 1), 5),
        pipeline_run_id: runId,
        source_ids_json: JSON.stringify(ideaProvenance),
        competability_overall: competabilityPersisted?.overall ?? null,
        competability_json: competabilityPersisted,
      });

      const giantGateForIdea =
        giantEnabled && candidate.giant !== undefined
          ? {
              candidate,
              gate:
                giantGateByCandidate.get(candidate) ??
                evaluateCandidateGiantGateLocal(candidate, effectiveGiantConfig),
            }
          : undefined;

      await stampIdeaAllMeta(
        idea.id,
        {
          promptVersion,
          model,
          signalGrounding: groundingByTitle.get(candidate.title),
          critiqueSubscores: candidate.critiqueSubscores,
        },
        giantGateForIdea,
        {
          artifact: demandByCandidate.get(candidateJoinId(candidate.title)),
          segment: resolveCandidateSegment(candidate),
        },
        sigeSignals.get(candidateJoinId(candidate.title)),
      );

      if (memoryManager) {
        try {
          await memoryManager.indexIdea(AGENT_ID, {
            id: idea.id,
            title: candidate.title,
            summary: candidate.summary,
            category: candidate.category || pipelineCategory,
            reasoning: candidate.reasoning,
          });
        } catch {
          // non-fatal
        }
      }

      ids.push(idea.id);
      storedPairs.push({ ideaId: idea.id, candidate });
    } catch (err) {
      log.warn("Failed to save idea", { title: candidate.title, err });
    }
  }

  return { ids, storedPairs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-store phases (proxy labels + outcome-memory write-back)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 4 (taste loop) — AUTO-PROXY LABELS (gated autoProxyLabels).
 * Seed the cold calibration loop with cheap bootstrap labels. Returns the
 * derived proxy-label list (lifted so the outcome-memory write hook can read
 * the same labels). Never throws.
 */
export async function runProxyLabelPhase(params: {
  readonly storedPairs: readonly StoredIdeaPair[];
  /** Keyed by candidateJoinId(title), NOT object reference — survives transforms. */
  readonly demandByCandidate: ReadonlyMap<string, import("./demand").DemandArtifact>;
  readonly giantGateByCandidate: ReadonlyMap<GeneratedIdeaCandidate, CandidateGiantGate>;
  readonly convergenceVetoed: boolean | undefined;
  readonly runId: string;
  readonly promptVersion: string;
  readonly model: string;
}): Promise<readonly import("./feedback-bootstrap").ProxyLabel[]> {
  const {
    storedPairs,
    demandByCandidate,
    giantGateByCandidate,
    convergenceVetoed,
    runId,
    promptVersion,
    model,
  } = params;

  try {
    const proxyInputs = storedPairs.map(({ ideaId, candidate }) =>
      toScoredIdeaForProxy({
        ideaId,
        candidate,
        gate: giantGateByCandidate.get(candidate),
        artifact: demandByCandidate.get(candidateJoinId(candidate.title)),
        grounded:
          candidateHasDemandEvidence(candidate) ||
          (demandByCandidate.get(candidateJoinId(candidate.title))?.evidence.length ?? 0) > 0,
        ...(convergenceVetoed !== undefined ? { convergenceVeto: convergenceVetoed } : {}),
      }),
    );

    const proxyLabels = deriveProxyLabels(proxyInputs, DEFAULT_PROXY_OPTIONS, runId);
    let written = 0;
    for (const label of proxyLabels) {
      const row = await insertIdeaFeedback({
        ...label.event,
        actor: `proxy:${label.reason}`,
        run_id: runId,
        prompt_version: promptVersion,
        model,
      });
      if (row !== null) written += 1;
    }
    log.info("Phase 4 taste: auto-proxy labels written", {
      candidates: proxyInputs.length,
      derived: proxyLabels.length,
      written,
    });
    return proxyLabels;
  } catch (err) {
    log.warn("Phase 4 taste: auto-proxy labeling failed — skipping", { err });
    return [];
  }
}

/**
 * Outcome-memory WRITE hook (gated writeBack, default OFF).
 * Write one memory per stored idea (+ one per dedup-rejected title) back to
 * mem0. Placed AFTER persistence + proxy-labels (the verdict map is complete).
 * Never throws.
 */
export async function runOutcomeMemoryWriteBack(params: {
  readonly storedPairs: readonly StoredIdeaPair[];
  readonly dedupRejected: readonly string[];
  readonly proxyLabels: readonly import("./feedback-bootstrap").ProxyLabel[];
  /** Keyed by candidateJoinId(title), NOT object reference — survives transforms. */
  readonly demandByCandidate: ReadonlyMap<string, import("./demand").DemandArtifact>;
  readonly giantGateByCandidate: ReadonlyMap<GeneratedIdeaCandidate, CandidateGiantGate>;
  readonly sigeSignals: ReadonlyMap<string, SigeSignals>;
  readonly convergenceVetoed: boolean | null | undefined;
  readonly outcomeMem0: Mem0Client;
  readonly ideasUserId: string;
  readonly runId: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly createdAtSec: number;
  /**
   * Write stored-pending / verdictSource:"none" memories (no real verdict yet).
   * Default false: these dilute recall with un-adjudicated ideas, so skip them.
   * dedup-rejected writes are unaffected (they carry a real "avoid" signal).
   */
  readonly writePendingMemories?: boolean;
  /**
   * Before writing a real verdict for an ideaId, delete its prior outcome
   * memories so a re-run SUPERSEDES rather than duplicates. Default true.
   */
  readonly supersedePriorOnRerun?: boolean;
  /**
   * Deferred outcome re-probe enqueue (Phase 2). Absent / enabled:false → no rows
   * enqueued (byte-identical). When enabled, a proxy-VALIDATED idea whose
   * validation-time demand snapshot CLEARED the absence floor is enqueued for a
   * demand re-probe `delayDays` later. `createdAtSec` is the validation timestamp.
   */
  readonly reprobe?: { readonly enabled: boolean; readonly delayDays: number };
  /**
   * Graph outcome feedback (Phase 3). Absent / enabled:false → no Postgres/Neo4j
   * writes (byte-identical). When enabled, the run's AGGREGATE gold/reprobe verdict
   * is attributed back to the seeds that fed it (loaded from graph_seed_exposure),
   * appended to the immutable event log, the decayed weights re-materialized, and —
   * when projectToNeo4j and a neo4j connection are present — projected onto the live
   * graph via a WRITE client. Best-effort: never breaks the run.
   */
  readonly graphFeedback?: {
    readonly enabled: boolean;
    readonly projectToNeo4j: boolean;
    readonly validatedWeight: number;
    readonly killedWeight: number;
    readonly weightHalfLifeDays: number;
    readonly maxSeedWeight: number;
    readonly neo4j: {
      readonly boltUrl: string;
      readonly user: string;
      readonly queryTimeoutMs: number;
    } | null;
  };
}): Promise<void> {
  const {
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
    promptVersion,
    model,
    createdAtSec,
    writePendingMemories = false,
    supersedePriorOnRerun = true,
    reprobe,
    graphFeedback,
  } = params;

  try {
    const proxyVerdictMap = new Map<
      string,
      { readonly verdict: "validated" | "archived"; readonly verdictSource: string }
    >();
    for (const label of proxyLabels) {
      const kind = label.event.kind;
      if (kind === "validated" || kind === "archived") {
        proxyVerdictMap.set(label.event.idea_id, {
          verdict: kind,
          verdictSource: `proxy:${label.reason}`,
        });
      }
    }

    const outcomeContext = { runId, promptVersion, model, createdAtSec };
    const items: OutcomeMemoryItem[] = [];
    // Real-verdict ideaIds whose prior memories should be superseded before write.
    const supersedeIds: string[] = [];

    for (const { ideaId, candidate } of storedPairs) {
      const proxyVerdict = proxyVerdictMap.get(ideaId);
      // No real (proxy) verdict yet → "stored-pending". Skip writing it unless
      // writePendingMemories is on: pending memories carry no adjudicated signal
      // and only dilute recall.
      if (!proxyVerdict && !writePendingMemories) continue;
      const outcomeVerdict = proxyVerdict ?? {
        verdict: "stored-pending" as const,
        verdictSource: "none",
      };
      if (proxyVerdict) supersedeIds.push(ideaId);

      const gate = giantGateByCandidate.get(candidate);
      const artifact = demandByCandidate.get(candidateJoinId(candidate.title));
      const sigeSignal = sigeSignals.get(candidateJoinId(candidate.title));

      const memory = toOutcomeMemory(
        {
          ideaId,
          segment: resolveCandidateSegment(candidate),
          archetype: candidate.archetype ?? null,
          giantComposite: candidate.giantComposite ?? null,
          // Fold the candidate's competability/moat slice into the memory so the
          // verdict learns moat ↔ outcome. The GeneratedIdeaCandidate's
          // competability* fields ARE the CandidateCompetabilityFields shape.
          competability: candidate.competability,
          competabilityOverall: candidate.competabilityOverall,
          competabilityGated: candidate.competabilityGated,
          competabilityReason: candidate.competabilityReason,
          competabilityRaw: candidate.competabilityRaw,
          competabilityRawOverall: candidate.competabilityRawOverall,
          competabilityMatchedExpertiseDomain: candidate.competabilityMatchedExpertiseDomain,
        },
        outcomeVerdict,
        {
          gate: gate ?? null,
          sigeDissent: sigeSignal?.dissent ?? null,
          convergenceVeto: convergenceVetoed ?? null,
          demand: artifact ?? null,
        },
        outcomeContext,
      );

      items.push({ sentence: renderOutcomeSentence(memory, candidate.title), metadata: memory });

      // ── Deferred re-probe enqueue (gated, Phase 2) ───────────────────────────
      // A proxy-VALIDATED idea is a SELF-GRADE; enqueue it to re-probe real demand
      // after delayDays and supersede the proxy verdict with ground truth. ONLY
      // when the validation-time demand snapshot cleared the absence floor —
      // otherwise the re-probe diff would always be inconclusive (both at floor).
      if (
        reprobe?.enabled &&
        proxyVerdict?.verdict === "validated" &&
        artifact &&
        artifact.confidence > ABSENCE_CONFIDENCE_CAP
      ) {
        const dueAt = createdAtSec + reprobe.delayDays * 86_400;
        await enqueueValidatedIdea({
          ideaId,
          title: candidate.title,
          segment: resolveCandidateSegment(candidate),
          archetype: candidate.archetype ?? null,
          validationSource: proxyVerdict.verdictSource,
          validatedAt: createdAtSec,
          baselineDemand: artifact,
          dueAt,
        });
      }
    }

    for (const rejected of dedupRejected) {
      const bareTitle = rejected.split(" [")[0] ?? rejected;
      const memory = toOutcomeMemory(
        { ideaId: null, segment: null, archetype: null, giantComposite: null },
        { verdict: "dedup-rejected", verdictSource: "dedup" },
        { gate: null, sigeDissent: null, convergenceVeto: null, demand: null },
        outcomeContext,
      );
      items.push({ sentence: renderOutcomeSentence(memory, bareTitle), metadata: memory });
    }

    // Supersede prior memories for re-adjudicated ideas BEFORE writing the fresh
    // verdict, so a re-run replaces rather than duplicates. Best-effort: each
    // delete swallows its own failures (deletePriorOutcomeMemories never throws).
    let superseded = 0;
    if (supersedePriorOnRerun) {
      for (const ideaId of supersedeIds) {
        superseded += await deletePriorOutcomeMemories(outcomeMem0, ideasUserId, ideaId);
      }
    }

    await writeOutcomeMemories(outcomeMem0, items, ideasUserId);
    log.info("Outcome-memory write-back complete", {
      stored: storedPairs.length,
      dedupRejected: dedupRejected.length,
      total: items.length,
      superseded,
      userId: ideasUserId,
    });
  } catch (err) {
    log.warn("Outcome-memory write-back failed — skipping", { err });
  }

  // ── Graph outcome feedback write-back (gated, Phase 3) ─────────────────────
  // Attribute the run's AGGREGATE gold/reprobe verdict back to the seeds that fed
  // it. SAME-run verdicts are proxy-tier and so are filtered out by
  // buildSeedOutcomeEvents (the event log stays near-empty until a human/reprobe
  // verdict lands); this still records exposure-driven recompute + projection so
  // the loop is wired end-to-end. Independent best-effort block — a failure here
  // never affects the mem0 write above or the run.
  if (graphFeedback?.enabled) {
    let graphWriteClient: Neo4jWriteClient | null = null;
    try {
      // Build the run's per-idea verdict map from the proxy labels (archived →
      // "killed"). Re-derived here (the map inside the try-block above is out of
      // scope). Only gold/reprobe-tier verdicts survive the trust filter inside the
      // builder — same-run proxy verdicts are excluded by design.
      const verdictMap = new Map<string, IdeaVerdict>();
      for (const label of proxyLabels) {
        const kind = label.event.kind;
        if (kind !== "validated" && kind !== "archived") continue;
        verdictMap.set(label.event.idea_id, {
          verdict: kind === "validated" ? "validated" : "killed",
          verdictSource: `proxy:${label.reason}`,
        });
      }

      const runSeeds = await loadRunSeeds(runId);
      const events = buildSeedOutcomeEvents({
        runId,
        verdictMap,
        runSeeds,
        config: {
          validatedWeight: graphFeedback.validatedWeight,
          killedWeight: graphFeedback.killedWeight,
          maxSeedWeight: graphFeedback.maxSeedWeight,
        },
        createdAtSec,
      });

      await appendOutcomeEvents(events);
      await recomputeSeedWeights({
        now: createdAtSec,
        halfLifeDays: graphFeedback.weightHalfLifeDays,
      });

      // Project onto the live graph only when enabled AND a connection is present.
      if (graphFeedback.projectToNeo4j && graphFeedback.neo4j) {
        graphWriteClient = new Neo4jWriteClient(graphFeedback.neo4j);
        await graphWriteClient.upsertSeedOutcomeEdges(
          events.map((e) => ({
            seedName: e.seedName,
            runId: e.runId,
            verdict: e.verdict,
            weight: e.weight,
            createdAtSec: e.createdAtSec,
          })),
        );
        await projectLearnedWeights(graphWriteClient);
      }

      log.info("Graph outcome feedback write-back complete", {
        runId,
        seeds: runSeeds.length,
        events: events.length,
        projected: graphFeedback.projectToNeo4j && graphFeedback.neo4j !== null,
      });
    } catch (err) {
      log.warn("Graph outcome feedback write-back failed — skipping", { err });
    } finally {
      if (graphWriteClient) await graphWriteClient.close().catch(() => {});
    }
  }
}
