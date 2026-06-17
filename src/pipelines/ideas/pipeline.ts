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
 */

import type { AiProvider } from "../../agent/types";
import { loadConfig } from "../../config/loader";
import type {
  DemandConfig,
  GenerateWideConfig,
  GiantConfig,
  SigeConfig,
  SigeHardeningConfig,
  SmartIdeasConfig,
  TasteConfig,
} from "../../config/schema";
import { createLogger } from "../../logger";
import type { MemoryManager } from "../../memory/types";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import type { DivergentCandidate } from "../../sige/run";
import { DEFAULT_SIGE_SESSION_CONFIG, generateDivergentIdeas } from "../../sige/run";
import type { CandidateEvaluation, CandidateIdea } from "../../sige/simulation/expert-game";
import { evaluateCandidates } from "../../sige/simulation/expert-game";
import type { ScoredIdea } from "../../sige/types";
import { getIdeasByStage, insertIdea, insertIdeaFeedback } from "../../sources/ideas/store";
import { getDb } from "../../store/db";
import {
  createPipelineStep,
  findCompletedStep,
  getPipelineRun,
  touchPipelineStep,
  updatePipelineRun,
  updatePipelineStep,
} from "../store";
import { beginRun, endRun } from "../active-runs";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import type { CollectorContext } from "./collectors";
import { analyzeAppLandscape, clusterReviews, scanCapabilities } from "./collectors";
import { getConsumedIds, markConsumed } from "./consumption";
import { credibilityKey, getSourceCredibility } from "./credibility";
import {
  DEMAND_SCORE_MAX,
  type DemandArtifact,
  type DemandCandidateText,
  demandArtifactSchema,
  hasCitedDemand,
} from "./demand";
import type { EnrichDemandConfig } from "./demand-probes";
import { DEFAULT_DEMAND_PROBES, enrichDemand } from "./demand-probes";
import {
  DEFAULT_PROXY_OPTIONS,
  deriveProxyLabels,
  loadGiantWeights,
  parseGiantScores,
  type ScoredIdeaForProxy,
} from "./feedback-bootstrap";
import { selectWithNoveltyReserve } from "./generate-wide";
import type { GiantAxisKey, GiantAxisScores } from "./giant";
import { aggregateGiant, GIANT_AXIS_KEYS } from "./giant";
import {
  anonymizeCandidates,
  DEFAULT_JURY_PANEL,
  fuseJury,
  type JudgeModel,
  type JuryVerdict,
  judgeWithJury,
} from "./jury";
import type { SegmentId } from "./segments";
import { inferSegment, inferSegmentMatch, SEGMENT_IDS } from "./segments";
import {
  bradleyTerryRank,
  type ConvergenceSignal,
  convergenceVeto,
  dissentAdjustedScore,
  type PairwiseWin,
  paretoFrontier,
} from "./sige-select";
import type { DeepSearchOptions, ValidatedExemplar } from "./synthesizer";
import {
  buildValidatedExemplars,
  compositeToQualityScore,
  deepSearch,
  signalCitationToken,
  synthesizeFromTrends,
} from "./synthesizer";
import {
  renderAntiBlock,
  renderGoldenBlock,
  type ScoredIdeaRow,
  selectAntiExemplars,
  selectGoldenExemplars,
} from "./taste";
import type { Capability, GeneratedIdeaCandidate } from "./types";
import { annotateOriginality, checkForDuplicates, verifyEvidence } from "./validate";

const log = createLogger("pipeline:ideas");

const AGENT_ID = "idea-pipeline";

/**
 * Version tag stamped on generated_ideas.prompt_version. Bump when the
 * synthesis/critique prompt structure changes so learning loops can segment
 * outcomes by prompt generation.
 */
const PROMPT_VERSION = "trend-intersection-v2";

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

export interface PipelineRunResult {
  readonly runId: string;
  readonly summary: PipelineResultSummary;
}

/**
 * How often a 'running' step refreshes its liveness heartbeat. A slow step (e.g.
 * synthesis Pass 2 can run several minutes) must keep ticking so a stale-heartbeat
 * check can tell "alive but slow" from "process died mid-step".
 */
const STEP_HEARTBEAT_INTERVAL_MS = 10_000;

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

async function runStep<T>(
  runId: string,
  stepName: string,
  work: () => Promise<T>,
  formatOutput: (result: T) => string,
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
  }, STEP_HEARTBEAT_INTERVAL_MS);
  (heartbeat as { unref?: () => void }).unref?.();

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
  } finally {
    clearInterval(heartbeat);
  }
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "that",
  "this",
  "are",
  "was",
  "be",
  "has",
  "had",
  "have",
  "will",
  "can",
  "do",
  "does",
  "your",
  "you",
  "app",
  "tool",
  "platform",
  "system",
  "based",
  "using",
  "new",
  "smart",
]);

function tokenize(title: string): readonly string[] {
  return title
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length >= 3);
}

/**
 * Bigram/trigram theme extraction over idea rows (fast, no LLM). Exported so the
 * autonomous-SIGE frontier discovery stage (`frontier-discovery.ts`) reuses the
 * SAME n-gram logic for saturation overlap instead of drifting a parallel copy.
 * PURE.
 */
export function extractThemesByNgrams(
  rows: ReadonlyArray<{ readonly title: string; readonly summary: string }>,
): readonly string[] {
  const bigramCounts = new Map<string, string[]>();
  const trigramCounts = new Map<string, string[]>();

  for (const { title } of rows) {
    const tokens = tokenize(title);
    const seen = new Set<string>();

    for (let i = 0; i < tokens.length - 1; i++) {
      const w1 = tokens[i]!;
      const w2 = tokens[i + 1]!;
      if (STOP_WORDS.has(w1) && STOP_WORDS.has(w2)) continue;
      const bigram = `${w1} ${w2}`;
      if (!seen.has(bigram)) {
        seen.add(bigram);
        const list = bigramCounts.get(bigram) ?? [];
        list.push(title);
        bigramCounts.set(bigram, list);
      }
    }

    for (let i = 0; i < tokens.length - 2; i++) {
      const w1 = tokens[i]!;
      const w2 = tokens[i + 1]!;
      const w3 = tokens[i + 2]!;
      if (STOP_WORDS.has(w1) && STOP_WORDS.has(w2) && STOP_WORDS.has(w3)) continue;
      const trigram = `${w1} ${w2} ${w3}`;
      if (!seen.has(trigram)) {
        seen.add(trigram);
        const list = trigramCounts.get(trigram) ?? [];
        list.push(title);
        trigramCounts.set(trigram, list);
      }
    }
  }

  // Build a title → summary lookup for enriched output
  const summaryByTitle = new Map<string, string>();
  for (const { title, summary } of rows) {
    summaryByTitle.set(title, summary);
  }

  const allNgrams: Array<{ readonly phrase: string; readonly hits: readonly string[] }> = [];

  for (const [phrase, hits] of trigramCounts) {
    const unique = [...new Set(hits)];
    if (unique.length >= 2) allNgrams.push({ phrase, hits: unique });
  }

  for (const [phrase, hits] of bigramCounts) {
    const unique = [...new Set(hits)];
    if (unique.length >= 3) allNgrams.push({ phrase, hits: unique });
  }

  allNgrams.sort((a, b) => b.hits.length - a.hits.length);

  const lines: string[] = [];
  for (const { phrase, hits } of allNgrams) {
    const exampleTitle = hits[0] ?? "";
    const exampleSummary = summaryByTitle.get(exampleTitle);
    const note = exampleSummary
      ? ` — e.g. "${exampleTitle}" (${exampleSummary.slice(0, 80).trim()}…)`
      : ` — e.g. ${hits.slice(0, 2).join(", ")}`;
    lines.push(`- "${phrase}" theme (${hits.length} ideas)${note}`);
    if (lines.length >= 15) break;
  }

  return lines;
}

async function extractSemanticThemes(
  rows: ReadonlyArray<{ readonly title: string; readonly summary: string }>,
  memoryManager: MemoryManager,
): Promise<readonly string[]> {
  const lines: string[] = [];

  for (const row of rows) {
    if (lines.length >= 5) break;
    try {
      const results = await memoryManager.search("shared", `${row.title}: ${row.summary}`, {
        limit: 3,
        minScore: 0.7,
        kinds: ["idea"],
      });
      const matches = results.filter((r) => r.score >= 0.7);
      if (matches.length >= 2) {
        lines.push(`- Theme around "${row.title}" (similar to ${matches.length} existing ideas)`);
      }
    } catch {
      // non-fatal: semantic search failure skips this row
    }
  }

  return lines;
}

