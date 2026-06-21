/**
 * Idea-stamping, provenance, and demand helpers for the ideas pipeline.
 *
 * Contains:
 *   - CandidateGiantGate: pipeline-level GIANT verdict type
 *   - stampIdeaAllMeta: single-round-trip UPDATE for all optional columns
 *   - buildIdeaProvenance: per-idea cited-signal → source-table binding
 *   - demandProvenanceEntries / buildDemandEvidenceString: demand provenance
 *   - candidateHasDemandEvidence / evaluateCandidateGiantGate: GIANT gate
 *   - toDemandCandidateText / buildEnrichDemandConfig: demand phase mappers
 *   - applyDemandRescore: GIANT demand axis rescore from cited artifact
 *   - DemandCoverageStats / summarizeDemandCoverage: demand instrumentation
 *   - rotationSeedFromRunId: per-run taste-loop rotation seed
 *   - toScoredIdeaForProxy: proxy-label input mapper
 * Extracted from pipeline.ts to keep that file under the 800-line ceiling.
 */

import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import type { DemandConfig, GiantConfig } from "../../config/schema";
import type { DemandArtifact, DemandCandidateText } from "./demand";
import { demandArtifactSchema, hasCitedDemand, DEMAND_SCORE_MAX } from "./demand";
import type { EnrichDemandConfig } from "./demand-probes";
import type { ScoredIdeaForProxy } from "./feedback-bootstrap";
import type { GiantAxisKey, GiantAxisScores } from "./giant";
import { aggregateGiant } from "./giant";
import { compositeToQualityScore } from "./synthesizer";
import type { GeneratedIdeaCandidate } from "./types";
import { candidateJoinId, type SigeSignals } from "./pipeline-sige-math";

const log = createLogger("pipeline:ideas");

// ─────────────────────────────────────────────────────────────────────────────
// Core types
// ─────────────────────────────────────────────────────────────────────────────

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

/** A {table, id} provenance entry written into generated_ideas.source_ids_json. */
export interface ProvenanceEntry {
  readonly table: string;
  readonly id: string;
}

/**
 * The pipeline-level GIANT verdict for one candidate (composite + gate state).
 * Defined here to avoid circular dependencies between pipeline-stamps and the
 * orchestrator barrel; re-exported from pipeline.ts for backward-compat.
 */
