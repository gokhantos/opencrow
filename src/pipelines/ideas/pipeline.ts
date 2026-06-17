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

import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import { loadConfig } from "../../config/loader";
import type { MemoryManager } from "../../memory/types";
import { insertIdea, getIdeasByStage } from "../../sources/ideas/store";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import {
  updatePipelineRun,
  createPipelineStep,
  updatePipelineStep,
} from "../store";
import { analyzeAppLandscape, clusterReviews, scanCapabilities } from "./collectors";
import type { CollectorContext } from "./collectors";
import {
  synthesizeFromTrends,
  deepSearch,
  buildValidatedExemplars,
  signalCitationToken,
} from "./synthesizer";
import type { ValidatedExemplar, DeepSearchOptions } from "./synthesizer";
import type { SmartIdeasConfig, SigeConfig, GiantConfig } from "../../config/schema";
import { aggregateGiant } from "./giant";
import { checkForDuplicates, verifyEvidence, annotateOriginality } from "./validate";
import { getConsumedIds, markConsumed } from "./consumption";
import { getSourceCredibility, credibilityKey } from "./credibility";
import { evaluateCandidates } from "../../sige/simulation/expert-game";
import type { CandidateIdea } from "../../sige/simulation/expert-game";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import {
  generateDivergentIdeas,
  DEFAULT_SIGE_SESSION_CONFIG,
} from "../../sige/run";
import type { DivergentCandidate } from "../../sige/run";
import { selectWithNoveltyReserve } from "./generate-wide";
import { inferSegment, inferSegmentMatch, SEGMENT_IDS } from "./segments";
import type { SegmentId } from "./segments";
import type { GenerateWideConfig } from "../../config/schema";
import type { Capability, GeneratedIdeaCandidate } from "./types";

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