async function buildSaturatedThemes(memoryManager?: MemoryManager | null): Promise<string> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT title, summary FROM generated_ideas
      WHERE pipeline_run_id IS NOT NULL
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
      ORDER BY created_at DESC
      LIMIT 500
    `) as Array<{ title: string; summary: string }>;

    if (rows.length === 0) return "";

    // Level 1: bigram/trigram theme detection (fast, no LLM)
    const themeLines = extractThemesByNgrams(rows);

    // Level 2: semantic clustering via memory search (optional)
    const semanticLines = memoryManager
      ? await extractSemanticThemes(rows.slice(0, 50), memoryManager)
      : [];

    const combined = [...themeLines, ...semanticLines];
    if (combined.length === 0) return "";

    return combined.join("\n");
  } catch {
    return "";
  }
}

interface StampIdeaQualityMetaParams {
  readonly promptVersion: string;
  readonly model: string;
  /**
   * Per-idea signalGrounding in [0,1] from the chain-of-evidence verifier.
   * Used only as a fallback when the full critique breakdown is unavailable.
   */
  readonly signalGrounding?: number;
  /**
   * Full Pass-3 critique breakdown (each 0..1) for candidates that matched a
   * critique entry. When present, all four are persisted into
   * critique_subscores_json; otherwise we fall back to {signalGrounding}.
   */
  readonly critiqueSubscores?: {
    readonly specificity: number;
    readonly signalGrounding: number;
    readonly differentiation: number;
    readonly buildability: number;
  };
}

/**
 * #12 part1 — Best-effort stamp of prompt_version, model, and critique
 * sub-scores onto a stored idea (columns added by migration 010). Done as a
 * separate UPDATE so it never blocks or breaks the core insert; swallows errors
 * (e.g. pre-migration DBs) gracefully.
 */
async function stampIdeaQualityMeta(
  ideaId: string,
  params: StampIdeaQualityMetaParams,
): Promise<void> {
  try {
    const subscores =
      params.critiqueSubscores !== undefined
        ? JSON.stringify(params.critiqueSubscores)
        : params.signalGrounding !== undefined
          ? JSON.stringify({ signalGrounding: params.signalGrounding })
          : null;
    const db = getDb();
    await db`
      UPDATE generated_ideas
      SET prompt_version = ${params.promptVersion},
          model = ${params.model},
          critique_subscores_json = ${subscores}::jsonb
      WHERE id = ${ideaId}
    `;
  } catch (err) {
    log.warn("Failed to stamp idea quality meta", { ideaId, err });
  }
}

/**
 * PHASE 0 (GIANT) — Best-effort stamp of the GIANT scorecard onto a stored idea
 * (columns added by migration 014). Done as a separate UPDATE — like
 * {@link stampIdeaQualityMeta} — so it never blocks or breaks the core insert and
 * swallows errors (e.g. pre-migration DBs) gracefully.
 *
 * Stores in SHADOW mode: giant_gated is recorded REGARDLESS of enforcement so
 * kill-logs are reviewable; the Pipeline phase never re-drops a gated idea here.
 *
 *   giant_scores_json  ← the 7-axis scores combined with the per-axis evidence
 *                        citations ({ scores, evidence })
 *   why_now_json       ← the dated, source-bound enabling shifts
 *   archetype          ← the Sequoia archetype tag
 *   pain_severity      ← the acuteProblem axis (fast pain filter)
 *   giant_composite    ← the non-compensatory weighted geometric mean (0..5)
 *   giant_gated        ← whether the hard gates / demand evidence-gate fired
 */
async function stampIdeaGiant(
  ideaId: string,
  candidate: GeneratedIdeaCandidate,
  gate: CandidateGiantGate,
): Promise<void> {
  // Skip entirely when the candidate carries no GIANT scorecard (e.g. GIANT
  // disabled or critique unmatched) — nothing to persist.
  if (candidate.giant === undefined) return;

  try {
    const giantScoresJson = JSON.stringify({
      scores: candidate.giant,
      evidence: candidate.giantEvidence ?? {},
    });
    const whyNowJson = candidate.whyNow !== undefined ? JSON.stringify(candidate.whyNow) : null;
    const archetype = candidate.archetype ?? null;
    const painSeverity = candidate.painSeverity ?? candidate.giant.acuteProblem ?? null;

    const db = getDb();
    await db`
      UPDATE generated_ideas
      SET giant_scores_json = ${giantScoresJson}::jsonb,
          why_now_json = ${whyNowJson}::jsonb,
          archetype = ${archetype},
          pain_severity = ${painSeverity},
          giant_composite = ${gate.composite},
          giant_gated = ${gate.gated}
      WHERE id = ${ideaId}
    `;
  } catch (err) {
    log.warn("Failed to stamp idea GIANT scores", { ideaId, err });
  }
}

/**
 * PHASE 3 (SIGE hardening) — Best-effort persistence of the independent-jury /
 * dissent signals so the eval A/B (SIGE-hardened vs self-critique) can read them
 * back per idea. Stored in the dedicated `sige_signals_json` column (migration
 * 016) rather than overloading the GIANT scorecard blob. Swallows errors (e.g.
 * pre-migration DBs / missing column) so it never blocks or breaks the core
 * insert.
 */
async function stampIdeaSigeSignals(
  ideaId: string,
  signals: SigeSignals | undefined,
): Promise<void> {
  if (signals === undefined) return;
  try {
    const payload = JSON.stringify({
      expertScore: signals.expertScore,
      ...(signals.juryScore !== undefined ? { juryScore: signals.juryScore } : {}),
      ...(signals.juryAgreement !== undefined ? { juryAgreement: signals.juryAgreement } : {}),
      ...(signals.dissent !== undefined ? { dissent: signals.dissent } : {}),
      ...(signals.judgeCount !== undefined ? { judgeCount: signals.judgeCount } : {}),
      ...(signals.evolved ? { evolved: true } : {}),
    });
    const db = getDb();
    await db`
      UPDATE generated_ideas
      SET sige_signals_json = ${payload}::jsonb
      WHERE id = ${ideaId}
    `;
  } catch (err) {
    log.warn("Failed to stamp idea SIGE signals", { ideaId, err });
  }
}

/**
 * Maps a capability's scraper `source` id to its underlying DB table, so a
 * cited signal token can be narrowed to the source rows that produced it.
 */
const SOURCE_TO_TABLE: Readonly<Record<string, string>> = {
  producthunt: "ph_products",
  hackernews: "hn_stories",
  github: "github_repos",
  reddit: "reddit_posts",
  news: "news_articles",
  x: "x_scraped_tweets",
};

/** A {table, id} provenance entry written into generated_ideas.source_ids_json. */
interface ProvenanceEntry {
  readonly table: string;
  readonly id: string;
}

/**
 * #4 part1 — Build PER-IDEA provenance. Resolves a candidate's emitted signal
 * tokens (`<source>_<index>` over capabilities.capabilities) to the source
 * TABLES they came from, then scopes the run-level provenance to just those
 * tables. Falls back to the full run-level provenance when the candidate cited
 * nothing or no citation resolved to a known table. Pure.
 */
function buildIdeaProvenance(
  candidate: GeneratedIdeaCandidate,
  capabilities: readonly Capability[],
  runLevelEntries: readonly ProvenanceEntry[],
): readonly ProvenanceEntry[] {
  const cited = candidate.supportingSignalIds ?? [];
  if (cited.length === 0) return runLevelEntries;

  // Map each cited token to a capability index, then to its source table.
  const tables = new Set<string>();
  capabilities.forEach((cap, index) => {
    const token = signalCitationToken(cap.source, index);
    if (cited.some((c) => c.toLowerCase() === token)) {
      const table = SOURCE_TO_TABLE[cap.source.toLowerCase()];
      if (table) tables.add(table);
    }
  });

  if (tables.size === 0) return runLevelEntries;

  const scoped = runLevelEntries.filter((e) => tables.has(e.table));
  // If scoping produced nothing (e.g. cited table had no selected ids this run),
  // fall back to run-level so provenance is never empty for a stored idea.
  return scoped.length > 0 ? scoped : runLevelEntries;
}

/**
 * PHASE 0 (GIANT) — Best-effort demand-evidence check at the pipeline boundary.
 * Mirrors synthesizer.hasDemandEvidence but reads the candidate's persisted
 * GIANT fields instead of a freshly-parsed critique: a cited demand artifact is
 * present when giantEvidence.demand is non-empty OR any whyNow shift is bound to
 * a real signal id. Errs toward CAPPING (false) when there is no concrete
 * evidence, matching the GIANT default. Pure.
 */
export function candidateHasDemandEvidence(candidate: GeneratedIdeaCandidate): boolean {
  const demandEvidence = candidate.giantEvidence?.demand?.trim() ?? "";
  if (demandEvidence.length > 0) return true;
  return (candidate.whyNow ?? []).some(
    (shift) => typeof shift.boundSignalId === "string" && shift.boundSignalId.trim().length > 0,
  );
}

/** The pipeline-level GIANT verdict for one candidate (composite + gate state). */
export interface CandidateGiantGate {
  readonly composite: number;
  readonly gated: boolean;
  readonly gateReasons: readonly string[];
}

/**
 * PHASE 0 (GIANT) — Re-evaluate the GIANT gate for a candidate at the pipeline
 * boundary using the configured weights + demand evidence-gate. When the
 * candidate carries the raw 7-axis `giant` scores (the common path, stamped by
 * the synthesizer critique pass) we recompute via {@link aggregateGiant} so the
 * pipeline applies config weights consistently. When the raw scores are absent
 * (e.g. a candidate that never matched a critique entry) we fall back to the
 * GIANT fields the synthesizer already stamped, defaulting to "not gated" so the
 * optional GIANT path never invents a kill. PURE — no DB / clock / rng.
 */
export function evaluateCandidateGiantGate(
  candidate: GeneratedIdeaCandidate,
  giant: GiantConfig,
): CandidateGiantGate {
  if (candidate.giant !== undefined) {
    const aggregate = aggregateGiant(candidate.giant, {
      weights: giant.weights,
      enforceGates: giant.enforceGates,
      hasDemandEvidence: candidateHasDemandEvidence(candidate),
    });
    return {
      composite: aggregate.composite,
      gated: aggregate.gated,
      gateReasons: aggregate.gateReasons,
    };
  }

  // No raw axis scores — trust whatever the synthesizer already stamped, but
  // never gate when the stored verdict is missing.
  return {
    composite: candidate.giantComposite ?? candidate.qualityScore,
    gated: candidate.giantGated === true,
    gateReasons: candidate.giantGateReasons ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 "demand-side grounding" — pipeline-level demand enrichment, GIANT
// demand-axis rescore, provenance binding, and run-level coverage instrumentation.
//
// The demand subsystem (demand.ts + demand-probes.ts) is DETERMINISTIC and
// graceful: enrichDemand extracts keywords from the candidate's own text by CODE,
// queries EXISTING scraped tables (reddit_posts / news_articles) for real row
// COUNTS, and returns a cited {@link DemandArtifact} (never an LLM opinion). The
// artifact is what feeds the GIANT demand evidence-gate so deserving ideas escape
// the <=2 cap. All persistence is best-effort so the optional path never breaks
// the core insert.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 2 (demand) — Map a candidate onto the {@link DemandCandidateText} the
 * demand subsystem tokenizes. `reasoning` is this pipeline's problem statement.
 * PURE — no IO; just a field projection so keyword extraction stays deterministic.
 */
export function toDemandCandidateText(candidate: GeneratedIdeaCandidate): DemandCandidateText {
  return {
    title: candidate.title,
    summary: candidate.summary,
    reasoning: candidate.reasoning,
    trendIntersection: candidate.trendIntersection,
    targetAudience: candidate.targetAudience,
  };
}

/**
 * PHASE 2 (demand) — Map {@link EnrichDemandConfig} from the validated
 * smart.demand config block plus optional window/limit/supplyDensity knobs.
 * PURE.
 */
export function buildEnrichDemandConfig(
  demand: DemandConfig,
  knobs: {
    readonly windowSec?: number;
    readonly limit?: number;
    readonly supplyDensity?: number;
  } = {},
): EnrichDemandConfig {
  return {
    enabled: demand.enabled,
    redditIntent: demand.redditIntent,
    fundingSignal: demand.fundingSignal,
    externalTrends: demand.externalTrends,
    minMatches: demand.minMatches,
    ...(knobs.windowSec !== undefined ? { windowSec: knobs.windowSec } : {}),
    ...(knobs.limit !== undefined ? { limit: knobs.limit } : {}),
    ...(knobs.supplyDensity !== undefined ? { supplyDensity: knobs.supplyDensity } : {}),
  };
}

/** Provenance entries carried by a demand artifact's cited evidence rows. */
function demandProvenanceEntries(artifact: DemandArtifact): readonly ProvenanceEntry[] {
  const tableByKind: Readonly<Record<string, string>> = {
    reddit_intent: "reddit_posts",
    funding_news: "news_articles",
  };
  const seen = new Set<string>();
  const entries: ProvenanceEntry[] = [];
  for (const e of artifact.evidence) {
    const table = tableByKind[e.kind];
    if (table === undefined) continue; // search_trend/hiring carry no scraped row
    const id = e.sourceId?.trim();
    if (!id) continue;
    const key = `${table}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ table, id });
  }
  return entries;
}

/**
 * PHASE 2 (demand) — RE-SCORE the GIANT demand axis from the cited
 * {@link DemandArtifact} and RE-AGGREGATE the composite so ideas with REAL cited
 * demand evidence escape the demand evidence-gate cap (<=2). This is the Phase 2
 * unlock.
 *
 * DETERMINISTIC + IMMUTABLE — returns a NEW candidate (never mutates):
 *   - candidate.giant.demand  ← artifact.score (the deterministic, cited value)
 *   - hasDemandEvidence       ← hasCitedDemand(artifact) (>=1 row AND score>cap)
 *   - composite / qualityScore / giantComposite / giantGated / gateReasons are
 *     recomputed via {@link aggregateGiant} under the (possibly opened) gate.
 *   - painSeverity is left intact (it mirrors acuteProblem, not demand).
 *
 * When the candidate carries no raw GIANT scorecard (never matched a critique
 * entry) there is nothing to rescore — the candidate is returned unchanged so the
 * optional demand path never invents a score. PURE — no DB / clock / rng.
 */
