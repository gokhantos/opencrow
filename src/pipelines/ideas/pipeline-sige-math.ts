/**
 * Pure SIGE math + candidate-mapping helpers for the ideas pipeline.
 *
 * Everything in this module is PURE (no DB, no LLM, no clock, no RNG):
 *   - SIGE × jury score combination
 *   - Dissent normalization
 *   - Pairwise-win construction for Bradley-Terry
 *   - Convergence-veto derivation
 *   - Pareto + segment-spread selection
 *   - Signals context and enriched-seed builders
 *   - Candidate mappers (divergent, deep-game, evolved)
 * Extracted from pipeline.ts to keep that file under the 800-line ceiling.
 */

import type { AiProvider } from "../../agent/types";
import type { DivergentCandidate } from "../../sige/run";
import type { ScoredIdea } from "../../sige/types";
import {
  bradleyTerryRank,
  type ConvergenceSignal,
  convergenceVeto,
  dissentAdjustedScore,
  type PairwiseWin,
  paretoFrontier,
} from "./sige-select";
import type { GiantAxisScores } from "./giant";
import { GIANT_AXIS_KEYS } from "./giant";
import { DEFAULT_JURY_PANEL, type JudgeModel } from "./jury";
import type { SegmentId } from "./segments";
import { inferSegment, inferSegmentMatch, SEGMENT_IDS } from "./segments";
import type { GeneratedIdeaCandidate } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 types
// ─────────────────────────────────────────────────────────────────────────────

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

/** PHASE 1 (generate-wide) — Segment spread summary (PURE). */
export interface SegmentSpreadStats {
  readonly total: number;
  readonly counts: Readonly<Record<SegmentId, number>>;
  readonly dominantSegment: SegmentId;
  readonly dominantShare: number;
  /** How many candidates carried a real (score > 0) inferred/explicit segment. */
  readonly signalled: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal score-conversion helpers (also used by pipeline-runner.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** SIGE expertScore is in [0,1]; the pipeline qualityScore is on the 1..5 scale. */
export function expertToQuality(expertScore: number): number {
  return 1 + Math.min(Math.max(expertScore, 0), 1) * 4;
}

/** The 1..5 qualityScore mapped back to a [0,1] expert prior. PURE. */
export function qualityToExpert(qualityScore: number): number {
  return Math.min(Math.max((qualityScore - 1) / 4, 0), 1);
}

/**
 * PHASE 3 — A stable id for joining SIGE/jury verdicts back to candidates. We
 * derive it from the normalized title so it is reproducible across the SIGE
 * round (which keys results by title) and the jury (which is given this id). PURE.
 */
export function candidateJoinId(title: string): string {
  return title.toLowerCase().trim();
}

/** Runtime guard for a 7-axis GIANT scorecard (every axis a finite number). PURE. */
export function isGiantAxisScores(value: unknown): value is GiantAxisScores {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return GIANT_AXIS_KEYS.every((key) => typeof rec[key] === "number" && Number.isFinite(rec[key]));
}

/**
 * PHASE 3 — Re-key a candidate→signals side-map onto a TITLE-keyed map (by the
 * stable join id), so signals survive the immutable rescores downstream (which
 * produce NEW candidate objects) and rejoin reliably. PURE.
 */
export function remapSignals(
  signals: ReadonlyMap<GeneratedIdeaCandidate, SigeSignals>,
): ReadonlyMap<string, SigeSignals> {
  const byJoinId = new Map<string, SigeSignals>();
  for (const [cand, sig] of signals) {
    byJoinId.set(candidateJoinId(cand.title), sig);
  }
  return byJoinId;
}

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

/**
 * PHASE 1 (generate-wide) — Resolve a candidate's segment for spread accounting.
 * Prefers an explicit, persisted {@link SegmentId} tag (set by the synthesizer
 * when multiSegment is on); otherwise infers it from the candidate's free text.
 * `inferSegmentMatch` lets us distinguish a real keyword signal (score > 0) from
 * the consumer fallback (score === 0). PURE.
 */
export function resolveCandidateSegment(candidate: GeneratedIdeaCandidate): SegmentId {
  if (candidate.segment !== undefined) return candidate.segment;
  return inferSegment(`${candidate.category} ${candidate.title} ${candidate.summary}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — pure math
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 (generate-wide) — candidate mappers and selection helpers
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
 * PHASE 3 — Re-bind a SIGE Round-3 evolved/recombined CHILD (a title returned by
 * SIGE that did NOT exist in the input pool) into a {@link GeneratedIdeaCandidate}
 * so it competes in the SAME selection as the seed pool. The child is tagged
 * origin "sige-evolved"; verifyEvidence later HARD-PENALIZES it if it cannot be
 * re-grounded against this run's real signals. PURE.
 */
export function mapEvolvedEvaluation(view: {
  readonly title: string;
  readonly expertScore: number;
  readonly description?: string;
  readonly giantScores?: GiantAxisScores;
  readonly evidenceRef?: readonly string[];
  readonly dissent?: number;
  readonly origin?: "seed" | "evolved";
}): GeneratedIdeaCandidate {
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