export interface CandidateGiantGate {
  readonly composite: number;
  readonly gated: boolean;
  readonly gateReasons: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Source-table mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a capability's scraper `source` id to its underlying DB table, so a
 * cited signal token can be narrowed to the source rows that produced it.
 */
export const SOURCE_TO_TABLE: Readonly<Record<string, string>> = {
  producthunt: "ph_products",
  hackernews: "hn_stories",
  github: "github_repos",
  reddit: "reddit_posts",
  news: "news_articles",
  x: "x_scraped_tweets",
};

// ─────────────────────────────────────────────────────────────────────────────
// Provenance helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #4 part1 — Build PER-IDEA provenance. Resolves a candidate's emitted signal
 * tokens (`<source>_<index>` over capabilities) to the source TABLES they came
 * from, then scopes the run-level provenance to just those tables. Falls back to
 * the full run-level provenance when the candidate cited nothing or no citation
 * resolved to a known table. Pure.
 */
export function buildIdeaProvenance(
  candidate: GeneratedIdeaCandidate,
  capabilities: readonly { readonly source: string }[],
  runLevelEntries: readonly ProvenanceEntry[],
  signalCitationTokenFn: (source: string, index: number) => string,
): readonly ProvenanceEntry[] {
  const cited = candidate.supportingSignalIds ?? [];
  if (cited.length === 0) return runLevelEntries;

  const tables = new Set<string>();
  capabilities.forEach((cap, index) => {
    const token = signalCitationTokenFn(cap.source, index);
    if (cited.some((c) => c.toLowerCase() === token)) {
      const table = SOURCE_TO_TABLE[cap.source.toLowerCase()];
      if (table) tables.add(table);
    }
  });

  if (tables.size === 0) return runLevelEntries;

  const scoped = runLevelEntries.filter((e) => tables.has(e.table));
  return scoped.length > 0 ? scoped : runLevelEntries;
}

/** Provenance entries carried by a demand artifact's cited evidence rows. */
export function demandProvenanceEntries(artifact: DemandArtifact): readonly ProvenanceEntry[] {
  const tableByKind: Readonly<Record<string, string>> = {
    reddit_intent: "reddit_posts",
    funding_news: "news_articles",
  };
  const seen = new Set<string>();
  const entries: ProvenanceEntry[] = [];
  for (const e of artifact.evidence) {
    const table = tableByKind[e.kind];
    if (table === undefined) continue;
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

// ─────────────────────────────────────────────────────────────────────────────
// GIANT gate helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 0 (GIANT) — Best-effort demand-evidence check at the pipeline boundary.
 * Mirrors synthesizer.hasDemandEvidence but reads the candidate's persisted
 * GIANT fields instead of a freshly-parsed critique. Errs toward CAPPING (false)
 * when there is no concrete evidence. Pure.
 */
export function candidateHasDemandEvidence(candidate: GeneratedIdeaCandidate): boolean {
  const demandEvidence = candidate.giantEvidence?.demand?.trim() ?? "";
  if (demandEvidence.length > 0) return true;
  return (candidate.whyNow ?? []).some(
    (shift) => typeof shift.boundSignalId === "string" && shift.boundSignalId.trim().length > 0,
  );
}

/**
 * PHASE 0 (GIANT) — Re-evaluate the GIANT gate for a candidate at the pipeline
 * boundary using the configured weights + demand evidence-gate. When the candidate
 * carries the raw 7-axis `giant` scores we recompute via {@link aggregateGiant}.
 * When the raw scores are absent we fall back to the GIANT fields the synthesizer
 * already stamped, defaulting to "not gated". PURE — no DB / clock / rng.
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

  return {
    composite: candidate.giantComposite ?? candidate.qualityScore,
    gated: candidate.giantGated === true,
    gateReasons: candidate.giantGateReasons ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 (demand) — pure mappers + rescore
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
    reviewComplaint: demand.reviewComplaint,
    hnIntent: demand.hnIntent,
    xIntent: demand.xIntent,
    weakIntent: demand.weakIntent,
    weakIntentFactor: demand.weakIntentFactor,
    weakIntentMinEngagement: demand.weakIntentMinEngagement,
    fuzzyMatch: demand.fuzzyMatch,
    phSupply: demand.phSupply,
    externalTrends: demand.externalTrends,
    minMatches: demand.minMatches,
    minKeywordHits: demand.minKeywordHits,
    ...(knobs.windowSec !== undefined ? { windowSec: knobs.windowSec } : {}),
    ...(knobs.limit !== undefined ? { limit: knobs.limit } : {}),
    ...(knobs.supplyDensity !== undefined ? { supplyDensity: knobs.supplyDensity } : {}),
  };
}

/**
 * PHASE 2 (demand) — RE-SCORE the GIANT demand axis from the cited
 * {@link DemandArtifact} and RE-AGGREGATE the composite so ideas with REAL cited
 * demand evidence escape the demand evidence-gate cap (<=2). This is the Phase 2
 * unlock.
 *
 * DETERMINISTIC + IMMUTABLE — returns a NEW candidate (never mutates). When the
 * candidate carries no raw GIANT scorecard there is nothing to rescore — the
 * candidate is returned unchanged. PURE — no DB / clock / rng.
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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 (demand) — coverage instrumentation
// ─────────────────────────────────────────────────────────────────────────────

/** Run-level demand-coverage instrumentation (PURE). */
export interface DemandCoverageStats {
  readonly total: number;
  readonly cited: number;
  readonly citedShare: number;
  readonly meanDemandScore: number;
  readonly meanWhitespace: number;
}

/**
 * PHASE 2 (demand) — Summarize demand coverage across the surviving candidates.
 * PURE: reads the artifacts keyed by the candidate's normalized-title JOIN id
 * ({@link candidateJoinId}) — NOT by object reference, so the lookup survives the
 * GIANT-gate / jury / selection transforms that replace candidate objects. Absent
 * artifacts count toward `total` with a 0 contribution. Means are over the full set.
 */
export function summarizeDemandCoverage(
  candidates: readonly GeneratedIdeaCandidate[],
  artifacts: ReadonlyMap<string, DemandArtifact>,
): DemandCoverageStats {
  const total = candidates.length;
  let cited = 0;
  let scoreSum = 0;
  let whitespaceSum = 0;

  for (const candidate of candidates) {
    const artifact = artifacts.get(candidateJoinId(candidate.title));
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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 (taste loop) — rotation seed + proxy input mapper
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

/**
 * PHASE 4 — Map a stored idea + its run-derived signals onto the
 * {@link ScoredIdeaForProxy} the proxy-label rules consume. PURE.
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

// ─────────────────────────────────────────────────────────────────────────────
// Single-round-trip stamp UPDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All optional per-idea stamp columns merged into a single UPDATE (B3 perf).
 * Previously four sequential awaited UPDATEs; collapsed to one so the store
 * loop emits a single round-trip to Postgres per idea instead of five.
 *
 * MIGRATION ASSUMPTION: this function writes columns introduced by migrations
 * 010 (critique_subscores_json, prompt_version, model), 014 (giant_scores_json,
 * why_now_json, archetype, pain_severity, giant_composite, giant_gated),
 * 015 (demand_json, demand_score, whitespace, segment), and 016
 * (sige_signals_json). All four migrations run idempotently at startup, so every
 * column is guaranteed present in any running system.
 */
export async function stampIdeaAllMeta(
  ideaId: string,
  qualityMeta: StampIdeaQualityMetaParams,
  giantCandidate?: { readonly candidate: GeneratedIdeaCandidate; readonly gate: CandidateGiantGate },
  demandArgs?: { readonly artifact: DemandArtifact | undefined; readonly segment: string },
  sigeSignals?: SigeSignals,
): Promise<void> {
  try {
    // ── quality meta (migration 010) ──────────────────────────────────────────
    const subscores =
      qualityMeta.critiqueSubscores !== undefined
        ? JSON.stringify(qualityMeta.critiqueSubscores)
        : qualityMeta.signalGrounding !== undefined
          ? JSON.stringify({ signalGrounding: qualityMeta.signalGrounding })
          : null;

    // ── GIANT scorecard (migration 014) ───────────────────────────────────────
    const hasGiant =
      giantCandidate !== undefined && giantCandidate.candidate.giant !== undefined;
    const giantScoresJson = hasGiant
      ? JSON.stringify({
          scores: giantCandidate!.candidate.giant,
          evidence: giantCandidate!.candidate.giantEvidence ?? {},
        })
      : null;
    const whyNowJson =
      hasGiant && giantCandidate!.candidate.whyNow !== undefined
        ? JSON.stringify(giantCandidate!.candidate.whyNow)
        : null;
    const archetype = hasGiant ? (giantCandidate!.candidate.archetype ?? null) : null;
    const painSeverity = hasGiant
      ? (giantCandidate!.candidate.painSeverity ??
          giantCandidate!.candidate.giant!.acuteProblem ??
          null)
      : null;
    const giantComposite = hasGiant ? giantCandidate!.gate.composite : null;
    const giantGated = hasGiant ? giantCandidate!.gate.gated : null;

    // ── demand artifact (migration 015) ───────────────────────────────────────
    const { artifact, segment } = demandArgs ?? { artifact: undefined, segment: "consumer" };
    const demandParsed =
      artifact !== undefined ? demandArtifactSchema.safeParse(artifact) : undefined;
    const demandJson =
      demandParsed !== undefined && demandParsed.success
        ? JSON.stringify(demandParsed.data)
        : null;
    const demandScore =
      demandParsed !== undefined && demandParsed.success ? demandParsed.data.score : null;
    const whitespace =
      demandParsed !== undefined && demandParsed.success ? demandParsed.data.whitespace : null;

    // ── SIGE signals (migration 016) ──────────────────────────────────────────
    const sigeJson =
      sigeSignals !== undefined
        ? JSON.stringify({
            expertScore: sigeSignals.expertScore,
            ...(sigeSignals.juryScore !== undefined ? { juryScore: sigeSignals.juryScore } : {}),
            ...(sigeSignals.juryAgreement !== undefined
              ? { juryAgreement: sigeSignals.juryAgreement }
              : {}),
            ...(sigeSignals.dissent !== undefined ? { dissent: sigeSignals.dissent } : {}),
            ...(sigeSignals.judgeCount !== undefined
              ? { judgeCount: sigeSignals.judgeCount }
              : {}),
            ...(sigeSignals.evolved ? { evolved: true } : {}),
          })
        : null;

    const db = getDb();
    await db`
      UPDATE generated_ideas
      SET prompt_version      = ${qualityMeta.promptVersion},
          model               = ${qualityMeta.model},
          critique_subscores_json = ${subscores}::jsonb,
          giant_scores_json   = ${giantScoresJson}::jsonb,
          why_now_json        = ${whyNowJson}::jsonb,
          archetype           = ${archetype},
          pain_severity       = ${painSeverity},
          giant_composite     = ${giantComposite},
          giant_gated         = ${giantGated},
          demand_json         = ${demandJson}::jsonb,
          demand_score        = ${demandScore},
          whitespace          = ${whitespace},
          segment             = ${segment},
          sige_signals_json   = ${sigeJson}::jsonb
      WHERE id = ${ideaId}
    `;
  } catch (err) {
    log.warn("Failed to stamp idea metadata", { ideaId, err });
  }
}