export function applyDemandRescore(
  candidate: GeneratedIdeaCandidate,
  artifact: DemandArtifact,
  giant: GiantConfig,
): GeneratedIdeaCandidate {
  if (candidate.giant === undefined) return candidate;

  const rescoredGiant: GiantAxisScores = {
    ...candidate.giant,
    demand: artifact.score,
  };

  const hasDemandEvidence = hasCitedDemand(artifact);
  const aggregate = aggregateGiant(rescoredGiant, {
    weights: giant.weights,
    enforceGates: giant.enforceGates,
    hasDemandEvidence,
  });

  // When the cited artifact opens the evidence-gate, stamp a CITED demand
  // evidence string (a verbatim quote when available, else the matched-row
  // counts) onto giantEvidence.demand. This keeps the downstream pipeline-level
  // gate check (candidateHasDemandEvidence, used by the shadow-gate + store)
  // CONSISTENT with this rescore — the gate opens on the same cited buyer-intent.
  // Never fabricated: every part is derived from real evidence rows.
  const nextEvidence = hasDemandEvidence
    ? {
        ...(candidate.giantEvidence ?? ({} as Record<GiantAxisKey, string>)),
        demand: buildDemandEvidenceString(artifact),
      }
    : candidate.giantEvidence;

  return {
    ...candidate,
    giant: rescoredGiant,
    ...(nextEvidence !== undefined ? { giantEvidence: nextEvidence } : {}),
    qualityScore: compositeToQualityScore(aggregate.composite),
    giantComposite: aggregate.composite,
    giantGated: aggregate.gated,
    giantGateReasons: aggregate.gateReasons,
  };
}

/**
 * PHASE 2 (demand) — Build a CITED, human-readable demand-evidence string from a
 * demand artifact for giantEvidence.demand. Reuses a real evidence quote verbatim
 * when present (never invented), otherwise summarizes the matched-row counts by
 * kind. PURE.
 */
export function buildDemandEvidenceString(artifact: DemandArtifact): string {
  const quoted = artifact.evidence.find(
    (e) => typeof e.quote === "string" && e.quote.trim().length > 0,
  );
  if (quoted?.quote) {
    const id = quoted.sourceId ? ` [${quoted.kind}:${quoted.sourceId}]` : "";
    return `"${quoted.quote.trim().slice(0, 200)}"${id}`;
  }
  const byKind = new Map<string, number>();
  for (const e of artifact.evidence) {
    const count = Number.isFinite(e.count) && e.count > 0 ? e.count : 0;
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + count);
  }
  const parts = [...byKind.entries()].map(([kind, n]) => `${kind}:${n}`);
  return `demand matches — ${parts.join(", ")}`;
}

/** Run-level demand-coverage instrumentation (PURE). */
export interface DemandCoverageStats {
  readonly total: number;
  /** How many candidates carried a CITED demand artifact (gate-opening). */
  readonly cited: number;
  /** Share of candidates with a cited artifact (0..1). */
  readonly citedShare: number;
  readonly meanDemandScore: number;
  readonly meanWhitespace: number;
}

/**
 * PHASE 2 (demand) — Summarize demand coverage across the surviving candidates so
 * a single log line proves how many ideas are now demand-grounded. PURE: reads
 * the artifacts keyed by candidate; absent artifacts count toward `total` with a
 * 0 contribution (absence is visible, not hidden). Means are over the full set.
 */
export function summarizeDemandCoverage(
  candidates: readonly GeneratedIdeaCandidate[],
  artifacts: ReadonlyMap<GeneratedIdeaCandidate, DemandArtifact>,
): DemandCoverageStats {
  const total = candidates.length;
  let cited = 0;
  let scoreSum = 0;
  let whitespaceSum = 0;

  for (const candidate of candidates) {
    const artifact = artifacts.get(candidate);
    if (artifact === undefined) continue;
    if (hasCitedDemand(artifact)) cited += 1;
    scoreSum += artifact.score;
    whitespaceSum += artifact.whitespace;
  }

  return {
    total,
    cited,
    citedShare: total > 0 ? cited / total : 0,
    meanDemandScore: total > 0 ? scoreSum / total : 0,
    meanWhitespace: total > 0 ? whitespaceSum / total : 0,
  };
}

/**
 * PHASE 2 (demand) — Best-effort stamp of the cited {@link DemandArtifact} +
 * resolved segment onto a stored idea (migration 015 columns: demand_json,
 * demand_score, whitespace, segment). Done as a SEPARATE UPDATE — like
 * {@link stampIdeaGiant} — so it never blocks or breaks the core insert and
 * swallows errors (e.g. pre-migration DBs) gracefully. The artifact is validated
 * via {@link demandArtifactSchema} before persistence so only well-formed,
 * count-backed evidence is written.
 */
async function stampIdeaDemand(
  ideaId: string,
  artifact: DemandArtifact | undefined,
  segment: SegmentId,
): Promise<void> {
  try {
    const parsed = artifact !== undefined ? demandArtifactSchema.safeParse(artifact) : undefined;
    const demandJson = parsed !== undefined && parsed.success ? JSON.stringify(parsed.data) : null;
    const demandScore = parsed !== undefined && parsed.success ? parsed.data.score : null;
    const whitespace = parsed !== undefined && parsed.success ? parsed.data.whitespace : null;

    const db = getDb();
    await db`
      UPDATE generated_ideas
      SET demand_json = ${demandJson}::jsonb,
          demand_score = ${demandScore},
          whitespace = ${whitespace},
          segment = ${segment}
      WHERE id = ${ideaId}
    `;
  } catch (err) {
    log.warn("Failed to stamp idea demand artifact", { ideaId, err });
  }
}

/**
 * #5 — Fetch human-validated ideas to use as positive few-shot exemplars.
 * Degrades to [] on any error; the caller passes the rendered block
 * unconditionally (synthesizeFromTrends re-gates it via smart.validatedExemplars).
 */