async function runStep<T>(
  runId: string,
  stepName: string,
  work: () => Promise<T>,
  formatOutput: (result: T) => string,
): Promise<T> {
  const step = await createPipelineStep({ runId, stepName });
  const start = nowMs();
  try {
    const result = await work();
    await updatePipelineStep(step.id, {
      status: "completed",
      outputSummary: formatOutput(result),
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

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "are", "was",
  "be", "has", "had", "have", "will", "can", "do", "does", "your", "you",
  "app", "tool", "platform", "system", "based", "using", "new", "smart",
]);

function tokenize(title: string): readonly string[] {
  return title.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter((w) => w.length >= 3);
}

function extractThemesByNgrams(
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
      const results = await memoryManager.search(
        "shared",
        `${row.title}: ${row.summary}`,
        { limit: 3, minScore: 0.7, kinds: ["idea"] },
      );
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
    const whyNowJson =
      candidate.whyNow !== undefined ? JSON.stringify(candidate.whyNow) : null;
    const archetype = candidate.archetype ?? null;
    const painSeverity =
      candidate.painSeverity ?? candidate.giant.acuteProblem ?? null;

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
export function candidateHasDemandEvidence(
  candidate: GeneratedIdeaCandidate,
): boolean {
  const demandEvidence = candidate.giantEvidence?.demand?.trim() ?? "";
  if (demandEvidence.length > 0) return true;
  return (candidate.whyNow ?? []).some(
    (shift) =>
      typeof shift.boundSignalId === "string" &&
      shift.boundSignalId.trim().length > 0,
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

/**
 * #7 — Route survivors through the SIGE expert game and override each
 * candidate's qualityScore with the agent-graded expertScore (mapped 0-1 → 1-5,
 * matching the critique-score scale). Results join by TITLE. Any candidate the
 * game drops (blank title) keeps its critique score as a fallback.
 *
 * EXPENSIVE: makes multi-agent LLM calls. Caller must already have checked the
 * smart.sigeValuation + config.sige.enabled gate. Wrapped so SIGE failure
 * degrades to the unchanged critique-scored candidates (never throws).
 */
async function applySigeValuation(
  candidates: readonly GeneratedIdeaCandidate[],
  sigeConfig: SigeConfig,
  deepSearchContext: string,
): Promise<readonly GeneratedIdeaCandidate[]> {
  try {
    const sigeCandidates: CandidateIdea[] = candidates.map((c) => ({
      title: c.title,
      summary: c.summary,
      description: c.reasoning,
      // Seed prior from the critique score (1-5) back to [0,1].
      expertScore: Math.min(Math.max((c.qualityScore - 1) / 4, 0), 1),
    }));

    const evaluations = await evaluateCandidates(sigeCandidates, {
      mem0: new Mem0Client({ baseUrl: sigeConfig.mem0.baseUrl }),
      userId: sigeConfig.mem0.userId,
      enrichedSeed: deepSearchContext || undefined,
    });

    const scoreByTitle = new Map<string, number>();
    for (const ev of evaluations) {
      scoreByTitle.set(ev.title.toLowerCase().trim(), ev.expertScore);
    }

    const rescored = candidates.map((c) => {
      const expert = scoreByTitle.get(c.title.toLowerCase().trim());
      if (expert === undefined) return c;
      // Map SIGE expertScore [0,1] → 1-5 quality scale.
      const sigeQuality = 1 + Math.min(Math.max(expert, 0), 1) * 4;
      return { ...c, qualityScore: sigeQuality };
    });

    log.info("SIGE valuation applied", {
      candidates: candidates.length,
      evaluated: evaluations.length,
    });

    return rescored;
  } catch (err) {
    log.warn("SIGE valuation failed — keeping critique scores", { err });
    return candidates;
  }
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
): GeneratedIdeaCandidate {
  return {
    title: divergent.title,
    summary: divergent.summary,
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: `sige-divergent (${divergent.proposedBy})`,
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
      .map(mapDivergentToCandidate)
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
  return inferSegment(
    `${candidate.category} ${candidate.title} ${candidate.summary}`,
  );
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
  const counts = Object.fromEntries(
    SEGMENT_IDS.map((id) => [id, 0]),
  ) as Record<SegmentId, number>;

  let signalled = 0;
  for (const candidate of candidates) {
    const segment = resolveCandidateSegment(candidate);
    counts[segment] += 1;
    if (candidate.segment !== undefined) {
      signalled += 1;
    } else if (
      inferSegmentMatch(
        `${candidate.category} ${candidate.title} ${candidate.summary}`,
      ).score > 0
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
      (t) => `${t.trendingCategories.length} underserved categories identified from ${t.summary.split("\n").length} data points${t.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Step 2: Cluster reviews (complaints + praises) ────────────────
    const focusCategories = trends.trendingCategories.length > 0
      ? trends.trendingCategories.map((c) => c.category)
      : undefined;

    const pains = await runStep(
      runId,
      "reviews",
      () => clusterReviews(focusCategories, model, collectorCtx),
      (p) => `${p.clusters.length} review clusters across ${[...new Set(p.clusters.map((c) => c.category))].length} categories (complaints + praises)${p.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Step 3: Scan capabilities ─────────────────────────────────────
    const capabilities = await runStep(
      runId,
      "capabilities",
      () => scanCapabilities(model, collectorCtx),
      (c) => `${c.capabilities.length} capabilities from PH, HN, GitHub, Reddit, News, X${c.insights ? " (with LLM insights)" : ""}`,
    );

    // ── Guard: short-circuit if no fresh source data ──────────────────
    if (
      capabilities.capabilities.length === 0 &&
      trends.trendingCategories.length === 0 &&
      pains.clusters.length === 0
    ) {
      log.warn("No fresh source data available — all sources already consumed. Skipping synthesis.", { runId });

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

    // #5 — positive few-shot from human-validated ideas. Built unconditionally;
    // synthesizeFromTrends re-gates injection via smart.validatedExemplars.
    const validatedExemplars = buildValidatedExemplars(
      await fetchValidatedExemplars(),
    );

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
    const extraCandidates = await fetchDivergentCandidates(
      generateWide,
      signalsContext,
      model,
    );

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
          category: config.category,
          maxIdeas: config.maxIdeas,
          model,
          extraCandidates,
        }),
      (s) =>
        `Generated ${s.totalGenerated} idea candidates from trend intersections` +
        (extraCandidates.length > 0
          ? ` (incl. ${extraCandidates.length} SIGE-divergent)`
          : ""),
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
        const withPriorArt = annotated.filter(
          (c) => c.nearestProduct !== undefined,
        ).length;
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

    // ── #7: SIGE valuation gate (DEFAULT OFF) ─────────────────────────
    // When smart.sigeValuation AND config.sige.enabled, route survivors through
    // the SIGE expert game and override qualityScore with the expertScore (1-5
    // scale). Wrapped in try/catch so a SIGE failure leaves the critique-based
    // scores untouched (never breaks the run).
    if (smart.sigeValuation && sigeConfig?.enabled && kept.length > 0) {
      kept = await applySigeValuation(kept, sigeConfig, deepSearchContext);
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
    const giantGateByCandidate = new Map<
      GeneratedIdeaCandidate,
      CandidateGiantGate
    >();
    let giantSurvivors = kept;

    if (smart.giant.enabled && kept.length > 0) {
      try {
        const enforceGiantGates = smart.giant.enforceGates === true;
        let wouldKillCount = 0;

        for (const candidate of kept) {
          const gate = evaluateCandidateGiantGate(candidate, smart.giant);
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
          giantSurvivors = kept.filter(
            (c) => giantGateByCandidate.get(c)?.gated !== true,
          );
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

    const qualityFiltered = giantSurvivors.filter(
      (c) => c.qualityScore >= config.minQualityScore,
    );

    // ── PHASE 1 (generate-wide): final selection (novelty-reserve + spread) ──
    // The widened pool now carries originality (annotated above) the in-
    // synthesizer novelty-reserve could not see. Re-run the novelty-reserve at
    // the pipeline level so high-originality survivors win their reserved slots,
    // then enforce a rough segment cap so the final set cannot collapse to one
    // segment (the homogeneity bug). Both are PURE, deterministic, and never
    // grow the set beyond config.maxIdeas. Default-path safe: with originality
    // neutral (no memory) novelty-reserve falls back to inverted verbalizedProb,
    // and the spread cap only binds when the pool exceeds maxIdeas.
    let finalSelected: readonly GeneratedIdeaCandidate[] = qualityFiltered;
    if (qualityFiltered.length > config.maxIdeas) {
      const reserved = selectWithNoveltyReserve(
        qualityFiltered,
        config.maxIdeas,
      );
      finalSelected = enforceSegmentSpread(reserved, config.maxIdeas);
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
      (r) => `${r.kept} kept, ${r.semanticDupes} semantic duplicates, ${r.belowThreshold} below threshold, ${r.giantGated} GIANT-gated, ${r.fabricatedDropped} evidence-flagged`,
    );

    // ── Step 7: Store ideas ───────────────────────────────────────────
    // #4 part1 — run-level provenance entries; narrowed per-idea below using
    // each candidate's cited signal tokens (chain-of-evidence binding).
    const runLevelProvenance: readonly ProvenanceEntry[] = [
      ...collectorCtx.selected.entries(),
    ].flatMap(([table, selectedIds]) =>
      selectedIds.map((id) => ({ table, id })),
    );

    const ideaIds = await runStep(
      runId,
      "store",
      async () => {
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
            const ideaProvenance = buildIdeaProvenance(
              candidate,
              capabilities.capabilities,
              runLevelProvenance,
            );

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
                evaluateCandidateGiantGate(candidate, smart.giant);
              await stampIdeaGiant(idea.id, candidate, gate);
            }

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
          } catch (err) {
            log.warn("Failed to save idea", { title: candidate.title, err });
          }
        }
        return ids;
      },
      (ids) => `Stored ${ids.length} ideas`,
    );

    // ── Mark consumed signals ─────────────────────────────────────────
    // Run sequentially to avoid overwhelming the database with parallel writes.
    for (const [table, ids] of collectorCtx.selected) {
      await markConsumed(runId, table, ids);
    }

    // ── Finalize ──────────────────────────────────────────────────────
    const summary: PipelineResultSummary = {
      totalSourcesQueried: 8,
      totalSignalsFound: trends.risingApps.length + pains.clusters.length + capabilities.capabilities.length,
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
  }
}