async function fetchValidatedExemplars(limit = 12): Promise<readonly ValidatedExemplar[]> {
  try {
    const validated = await getIdeasByStage("validated", limit);
    return validated.map((i) => ({
      title: i.title,
      summary: i.summary,
      category: i.category,
    }));
  } catch (err) {
    log.warn("Failed to fetch validated exemplars", { err });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 "warm the cold taste loop" — bootstrap the taste/calibration loop with
// ZERO human labels: anti-exemplars (the genericness lever), a SYNTHETIC golden
// set derived from the best scored ideas (replaced by real human picks as they
// accrue), cheap auto-PROXY labels seeded into idea_feedback, and gated GIANT
// axis-weight nudges. Every path is flag-gated under smart.taste and wrapped so a
// failure FALLS BACK to the existing default path (empty blocks / no proxy /
// neutral weights). Few-shot counts stay LOW + ROTATE per run so the positive
// exemplars cannot collapse generation toward the seeds (novelty is the gate).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 4 — Derive a deterministic per-run rotation seed from the run id so the
 * golden + anti exemplar slices VARY across successive runs (anti-mode-collapse).
 * A simple stable string hash; PURE.
 */
export function rotationSeedFromRunId(runId: string): number {
  let hash = 0;
  for (let i = 0; i < runId.length; i++) {
    hash = (hash * 31 + runId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** A subset of generated_ideas columns the taste loop reads back. */
interface ScoredIdeaDbRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string | null;
  readonly segment: string | null;
  readonly giant_composite: number | null;
  readonly giant_scores_json: unknown;
  readonly archetype: string | null;
  readonly demand_score: number | null;
  readonly whitespace: number | null;
  readonly pipeline_stage: string | null;
}

/**
 * PHASE 4 — Map a raw generated_ideas row onto the PURE {@link ScoredIdeaRow} the
 * taste selectors consume. The GIANT scorecard is unwrapped via parseGiantScores
 * (handles flat {axis:n} AND the nested {scores:{axis:n}} blob stampIdeaGiant
 * writes). `whitespace` (a REAL 0..1 in the DB) is projected to the boolean flag
 * the row carries. All scoring fields stay optional so partial rows degrade. PURE.
 */
export function toScoredIdeaRow(row: ScoredIdeaDbRow): ScoredIdeaRow {
  const giantScores = parseGiantScores(row.giant_scores_json);
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    segment: row.segment,
    giantComposite: row.giant_composite,
    giantScores: Object.keys(giantScores).length > 0 ? giantScores : null,
    archetype: row.archetype,
    demandScore: row.demand_score,
    whitespace: typeof row.whitespace === "number" ? row.whitespace > 0 : null,
    pipelineStage: row.pipeline_stage,
  };
}

/**
 * PHASE 4 — Load the scored-idea pool the taste selectors derive exemplars from:
 * ALL human-validated rows (precedence) plus the most-recent non-archived scored
 * rows (the synthetic-bootstrap pool). selectGoldenExemplars / selectAntiExemplars
 * filter by stage internally. Fully GRACEFUL — returns [] on any failure so the
 * optional taste path always falls back to empty blocks (mirrors
 * fetchValidatedExemplars / loadCredibilityPosteriors). Pipeline phase owns it.
 */
async function fetchScoredIdeaRows(recentLimit = 400): Promise<readonly ScoredIdeaRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      (
        SELECT id, title, summary, category, segment, giant_composite,
               giant_scores_json, archetype, demand_score, whitespace, pipeline_stage
        FROM generated_ideas
        WHERE pipeline_stage = 'validated'
      )
      UNION
      (
        SELECT id, title, summary, category, segment, giant_composite,
               giant_scores_json, archetype, demand_score, whitespace, pipeline_stage
        FROM generated_ideas
        WHERE COALESCE(pipeline_stage, 'idea') NOT IN ('archived', 'validated')
        ORDER BY created_at DESC
        LIMIT ${recentLimit}
      )
    `) as ScoredIdeaDbRow[];
    return rows.map(toScoredIdeaRow);
  } catch (err) {
    log.warn("Failed to load scored idea rows for taste loop", { err });
    return [];
  }
}

/** The rendered taste prompt blocks plus counts for instrumentation (PURE). */
export interface TasteBlocks {
  /** Positive "produce MORE like these" block (golden), or "" when empty/off. */
  readonly goldenBlock: string;
  /** Negative "AVOID these generic archetypes" block, or "" when empty/off. */
  readonly antiBlock: string;
  readonly goldenCount: number;
  readonly antiCount: number;
  /** How many golden picks are still synthetic (vs human-validated). */
  readonly syntheticGoldenCount: number;
}

/**
 * PHASE 4 — Build the golden + anti exemplar prompt blocks from the loaded scored
 * pool, gated per-lever under smart.taste. Golden picks are SEGMENT-DIVERSE,
 * rotated by the per-run seed, and capped LOW (exemplarCount). Real human-
 * validated picks take precedence and replace synthetic ones above
 * goldenMinHumanLabels. PURE — no IO; takes the already-loaded rows + flags.
 */
export function buildTasteBlocks(
  scoredRows: readonly ScoredIdeaRow[],
  taste: TasteConfig,
  rotationSeed: number,
): TasteBlocks {
  const goldenExemplars = taste.syntheticGolden
    ? selectGoldenExemplars(scoredRows, {
        exemplarCount: taste.exemplarCount,
        goldenMinHumanLabels: taste.goldenMinHumanLabels,
        rotationSeed,
      })
    : [];

  const antiExemplars = taste.antiExemplars
    ? selectAntiExemplars(scoredRows, {
        exemplarCount: taste.exemplarCount,
        rotationSeed,
      })
    : [];

  return {
    goldenBlock: renderGoldenBlock(goldenExemplars),
    antiBlock: renderAntiBlock(antiExemplars),
    goldenCount: goldenExemplars.length,
    antiCount: antiExemplars.length,
    syntheticGoldenCount: goldenExemplars.filter((g) => g.synthetic).length,
  };
}

/**
 * PHASE 4 — Map a stored idea + its run-derived signals onto the
 * {@link ScoredIdeaForProxy} the proxy-label rules consume. The persisted GIANT
 * columns are read directly; convergence-veto / grounded / supply / distinct-
 * segments are DERIVED at the call-site (no persisted columns exist) and only
 * trigger their rule when present. PURE.
 */
export function toScoredIdeaForProxy(params: {
  readonly ideaId: string;
  readonly candidate: GeneratedIdeaCandidate;
  readonly gate?: CandidateGiantGate;
  readonly artifact?: DemandArtifact;
  readonly grounded?: boolean;
  readonly convergenceVeto?: boolean;
  readonly distinctSegments?: number;
}): ScoredIdeaForProxy {
  const { candidate, gate, artifact } = params;
  const giantComposite = gate?.composite ?? candidate.giantComposite ?? candidate.qualityScore;
  // hasSupplySignal — a real supply/competitor signal exists when the demand
  // probe found cited evidence yet whitespace was DISCOUNTED below the raw
  // demand intensity (score/5). That discount is exactly the supply-density
  // subtraction, so a whitespace strictly below the demand ceiling means
  // competitors crowded the space. Derived (no persisted column).
  const hasSupplySignal =
    artifact !== undefined &&
    artifact.evidence.length > 0 &&
    artifact.whitespace < artifact.score / DEMAND_SCORE_MAX;
  return {
    id: params.ideaId,
    giantComposite,
    ...(artifact !== undefined ? { demandScore: artifact.score } : {}),
    ...(artifact !== undefined ? { whitespace: artifact.whitespace } : {}),
    ...(artifact !== undefined ? { hasSupplySignal } : {}),
    ...(params.convergenceVeto !== undefined ? { convergenceVeto: params.convergenceVeto } : {}),
    ...(params.grounded !== undefined ? { grounded: params.grounded } : {}),
    ...(params.distinctSegments !== undefined ? { distinctSegments: params.distinctSegments } : {}),
  };
}

/**
 * #4 part2 — Load Beta-Bernoulli source-credibility posteriors keyed by
 * credibilityKey(source_table, signal_type, category). Fully graceful: returns
 * an empty map when no feedback exists yet. The map is informational for the
 * collector ordering (collectors already rank by per-row credibility); folding
 * the posterior into selection requires a CollectorContext field — see the
 * notesForNextPhase seam.
 */
async function loadCredibilityPosteriors(): Promise<ReadonlyMap<string, number>> {
  try {
    const creds = await getSourceCredibility();
    const map = new Map<string, number>();
    for (const c of creds) {
      map.set(credibilityKey(c.source_table, c.signal_type, c.category), c.mean);
    }
    return map;
  } catch (err) {
    log.warn("Failed to load source-credibility posteriors", { err });
    return new Map();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 "SIGE hardening" — make SIGE a TRUSTWORTHY convergent judge: an
// INDEPENDENT, anonymized, cross-family jury on top of the native SIGE expert
// score; first-class DISSENT; a CONVERGENCE-VETO so a collapsed (sycophantic)
// round is not over-trusted; a UNION read-back that no longer drops SIGE's
// Round-3 evolved/recombined children; and a Pareto (originality × quality)
// selection that replaces the scalar sort. Everything stays behind
// smart.sigeValuation (default OFF) so the default run is byte-for-byte
// unchanged. Every impure call is wrapped so a SIGE/jury failure FALLS BACK to
// the critique scores — it can never break the run.
// ─────────────────────────────────────────────────────────────────────────────

/** SIGE expertScore is in [0,1]; the pipeline qualityScore is on the 1..5 scale. */
function expertToQuality(expertScore: number): number {
  return 1 + Math.min(Math.max(expertScore, 0), 1) * 4;
}

/** The 1..5 qualityScore mapped back to a [0,1] expert prior. PURE. */
function qualityToExpert(qualityScore: number): number {
  return Math.min(Math.max((qualityScore - 1) / 4, 0), 1);
}

/**
 * PHASE 3 — A defensive view over the EXTENDED {@link CandidateEvaluation} that
 * SIGE returns. The extra GIANT/jury/dissent fields are OPTIONAL on the contract
 * (added by the expert-game extension), so we read them through this accessor —
 * which never assumes they are present — to stay backward-compatible whether or
 * not the producer has stamped them. PURE.
 */
interface SigeEvalView {
  readonly title: string;
  readonly expertScore: number;
  readonly description?: string;
  readonly giantScores?: GiantAxisScores;
  readonly evidenceRef?: readonly string[];
  /** First-class red-team / contrarian disagreement in [0,1] (already normalized by SIGE). */
  readonly dissent?: number;
  /** "evolved" ⇒ a Round-3 mutated/recombined child the legacy join silently dropped. */
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

/** Runtime guard for a 7-axis GIANT scorecard (every axis a finite number). PURE. */
function isGiantAxisScores(value: unknown): value is GiantAxisScores {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return GIANT_AXIS_KEYS.every((key) => typeof rec[key] === "number" && Number.isFinite(rec[key]));
}

/**
 * PHASE 3 — First-class DISSENT signals carried alongside a candidate through
 * the hardened path. Stored in a side-map (like demand/giant-gate) so the
 * pipeline never has to widen the shared {@link GeneratedIdeaCandidate} type.
 */
export interface SigeSignals {
  /** SIGE's native (self-graded) expert score in [0,1]. */
  readonly expertScore: number;
  /** Independent cross-family jury GIANT composite (0..5), when a jury ran. */
  readonly juryScore?: number;
  /** Inter-judge agreement (0..1); the conformity inverse of dissent. */
  readonly juryAgreement?: number;
  /** First-class dissent magnitude (0..1) folded into selection, never averaged away. */
  readonly dissent?: number;
  /** Combined GIANT scorecard (SIGE self-grade × independent jury), when available. */
  readonly giantScores?: GiantAxisScores;
  /** How many independent judges scored this candidate. */
  readonly judgeCount?: number;
  /** True when the candidate is a SIGE Round-3 evolved/recombined child (read-back union). */
  readonly evolved?: boolean;
}

/**
 * PHASE 3 — Combine SIGE's SELF-graded GIANT axes with the INDEPENDENT jury's
 * GIANT axes into one scorecard. The jury is the anti-sycophancy check on SIGE's
 * own score, so we blend per-axis (default: equal weight) rather than trust
 * either alone. When only one source is present we use it directly. PURE.
 */
export function combineGiantScores(
  sigeGiant: GiantAxisScores | undefined,
  juryGiant: GiantAxisScores | undefined,
  juryWeight = 0.5,
): GiantAxisScores | undefined {
  if (sigeGiant === undefined && juryGiant === undefined) return undefined;
  if (sigeGiant === undefined) return juryGiant;
  if (juryGiant === undefined) return sigeGiant;
  const w = Math.min(Math.max(juryWeight, 0), 1);
  const combined = {} as GiantAxisScores;
  for (const key of GIANT_AXIS_KEYS) {
    combined[key] = (1 - w) * sigeGiant[key] + w * juryGiant[key];
  }
  return combined;
}

/**
 * PHASE 3 — Normalise a jury dissent magnitude (0..5 axis spread) into the
 * [0,1] term {@link dissentAdjustedScore} expects. PURE.
 */
export function normalizeDissent(dissent: number | undefined): number {
  if (dissent === undefined || !Number.isFinite(dissent)) return 0;
  return Math.min(Math.max(dissent / 5, 0), 1);
}

/**
 * PHASE 3 — Map the configured cross-family judge models (provider/model pairs
 * from smart.sige.judgeModels) onto the jury's {@link JudgeModel} panel. Each
 * non-anthropic provider is gated on its conventional API-key env var so a
 * provider with no key is gracefully skipped by {@link judgeWithJury}. Falls
 * back to {@link DEFAULT_JURY_PANEL} when the config carries no usable entry.
 * PURE.
 */
const PROVIDER_SECRET: Readonly<Record<string, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  alibaba: "ALIBABA_API_KEY",
};

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<AiProvider>([
  "openrouter",
  "agent-sdk",
  "alibaba",
  "anthropic",
]);

export function buildJuryPanel(
  judgeModels: readonly { readonly provider: string; readonly model: string }[],
): readonly JudgeModel[] {
  const panel: JudgeModel[] = [];
  for (const jm of judgeModels) {
    const provider = jm.provider.trim().toLowerCase();
    if (!KNOWN_PROVIDERS.has(provider) || jm.model.trim().length === 0) {
      continue;
    }
    const secret = PROVIDER_SECRET[provider];
    panel.push({
      label: `${provider}:${jm.model}`,
      provider: provider as AiProvider,
      model: jm.model,
      ...(secret !== undefined ? { requiredSecret: secret } : {}),
    });
  }
  return panel.length > 0 ? panel : DEFAULT_JURY_PANEL;
}

/**
 * PHASE 3 — Build position-switched pairwise A>B votes from the jury verdicts so
 * {@link bradleyTerryRank} can stabilise the ordering against position bias.
 * For every unordered pair we emit ONE comparison in EACH direction's framing
 * (A-first then B-first) and let the higher juryScore win each framing; equal
 * scores emit no vote (a genuine tie). This makes the resulting strengths
 * symmetric to presentation order. PURE.
 */
export function buildPairwiseWins(
  verdicts: readonly { readonly candidateId: string; readonly juryScore: number }[],
): readonly PairwiseWin[] {
  const wins: PairwiseWin[] = [];
  for (let i = 0; i < verdicts.length; i++) {
    for (let j = i + 1; j < verdicts.length; j++) {
      const a = verdicts[i]!;
      const b = verdicts[j]!;
      if (a.juryScore === b.juryScore) continue;
      const winner = a.juryScore > b.juryScore ? a.candidateId : b.candidateId;
      const loser = a.juryScore > b.juryScore ? b.candidateId : a.candidateId;
      // Two framings (A-first, B-first) → both register the same winner, so the
      // winner is reinforced regardless of presentation order (position-switch).
      wins.push({ winner, loser });
      wins.push({ winner, loser });
    }
  }
  return wins;
}

/**
 * PHASE 3 — The result of the hardened SIGE valuation: the (possibly UNIONed)
 * candidate set rescored on the combined SIGE×jury judgment, plus the side-band
 * signals the caller persists for the eval A/B and feeds into Pareto selection.
 */
export interface SigeHardenedResult {
  readonly candidates: readonly GeneratedIdeaCandidate[];
  /**
   * SIGE/jury/dissent signals keyed by the STABLE join-id (normalized title), NOT
   * by candidate object identity — downstream phases (demand rescore, GIANT gate,
   * originality re-annotation) replace candidate objects, so a title-keyed map
   * survives the immutable rescores and rejoins reliably.
   */
  readonly signalsByTitle: ReadonlyMap<string, SigeSignals>;
}

/**
 * PHASE 3 — A stable id for joining SIGE/jury verdicts back to candidates. We
 * derive it from the normalized title so it is reproducible across the SIGE
 * round (which keys results by title) and the jury (which is given this id). PURE.
 */
function candidateJoinId(title: string): string {
  return title.toLowerCase().trim();
}

/**
 * PHASE 3 — Re-bind a SIGE Round-3 evolved/recombined CHILD (a title returned by
 * SIGE that did NOT exist in the input pool) into a {@link GeneratedIdeaCandidate}
 * so it competes in the SAME selection as the seed pool. The child is tagged
 * origin "sige-evolved"; verifyEvidence later HARD-PENALIZES it if it cannot be
 * re-grounded against this run's real signals. PURE.
 */
export function mapEvolvedEvaluation(view: SigeEvalView): GeneratedIdeaCandidate {
  return {
    title: view.title,
    summary: view.description ?? "",
    reasoning: view.description ?? "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "sige-evolved (round-3 recombination)",
    category: "",
    qualityScore: expertToQuality(view.expertScore),
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...(view.evidenceRef !== undefined && view.evidenceRef.length > 0
      ? { supportingSignalIds: view.evidenceRef }
      : {}),
    ...(view.giantScores !== undefined ? { giant: view.giantScores } : {}),
  };
}

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
async function applySigeValuation(
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
      // Seed prior from the critique score (1-5) back to [0,1].
      expertScore: qualityToExpert(c.qualityScore),
    }));

    // Always synthesize a NON-EMPTY enrichedSeed so SIGE's taste-filter grounding
    // gate never silently skips (an empty seed disables the gate). Fall back to a
    // compact synopsis of the candidate pool when no deep-search context exists.
    const enrichedSeed =
      deepSearchContext.trim().length > 0 ? deepSearchContext : synthesizeEnrichedSeed(candidates);

    const evaluations = await evaluateCandidates(sigeCandidates, {
      mem0: new Mem0Client({ baseUrl: sigeConfig.mem0.baseUrl }),
      userId: sigeConfig.mem0.userId,
      enrichedSeed,
    });

    const views = evaluations.map(readEvaluation);

    // ── 1) READ-BACK UNION: split SIGE results into matched-seed vs evolved ──
    const inputIds = new Set(candidates.map((c) => candidateJoinId(c.title)));
    const viewByJoinId = new Map<string, SigeEvalView>();
    for (const view of views) {
      viewByJoinId.set(candidateJoinId(view.title), view);
    }

    // A child is "evolved" when SIGE tags origin:"evolved" (authoritative) OR —
    // when the producer left origin undefined — when its title was not in the
    // input pool (the legacy title-join's silent-drop signal).
    const evolvedViews = views.filter((v) =>
      v.origin !== undefined ? v.origin === "evolved" : !inputIds.has(candidateJoinId(v.title)),
    );

    // Re-bind evolved children through verifyEvidence; a child that cannot be
    // re-grounded (no bindable evidence against this run's signals) is
    // hard-penalized rather than trusted at face value.
    let evolvedCandidates: readonly GeneratedIdeaCandidate[] = [];
    if (evolvedViews.length > 0) {
      const mapped = evolvedViews.map(mapEvolvedEvaluation);
      const verified = verifyEvidence(mapped, capabilities);
      evolvedCandidates = verified.kept.map((child) => {
        const grounding = verified.groundingByTitle.get(child.title);
        // origin:evolved + no bindable evidence → low grounding → hard penalty.
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

    // Rescore the matched seed pool from SIGE's expert score + extended GIANT.
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

    // Seed the side-band signals from the native SIGE expert grade.
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

    // ── 2) INDEPENDENT JURY (anti-sycophancy check) ──────────────────────────
    let rescored = unioned;
    if (sigeHardening.independentJudge && unioned.length > 0) {
      const juryResult = await runIndependentJury(unioned, sigeHardening, signals);
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
  sigeHardening: SigeHardeningConfig,
  signals: Map<GeneratedIdeaCandidate, SigeSignals>,
): Promise<{ readonly candidates: readonly GeneratedIdeaCandidate[] }> {
  try {
    const panel = buildJuryPanel(sigeHardening.judgeModels);

    // Anonymize: pass raw candidate objects (with a STABLE id) THROUGH
    // anonymizeCandidates — it strips provenance + author/score before judging.
    const rawCands = candidates.map((c) => ({
      id: candidateJoinId(c.title),
      title: c.title,
      description: c.summary,
    }));
    const juryRaw = await judgeWithJury(anonymizeCandidates(rawCands), panel);

    if (juryRaw.length === 0) {
      // No judge available — graceful fall-back to native SIGE scores.
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

      // Re-derive qualityScore from the COMBINED GIANT composite so the jury is a
      // genuine independent check, not a tie-breaker. Fall back to the jury's own
      // composite when no GIANT axes are available.
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
    // Jury failure must NEVER break the run — keep the native SIGE scores.
    log.warn("SIGE jury failed — keeping native SIGE scores", { err });
    return { candidates };
  }
}

/**
 * PHASE 3 — Re-key a candidate→signals side-map onto a TITLE-keyed map (by the
 * stable join id), so signals survive the immutable rescores downstream (which
 * produce NEW candidate objects) and rejoin reliably. PURE.
 */
function remapSignals(
  signals: ReadonlyMap<GeneratedIdeaCandidate, SigeSignals>,
): ReadonlyMap<string, SigeSignals> {
  const byJoinId = new Map<string, SigeSignals>();
  for (const [cand, sig] of signals) {
    byJoinId.set(candidateJoinId(cand.title), sig);
  }
  return byJoinId;
}

/**
 * PHASE 3 — Always-non-empty enrichedSeed for SIGE's taste filter. An empty seed
 * disables the grounding gate; when no deep-search context exists we synthesize a
 * compact synopsis of the candidate pool so the gate ALWAYS has something to
 * judge against. PURE.
 */
export function synthesizeEnrichedSeed(candidates: readonly GeneratedIdeaCandidate[]): string {
  const lines = candidates.slice(0, 20).map((c) => `- ${c.title}: ${c.summary}`.slice(0, 240));
  const body = lines.join("\n").trim();
  return body.length > 0
    ? `=== CANDIDATE POOL SYNOPSIS ===\n${body}`
    : "=== CANDIDATE POOL SYNOPSIS ===\n(no candidate text available)";
}

/**
 * PHASE 3 — Select a stable top-K via a Pareto frontier over (originality ×
 * dissent-adjusted quality) plus a Bradley-Terry pairwise tie-break, replacing
 * the scalar sort when SIGE is on. originalityOf = the Qdrant-distance originality
 * (0..1) from annotateOriginality; qualityOf = the dissent-folded SIGE/jury score.
 * Degrades gracefully when the frontier is smaller than K (the ranked walk
 * back-fills) and when no signals exist (quality falls back to qualityScore).
 * PURE.
 */
export function paretoSelect(
  candidates: readonly GeneratedIdeaCandidate[],
  signals: ReadonlyMap<string, SigeSignals>,
  limit: number,
  dissentWeight: number,
): readonly GeneratedIdeaCandidate[] {
  if (limit <= 0) return [];
  if (candidates.length <= limit) return [...candidates];

  const idOf = (c: GeneratedIdeaCandidate): string => candidateJoinId(c.title);

  const qualityOf = (c: GeneratedIdeaCandidate): number => {
    const sig = signals.get(idOf(c));
    const base =
      sig?.juryScore ??
      (sig?.expertScore !== undefined ? expertToQuality(sig.expertScore) : c.qualityScore);
    return dissentAdjustedScore(base, sig?.dissent ?? 0, dissentWeight);
  };
  const originalityOf = (c: GeneratedIdeaCandidate): number =>
    typeof c.originality === "number" ? c.originality : 1;

  const pareto = paretoFrontier(candidates, originalityOf, qualityOf);

  // Bradley-Terry tie-break / stabilization from position-switched jury votes.
  const verdictRows = candidates
    .map((c) => {
      const sig = signals.get(idOf(c));
      return sig?.juryScore !== undefined
        ? { candidateId: idOf(c), juryScore: sig.juryScore }
        : undefined;
    })
    .filter((r): r is { candidateId: string; juryScore: number } => r !== undefined);

  const bt = verdictRows.length >= 2 ? bradleyTerryRank(buildPairwiseWins(verdictRows)) : undefined;
  const btRank = new Map<string, number>();
  if (bt !== undefined) {
    bt.ranking.forEach((id, i) => btRank.set(id, i));
  }

  // Walk the Pareto-ranked order; within equal Pareto rank, Bradley-Terry
  // ordering breaks ties. Stable: preserve the Pareto walk otherwise.
  const ranked = pareto.ranked.map((p, paretoIdx) => ({
    candidate: p.item,
    paretoIdx,
    btIdx: btRank.get(idOf(p.item)) ?? Number.POSITIVE_INFINITY,
  }));

  const ordered = [...ranked].sort((a, b) => {
    if (a.paretoIdx !== b.paretoIdx) return a.paretoIdx - b.paretoIdx;
    return a.btIdx - b.btIdx;
  });

  return ordered.slice(0, limit).map((r) => r.candidate);
}

/**
 * PHASE 3 — Derive a {@link ConvergenceSignal} from the independent jury's fused
 * signals and run {@link convergenceVeto}. The SIGE rounds are not exposed by
 * evaluateCandidates, so the jury's inter-judge AGREEMENT is the robust,
 * always-available convergence proxy: high mean agreement ⇒ the field collapsed
 * onto a consensus (sycophancy-collapse risk), and the unique-title ratio gives a
 * direct diversity index. Folds the mean dissent back into diversity so a
 * polarizing (high-dissent) round is NOT mistaken for a collapsed one. PURE — the
 * MetaGameHealth shape is structurally assignable to ConvergenceSignal, so this
 * stays a drop-in for computeMetaGameHealth(rounds, definitions) if the SIGE
 * contract later exposes the rounds.
 */
export function computeSigeConvergenceVeto(
  signals: ReadonlyMap<string, SigeSignals>,
  threshold: number,
): {
  readonly vetoed: boolean;
  readonly reasons: readonly string[];
  readonly convergenceRate: number;
  readonly diversityIndex: number;
} {
  const entries = [...signals.entries()];
  const agreements = entries
    .map(([, s]) => s.juryAgreement)
    .filter((a): a is number => typeof a === "number");
  const dissents = entries
    .map(([, s]) => s.dissent)
    .filter((d): d is number => typeof d === "number");

  const meanAgreement =
    agreements.length > 0 ? agreements.reduce((a, b) => a + b, 0) / agreements.length : 0;
  const meanDissent =
    dissents.length > 0 ? dissents.reduce((a, b) => a + b, 0) / dissents.length : 0;

  // Unique-title ratio over the candidate set; high dissent re-inflates it so a
  // polarizing round reads as diverse, not collapsed.
  const titles = entries.map(([id]) => id);
  const uniqueRatio = titles.length > 0 ? new Set(titles).size / titles.length : 1;
  const diversityIndex = Math.min(1, uniqueRatio * (1 + meanDissent) - meanDissent);

  const signal: ConvergenceSignal = {
    convergenceRate: meanAgreement,
    diversityIndex: Math.max(0, diversityIndex),
  };
  return convergenceVeto(signal, { maxConvergenceRate: threshold });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 "generate-wide" — pipeline-level widening helpers (SIGE-divergent
// merge, originality annotation, segment-spread enforcement, instrumentation).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 1 (generate-wide) — Build the grounded chain-of-evidence signals context
 * the SIGE divergent personas reason over. This is the SAME evidence the
 * synthesizer already consumes (trend / pain / capability summaries + deep-search
 * context) so divergent candidates stay evidence-tethered and the groundedness
 * acceptance gate is protected. Bounded slices keep the prompt size sane. PURE.
 */
export function buildSignalsContext(parts: {
  readonly trendsSummary: string;
  readonly painsSummary: string;
  readonly capabilitiesSummary: string;
  readonly deepSearchContext: string;
}): string {
  const sections: string[] = [];
  const push = (heading: string, body: string): void => {
    const trimmed = (body ?? "").trim();
    if (trimmed.length > 0) {
      sections.push(`=== ${heading} ===\n${trimmed.slice(0, 8000)}`);
    }
  };
  push("TRENDS", parts.trendsSummary);
  push("PAIN POINTS", parts.painsSummary);
  push("CAPABILITIES", parts.capabilitiesSummary);
  push("DEEP-SEARCH EVIDENCE", parts.deepSearchContext);
  return sections.join("\n\n");
}

/**
 * PHASE 1 (generate-wide) — Map one UNSCORED SIGE {@link DivergentCandidate} into
 * a {@link GeneratedIdeaCandidate} so it competes on the SAME GIANT scorecard /
 * dedup as the over-generated pool. qualityScore=0 and category="" mark it as
 * unscored (Pass-3 critique sets the real score). Provenance is tagged via
 * sourcesUsed so divergent ideas are auditable. PURE.
 */
export function mapDivergentToCandidate(
  divergent: DivergentCandidate,
  opts?: { readonly sourceTag?: string },
): GeneratedIdeaCandidate {
  // Backward compatible: the existing pipeline-phase caller passes no opts, so
  // the provenance tag stays `sige-divergent`. The autonomous discovery stage
  // passes sourceTag='sige-discovery' to distinguish broad-pool provenance.
  const tag = opts?.sourceTag ?? "sige-divergent";
  return {
    title: divergent.title,
    summary: divergent.summary,
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: `${tag} (${divergent.proposedBy})`,
    category: "",
    qualityScore: 0,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...(divergent.supportingSignalIds !== undefined
      ? { supportingSignalIds: divergent.supportingSignalIds }
      : {}),
  };
}

/**
 * AUTONOMOUS SIGE (depth stage) — Map one ranked {@link ScoredIdea} from the
 * EXISTING expert game into an UNSCORED {@link GeneratedIdeaCandidate} so it
 * competes on the SAME GIANT scorecard / dedup as every other candidate.
 *
 * Critically, this emits UNSCORED sentinels (`qualityScore=0`, `category=""`,
 * no `giant`/`giantComposite`): the back-half Pass-3 GIANT critique assigns the
 * real score and category. It deliberately does NOT follow
 * `cross-write.ts:scoredIdeaToCandidate`, which PRE-scores ideas (qualityScore
 * from fusedScore, category='sige') to bypass the synthesizer — pre-scoring
 * here would let autonomous (un-reviewed) deep-game output skip the GIANT jury.
 *
 * `ScoredIdea` carries no separate problem statement, signal-id array, or
 * structured fields, so those are left as empty sentinels. PURE.
 */
export function mapDeepGameRankedToCandidate(
  idea: ScoredIdea,
  opts?: { readonly sessionId?: string },
): GeneratedIdeaCandidate {
  return {
    title: idea.title,
    summary: idea.description,
    reasoning: idea.description,
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: `sige-deep (${opts?.sessionId ?? "session"})`,
    category: "",
    qualityScore: 0,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    // supportingSignalIds omitted: ScoredIdea carries no signal-id array.
    // giant/giantComposite NOT stamped: must not pre-score before the GIANT jury.
  };
}

/**
 * AUTONOMOUS SIGE — Merge the deep-game winners and the broad discovery pool
 * into a single candidate set for the back-half.
 *
 * Order: deep-game winners FIRST (they carry the ~45-min expert-game valuation),
 * then broad candidates whose title is not already present. Dedup key is
 * `title.trim().toLowerCase()` (case/whitespace-insensitive). Capped at
 * `opts.maxPool` (default 40 = generateWide.maxCandidates). PURE + immutable:
 * returns a new array and never mutates the inputs.
 */
export function mergeSigeCandidates(
  broad: readonly GeneratedIdeaCandidate[],
  deep: readonly GeneratedIdeaCandidate[],
  opts?: { readonly maxPool?: number },
): readonly GeneratedIdeaCandidate[] {
  const maxPool = opts?.maxPool ?? 40;
  if (maxPool <= 0) return [];

  const seen = new Set<string>();
  const merged: GeneratedIdeaCandidate[] = [];
  const key = (c: GeneratedIdeaCandidate): string => c.title.trim().toLowerCase();

  for (const c of [...deep, ...broad]) {
    if (merged.length >= maxPool) break;
    const k = key(c);
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    merged.push(c);
  }

  return merged;
}

/**
 * PHASE 1 (generate-wide) — Flag-gated SIGE divergent generation. When
 * sigeDivergent is OFF (default) returns [] (no-op, no SIGE call). When ON, runs
 * the divergent personas over the run's grounded signals and maps the results to
 * candidates for the synthesizer pool. generateDivergentIdeas NEVER throws (it
 * returns [] on failure) but we still wrap defensively so enabling this optional
 * widening path can never break the run. Capped at maxCandidates.
 */
async function fetchDivergentCandidates(
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
    log.warn("SIGE divergent generation failed — merging no divergent ideas", {
      err,
    });
    return [];
  }
}

/**
 * PHASE 1 (generate-wide) — Resolve a candidate's segment for spread accounting.
 * Prefers an explicit, persisted {@link SegmentId} tag (set by the synthesizer
 * when multiSegment is on); otherwise infers it from the candidate's free text.
 * `inferSegmentMatch` lets us distinguish a real keyword signal (score > 0) from
 * the consumer fallback (score === 0). PURE.
 */
function resolveCandidateSegment(candidate: GeneratedIdeaCandidate): SegmentId {
  if (candidate.segment !== undefined) return candidate.segment;
  return inferSegment(`${candidate.category} ${candidate.title} ${candidate.summary}`);
}

/**
 * PHASE 1 (generate-wide) — Enforce ROUGH segment spread on the final selected
 * set so a single run cannot collapse to ~100% one segment (the homogeneity bug).
 *
 * Greedy, quality-preserving, deterministic: walk the candidates in their
 * incoming (quality-sorted) order and admit each unless its segment already holds
 * the per-segment cap = ceil(limit * maxFraction). Over-capped candidates are
 * deferred and back-filled only if the spread-respecting pass leaves empty slots,
 * so we never return FEWER ideas than a plain slice would. Never reorders beyond
 * what the cap forces. PURE + immutable.
 *
 * @param maxFraction max share of the final set any one segment may occupy
 *   (default 0.5). Clamped to [1/|segments|, 1]; 1 disables the cap.
 */
export function enforceSegmentSpread(
  candidates: readonly GeneratedIdeaCandidate[],
  limit: number,
  maxFraction = 0.5,
): readonly GeneratedIdeaCandidate[] {
  if (limit <= 0) return [];
  if (candidates.length <= limit) return [...candidates];

  const floor = 1 / SEGMENT_IDS.length;
  const fraction = Math.min(1, Math.max(floor, maxFraction));
  const perSegmentCap = Math.max(1, Math.ceil(limit * fraction));

  const counts = new Map<SegmentId, number>();
  const admitted: GeneratedIdeaCandidate[] = [];
  const deferred: GeneratedIdeaCandidate[] = [];

  for (const candidate of candidates) {
    if (admitted.length >= limit) break;
    const segment = resolveCandidateSegment(candidate);
    const used = counts.get(segment) ?? 0;
    if (used < perSegmentCap) {
      counts.set(segment, used + 1);
      admitted.push(candidate);
    } else {
      deferred.push(candidate);
    }
  }

  // Back-fill remaining slots with the highest-quality deferred candidates so we
  // never shrink the output just because the cap was tight.
  if (admitted.length < limit) {
    for (const candidate of deferred) {
      if (admitted.length >= limit) break;
      admitted.push(candidate);
    }
  }

  return admitted;
}

/**
 * PHASE 1 (generate-wide) — Summarize how the kept candidates distribute across
 * the segment taxonomy. Pure instrumentation for the eval-gate spread metric:
 * returns a stable id→count record (zero-filled) plus the dominant share so a
 * single log line proves the pool is no longer ~100% one segment. PURE.
 */
export interface SegmentSpreadStats {
  readonly total: number;
  readonly counts: Readonly<Record<SegmentId, number>>;
  readonly dominantSegment: SegmentId;
  readonly dominantShare: number;
  /** How many candidates carried a real (score > 0) inferred/explicit segment. */
  readonly signalled: number;
}

export function summarizeSegmentSpread(
  candidates: readonly GeneratedIdeaCandidate[],
): SegmentSpreadStats {
  const counts = Object.fromEntries(SEGMENT_IDS.map((id) => [id, 0])) as Record<SegmentId, number>;

  let signalled = 0;
  for (const candidate of candidates) {
    const segment = resolveCandidateSegment(candidate);
    counts[segment] += 1;
    if (candidate.segment !== undefined) {
      signalled += 1;
    } else if (
      inferSegmentMatch(`${candidate.category} ${candidate.title} ${candidate.summary}`).score > 0
    ) {
      signalled += 1;
    }
  }

  const total = candidates.length;
  let dominantSegment: SegmentId = SEGMENT_IDS[0];
  let dominantCount = 0;
  for (const id of SEGMENT_IDS) {
    if (counts[id] > dominantCount) {
      dominantCount = counts[id];
      dominantSegment = id;
    }
  }

  return {
    total,
    counts,
    dominantSegment,
    dominantShare: total > 0 ? dominantCount / total : 0,
    signalled,
  };
}

/**
 * #13 — Assemble the optional deepSearch dependencies. The reranker `model` is
 * always supplied (deepSearch falls back to LLM-listwise rerank when no embedder
 * is present and the flag is on). The Mem0 client + userId are only built when
 * smart.knowledgeGraphRetrieval is on, so the default path constructs nothing.
 * deepSearch itself gates each enrichment on the smart flags it reads directly.
 */
function buildDeepSearchOptions(
  model: string,
  smart: SmartIdeasConfig,
  sigeConfig: SigeConfig | undefined,
): DeepSearchOptions {
  if (!smart.knowledgeGraphRetrieval) {
    return { model };
  }

  const baseUrl = sigeConfig?.mem0.baseUrl ?? "http://127.0.0.1:8050";
  const userId = sigeConfig?.mem0.userId ?? "sige-global";

  try {
    return { model, mem0: new Mem0Client({ baseUrl }), userId };
  } catch (err) {
    log.warn("Failed to build Mem0 client for graph retrieval — skipping graph branch", { err });
    return { model };
  }
}

export async function runIdeasPipeline(
  _pipelineId: string,
  config: PipelineConfig,
  runId: string,
  memoryManager?: MemoryManager | null,
): Promise<PipelineRunResult> {
  // Duplicate-dispatch guard: if this process is already executing this run, do
  // NOT run a second copy (it would re-run incomplete steps and orphan rows).
  // Resume guards before dispatch too; this is the last-resort check, placed
  // BEFORE the try so it can never trip the failure path that marks the live
  // run 'failed'. Return the run's last known summary (or a zero summary).
  if (!beginRun(runId)) {
    log.warn("Duplicate pipeline dispatch suppressed — run already executing", {
      runId,
    });
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

    // ── PHASE 4 (taste loop): LEARNED GIANT axis weights (gated calibrate-
    //    GiantWeights, default OFF). loadGiantWeights re-checks the flag and
    //    returns NEUTRAL (= GIANT_DEFAULT_WEIGHTS) when off / under-powered /
    //    on error, so the default path keeps the rubric spine untouched. The
    //    calibrated weights replace smart.giant.weights everywhere the pipeline
    //    aggregates GIANT (effectiveGiant), so axes that predict validation get
    //    bounded up-weighting. ──────────────────────────────────────────────────
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
    //    feedback). Used to bias collection ordering when adaptiveCollection is
    //    on; degrades to a no-op when empty. ──────────────────────────────────
    const credibilityPosteriors = smart.adaptiveCollection
      ? await loadCredibilityPosteriors()
      : new Map<string, number>();
    if (credibilityPosteriors.size > 0) {
      log.info("Loaded source-credibility posteriors", {
        keys: credibilityPosteriors.size,
      });
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
      // #4 part2: fold learned source-credibility posteriors into collector
      // selection. The map is keyed by credibilityKey(table, signalType,
      // category) and degrades to a no-op (multiplier 1.0) when empty, so it is
      // always safe to set. Only scanCapabilities consumes it today.
      credibilityPosteriors,
    };

    // ── Step 1: Analyze app landscape ───────────────────────────────────
    const trends = await runStep(
      runId,
      "landscape",
      () => analyzeAppLandscape(model, collectorCtx),
      (t) =>
        `${t.trendingCategories.length} underserved categories identified from ${t.summary.split("\n").length} data points${t.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Step 2: Cluster reviews (complaints + praises) ────────────────
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

    // ── Step 3: Scan capabilities ─────────────────────────────────────
    const capabilities = await runStep(
      runId,
      "capabilities",
      () => scanCapabilities(model, collectorCtx),
      (c) =>
        `${c.capabilities.length} capabilities from PH, HN, GitHub, Reddit, News, X${c.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Guard: short-circuit if no fresh source data ──────────────────
    if (
      capabilities.capabilities.length === 0 &&
      trends.trendingCategories.length === 0 &&
      pains.clusters.length === 0
    ) {
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

      await updatePipelineRun(runId, {
        status: "completed",
        resultSummary: summary,
        finishedAt: now(),
      });

      return { runId, summary };
    }

    // ── Demotion guard (default-OFF): when autonomous SIGE is the primary idea ─
    // ── engine, this pipeline's role is SIGNAL COLLECTOR only. The collectors  ─
    // ── above consumed and persisted signals; synthesis is SIGE's responsibility.
    // ── Default OFF (sigeAuto.enabled=false) = zero behavioral change.         ─
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

    // ── Step 4: Deep search (optional) ────────────────────────────────
    // #13 — when knowledgeGraphRetrieval is on, supply a Mem0 client + userId
    // so deepSearch can add a graph-retrieval branch. deepSearch reads the
    // smart flags itself; we only pass the dependencies. Building the client
    // never throws (it's a thin fetch wrapper) and the branch is silently
    // skipped inside deepSearch when the flag is off.
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

    // ── Step 5: Synthesize ideas at trend intersections ───────────────
    const saturatedThemes = await buildSaturatedThemes(memoryManager);

    // ── PHASE 4 (taste loop): build the GOLDEN + ANTI exemplar blocks from the
    //    recent scored-idea pool + all human-validated rows (graceful [] on
    //    failure). The selectors are PURE; rotation varies the slice per run and
    //    exemplarCount keeps the few-shot count LOW (anti-mode-collapse). Golden
    //    SUPERSEDES the legacy buildValidatedExemplars path under syntheticGolden:
    //    real human picks come first and replace synthetic ones above
    //    goldenMinHumanLabels. Anti-exemplars are the higher-leverage, safer
    //    genericness lever. Both honor the existing smart.validatedExemplars flag
    //    via synthesizeFromTrends' own re-gate. ──────────────────────────────────
    const scoredRows =
      taste.syntheticGolden || taste.antiExemplars ? await fetchScoredIdeaRows() : [];
    const tasteBlocks = buildTasteBlocks(scoredRows, taste, rotationSeed);

    // #5 — positive few-shot. When syntheticGolden is ON the taste golden block
    // (human-validated picks first, synthetic backfill cold-start) REPLACES the
    // legacy validated-exemplar block to avoid double-injection. When OFF, fall
    // back to the legacy human-validated few-shot path unchanged.
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
    // When smart.generateWide.sigeDivergent is ON, generate an extra UNSCORED
    // divergent-persona pool over the SAME grounded chain-of-evidence signals the
    // synthesizer consumes, and fold it into the synthesizer pool BEFORE Pass 3
    // so it competes on the SAME GIANT scorecard + dedup. Default OFF → no SIGE
    // call, no-op. Failure-tolerant (returns [] on any failure).
    const generateWide = smart.generateWide;
    const signalsContext = buildSignalsContext({
      trendsSummary: trends.summary,
      painsSummary: pains.summary,
      capabilitiesSummary: capabilities.summary,
      deepSearchContext,
    });
    const extraCandidates = await fetchDivergentCandidates(generateWide, signalsContext, model);

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
        }),
      (s) =>
        `Generated ${s.totalGenerated} idea candidates from trend intersections` +
        (extraCandidates.length > 0 ? ` (incl. ${extraCandidates.length} SIGE-divergent)` : ""),
    );

    // ── Step 6: Validate (3-layer dedup: exact + fuzzy + semantic) ────
    // PHASE 1 (generate-wide) — log the widened pool size BEFORE dedup so the
    // eval gate can watch the 3-layer dedup scale with over-generation.
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
    // Annotate each surviving candidate with its originality vs the known-product
    // corpus (Qdrant). Annotation-first: NEVER drops or reorders candidates — it
    // only stamps originality/nearestProduct/nearestSimilarity so they persist,
    // feed the eval harness, and drive the novelty-reserve final selection below.
    // Memory/Qdrant graceful-degrade: when memory is absent every candidate gets
    // a neutral originality of 1, so the default path is unaffected.
    if (kept.length > 0) {
      try {
        const annotated = await annotateOriginality(kept, memoryManager, {
          agentId: AGENT_ID,
        });
        kept = annotated;
        const withPriorArt = annotated.filter((c) => c.nearestProduct !== undefined).length;
        log.info("generate-wide: originality annotated", {
          candidates: annotated.length,
          withPriorArt,
        });
      } catch (err) {
        // Originality is additive; a failure must never break the pipeline.
        log.warn("Originality annotation failed — proceeding unannotated", {
          err,
        });
      }
    }

    // ── #8 part3: Chain-of-evidence verification ──────────────────────
    // Cross-check each candidate's emitted signal IDs against the real source
    // rows selected this run; drop fully-fabricated citations and record a
    // signalGrounding score. Gated behind smart.chainOfEvidence; degrades
    // gracefully (the verifier never throws). Empty when no candidates cited.
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
    // When smart.sigeValuation AND config.sige.enabled, route survivors through
    // the HARDENED SIGE path: native expert game → read-back UNION of Round-3
    // evolved children (re-grounded via verifyEvidence) → an INDEPENDENT
    // cross-family jury whose GIANT judgment is combined with SIGE's self-grade →
    // first-class DISSENT surfaced into the side-band signals consumed by Pareto
    // selection below. Wrapped so any SIGE/jury failure leaves the critique-based
    // scores untouched (never breaks the run). The side-band signals + the
    // convergence verdict are persisted (best-effort) for the eval A/B.
    let sigeSignals: ReadonlyMap<string, SigeSignals> = new Map();
    let sigeOn = false;
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

      // The read-back UNION may have introduced evolved children AFTER the
      // originality annotation above — re-annotate so every candidate (including
      // evolved ones) carries an originality score for Pareto selection. Graceful
      // (annotateOriginality never throws and degrades to neutral originality 1).
      try {
        kept = await annotateOriginality(kept, memoryManager, {
          agentId: AGENT_ID,
        });
      } catch (err) {
        log.warn("SIGE: re-annotation of originality failed — proceeding", {
          err,
        });
      }

      // CONVERGENCE-VETO: computeMetaGameHealth MEASURES convergence but nothing
      // GATES on it. Derive the signal from the jury's inter-judge agreement as a
      // robust, always-available proxy (a fully-converged jury ⇒ high agreement ⇒
      // collapse risk); fold dissent into diversity. When vetoed we log + do NOT
      // over-trust the consensus (selection below still runs, but the audit line
      // tells the eval A/B the round was collapse-prone so it can widen).
      const veto = computeSigeConvergenceVeto(sigeSignals, smart.sige.convergenceVetoThreshold);
      if (veto.vetoed) {
        const widen = smart.sige.convergenceVetoAction === "widen";
        log.warn("SIGE convergence veto fired — consensus is collapse-prone", {
          reasons: veto.reasons,
          convergenceRate: Number(veto.convergenceRate.toFixed(3)),
          diversityIndex: Number(veto.diversityIndex.toFixed(3)),
          action: widen ? "widen (discarding collapsed consensus)" : "log",
        });
        if (widen) {
          // Don't over-trust a collapsed consensus: drop the SIGE side-band so
          // the Pareto selection below falls back to the independent critique /
          // originality ordering. The candidates themselves are untouched.
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
    // Give every surviving candidate an EXTERNAL truth source for the GIANT
    // demand axis. enrichDemand extracts demand keywords from the candidate's own
    // text by CODE (no per-candidate LLM call), queries EXISTING scraped tables
    // (reddit_posts / news_articles) for real row COUNTS, and returns a cited,
    // deterministic DemandArtifact. We then RE-SCORE the GIANT demand axis from
    // artifact.score and RE-AGGREGATE the composite with hasDemandEvidence =
    // hasCitedDemand(artifact) — the Phase 2 unlock that lets ideas with REAL
    // cited buyer-intent escape the demand evidence-gate cap (<=2). The artifact
    // is kept in a side-map keyed by the (possibly rescored) candidate so it can
    // be persisted at store and bound into provenance. Gated behind
    // smart.demand.enabled; enrichDemand never throws (returns an absence
    // artifact on any failure) so the default path is always safe.
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
        // The optional demand path must never break the default run: on any
        // unexpected failure keep the un-enriched candidates and an empty map.
        log.warn("Demand enrichment failed — keeping un-enriched candidates", {
          err,
        });
        demandByCandidate.clear();
      }
    }

    // ── PHASE 0 (GIANT): shadow-mode hard-gate evaluation ──────────────
    // Re-evaluate the GIANT gate for each survivor using config weights + the
    // demand evidence-gate. The gate verdict is captured per-candidate so it can
    // be persisted (giant_gated) regardless of enforcement. SHADOW MODE by
    // default: gated ideas are NOT dropped — each would-kill is logged plus a
    // run-level summary of how many WOULD be killed. Only when
    // smart.giant.enforceGates is true do we actually filter gated candidates.
    // The whole branch is gated behind smart.giant.enabled and degrades to a
    // no-op (the existing minQualityScore filter still runs) otherwise.
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
            // Shadow-gate audit line: one per would-kill (title + reasons +
            // composite). Logged whether or not we actually enforce.
            log.info(
              enforceGiantGates
                ? "GIANT shadow gate: idea KILLED (enforced)"
                : "GIANT shadow gate: idea WOULD-KILL (shadow mode, kept)",
              {
                title: candidate.title,
                composite: gate.composite,
                gateReasons: gate.gateReasons,
              },
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
        // A failure in the optional GIANT gate must NOT break the default path:
        // fall back to the un-gated survivor set.
        log.warn("GIANT shadow gate evaluation failed — keeping all candidates", {
          err,
        });
        giantSurvivors = kept;
      }
    }

    const qualityFiltered = giantSurvivors.filter((c) => c.qualityScore >= config.minQualityScore);

    // ── PHASE 1/3: final selection (Pareto when SIGE on, else novelty-reserve) ──
    // The widened pool now carries originality (annotated above) the in-
    // synthesizer novelty-reserve could not see.
    //
    //   • SIGE ON (PHASE 3): replace the scalar sort with a Pareto frontier over
    //     (originality × dissent-adjusted SIGE/jury quality) + a Bradley-Terry
    //     pairwise tie-break, so a generic-but-polished idea cannot win on quality
    //     alone and principled dissent is never washed out. Then still enforce the
    //     segment cap so the SIGE-selected set cannot collapse to one segment.
    //   • SIGE OFF (default, PHASE 1): byte-for-byte the prior behaviour — re-run
    //     the novelty-reserve so high-originality survivors win reserved slots.
    //
    // Both paths are PURE, deterministic, and never grow the set beyond
    // config.maxIdeas. Default-path safe.
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

    // ── Step 7: Store ideas ───────────────────────────────────────────
    // #4 part1 — run-level provenance entries; narrowed per-idea below using
    // each candidate's cited signal tokens (chain-of-evidence binding).
    const runLevelProvenance: readonly ProvenanceEntry[] = [
      ...collectorCtx.selected.entries(),
    ].flatMap(([table, selectedIds]) => selectedIds.map((id) => ({ table, id })));

    // PHASE 4 (taste loop) — capture each successfully-stored idea alongside its
    // candidate so auto-proxy labels can be derived AFTER the store step from the
    // same demand/gate signals computed above. Filled inside the store loop.
    const storedPairs: Array<{
      readonly ideaId: string;
      readonly candidate: GeneratedIdeaCandidate;
    }> = [];

    const ideaIds = await runStep(
      runId,
      "store",
      async () => {
        // Resume-safety: the store step is the one non-idempotent step (it
        // inserts ideas in a loop). If a prior attempt was interrupted MID-store
        // and is now being re-run, clear any ideas already attached to this run
        // so the deterministic finalSelected set is re-stored exactly once.
        await getDb()`DELETE FROM generated_ideas WHERE pipeline_run_id = ${runId}`;

        const ids: string[] = [];
        for (const candidate of finalSelected) {
          try {
            const sourceLinksText =
              candidate.sourceLinks?.length > 0
                ? candidate.sourceLinks
                    .map((l) => `- [${l.title}](${l.url}) (${l.source})`)
                    .join("\n")
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

            // #4 part1 — narrow provenance to the source rows this idea cites.
            const baseProvenance = buildIdeaProvenance(
              candidate,
              capabilities.capabilities,
              runLevelProvenance,
            );

            // PHASE 2 (demand) — bind the demand artifact's cited evidence rows
            // (reddit_posts / news_articles, by sourceId) into provenance so the
            // demand grounding is auditable alongside the capability citations.
            // Deduped by {table,id}; absent demand artifact contributes nothing.
            const demandArtifact = demandByCandidate.get(candidate);
            const demandProvenance = demandArtifact ? demandProvenanceEntries(demandArtifact) : [];
            const provenanceSeen = new Set(baseProvenance.map((e) => `${e.table}:${e.id}`));
            const ideaProvenance: readonly ProvenanceEntry[] = [
              ...baseProvenance,
              ...demandProvenance.filter((e) => !provenanceSeen.has(`${e.table}:${e.id}`)),
            ];

            const idea = await insertIdea({
              agent_id: AGENT_ID,
              title: candidate.title,
              summary: candidate.summary,
              reasoning,
              sources_used: candidate.sourcesUsed,
              category: candidate.category || config.category,
              quality_score: Math.min(Math.max(candidate.qualityScore, 1), 5),
              pipeline_run_id: runId,
              source_ids_json: JSON.stringify(ideaProvenance),
            });

            // #12 part1 — stamp prompt_version + model and persist the full
            // Pass-3 critique breakdown (specificity, signalGrounding,
            // differentiation, buildability) as critique sub-scores when the
            // candidate matched a critique entry; otherwise fall back to the
            // per-idea signalGrounding alone. Best-effort (columns added by
            // migration 010); never breaks the insert.
            await stampIdeaQualityMeta(idea.id, {
              promptVersion: PROMPT_VERSION,
              model,
              signalGrounding: groundingByTitle.get(candidate.title),
              critiqueSubscores: candidate.critiqueSubscores,
            });

            // PHASE 0 (GIANT) — stamp the GIANT scorecard (migration 014
            // columns) in SHADOW mode: giant_gated is persisted regardless of
            // enforcement so kill-logs stay reviewable; we do NOT re-drop here.
            // Reuses the gate verdict computed at the quality gate when present
            // (config weights + demand evidence-gate); recomputes as a fallback.
            // Best-effort — never blocks the insert.
            if (smart.giant.enabled && candidate.giant !== undefined) {
              const gate =
                giantGateByCandidate.get(candidate) ??
                evaluateCandidateGiantGate(candidate, effectiveGiant);
              await stampIdeaGiant(idea.id, candidate, gate);
            }

            // PHASE 2 (demand) — stamp the cited DemandArtifact + resolved
            // segment (migration 015 columns: demand_json / demand_score /
            // whitespace / segment). The segment is persisted for EVERY idea
            // (previously orphaned) so downstream selection / the eval harness
            // can read it. Best-effort — validated via demandArtifactSchema and
            // swallows errors on pre-migration DBs; never blocks the insert.
            await stampIdeaDemand(
              idea.id,
              demandByCandidate.get(candidate),
              resolveCandidateSegment(candidate),
            );

            // PHASE 3 (SIGE hardening) — persist the jury / dissent / convergence
            // signals (best-effort, merged into giant_scores_json under `sige`)
            // so the eval A/B can compare SIGE-hardened vs self-critique. Empty
            // when SIGE was off, so the default path stamps nothing.
            await stampIdeaSigeSignals(idea.id, sigeSignals.get(candidateJoinId(candidate.title)));

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
            log.warn("Failed to save idea", { title: candidate.title, err });
          }
        }
        return ids;
      },
      (ids) => `Stored ${ids.length} ideas`,
    );

    // ── PHASE 4 (taste loop): AUTO-PROXY LABELS (gated autoProxyLabels) ─────────
    // Seed the cold calibration loop with cheap bootstrap labels: auto-ARCHIVE on
    // convergence-veto / very-low-GIANT / strong demand counter-evidence, and a
    // rare weak auto-VALIDATE on high-GIANT + grounded + multi-segment. Each event
    // is actor-tagged "proxy:<reason>" so it is clearly distinct from (and always
    // outweighed by) human labels — deriveProxyLabel never emits for an idea that
    // already carries a terminal human label. Wrapped so a failure can NEVER break
    // the run. Convergence-veto / grounded / distinct-segments are DERIVED here
    // from this run's signals (no persisted columns); missing fields just don't
    // trigger their rule (safe).
    if (taste.autoProxyLabels && storedPairs.length > 0) {
      try {
        // Run-level convergence veto (when SIGE ran): a collapsed/sycophantic
        // round is strong KILL counter-evidence applied across the batch.
        const convergenceVetoed = sigeOn
          ? computeSigeConvergenceVeto(sigeSignals, smart.sige.convergenceVetoThreshold).vetoed
          : undefined;

        // distinctSegments is a PER-IDEA multi-segment-credibility signal (gates
        // the rare weak auto-VALIDATE). Each candidate addresses ONE resolved
        // segment in this pipeline, so we leave it UNSET — the conjunctive
        // auto-VALIDATE simply won't over-fire (safe), keeping proxy labeling
        // biased toward the cheaper-to-trust ARCHIVE counter-evidence.
        const proxyInputs: readonly ScoredIdeaForProxy[] = storedPairs.map(
          ({ ideaId, candidate }) =>
            toScoredIdeaForProxy({
              ideaId,
              candidate,
              gate: giantGateByCandidate.get(candidate),
              artifact: demandByCandidate.get(candidate),
              // grounded ⇒ chain-of-evidence / boundSignalId / cited-demand presence.
              // candidateHasDemandEvidence reads exactly those signal-bound fields;
              // OR-in the demand artifact's cited rows so a code-cited demand probe
              // also counts as grounded.
              grounded:
                candidateHasDemandEvidence(candidate) ||
                (demandByCandidate.get(candidate)?.evidence.length ?? 0) > 0,
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
            prompt_version: PROMPT_VERSION,
            model,
          });
          if (row !== null) written += 1;
        }
        log.info("Phase 4 taste: auto-proxy labels written", {
          candidates: proxyInputs.length,
          derived: proxyLabels.length,
          written,
        });
      } catch (err) {
        log.warn("Phase 4 taste: auto-proxy labeling failed — skipping", { err });
      }
    }

    // ── Mark consumed signals ─────────────────────────────────────────
    // Run sequentially to avoid overwhelming the database with parallel writes.
    for (const [table, ids] of collectorCtx.selected) {
      await markConsumed(runId, table, ids);
    }

    // ── Finalize ──────────────────────────────────────────────────────
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

    await updatePipelineRun(runId, {
      status: "completed",
      resultSummary: summary,
      finishedAt: now(),
    });

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
    // Release the in-process slot so a later resume (after a real restart or a
    // genuine failure) can re-dispatch this id.
    endRun(runId);
  }
}
