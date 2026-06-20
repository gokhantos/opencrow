/**
 * INDEPENDENT CROSS-FAMILY JURY — the #1 anti-sycophancy fix for the SIGE
 * hardening phase.
 *
 * SIGE's native scores are mean-pooled from the SAME agents that PROPOSE the
 * ideas, all on ONE model family. That is a sycophancy trap: a generator that
 * also grades itself drifts toward conformity. This module builds a judge that
 * is structurally SEPARATE from the generator and runs on DIFFERENT model
 * families (anthropic + openrouter + alibaba), so the verdict cannot be
 * self-preferred.
 *
 * Two layers, cleanly split for testability:
 *
 *   1. judgeWithJury (IMPURE)  — for each judge model, score every candidate on
 *      the GIANT 7-axis rubric. Candidates are ANONYMIZED (author/source/score
 *      stripped so a judge can't recognize and favor its own family's output)
 *      and POSITION-SWITCHED (order rotated per judge to defeat position bias).
 *      A judge whose provider has no API key — or that errors — is GRACEFULLY
 *      SKIPPED; the run never breaks on one dead provider.
 *
 *   2. fuseJury (PURE)         — fuse the per-judge GIANT vectors into one robust
 *      verdict per candidate: a MEDIAN/trimmed-mean across judges (robust to a
 *      single outlier judge), a composite juryScore, an inter-judge AGREEMENT,
 *      and an explicit DISSENT magnitude. Dissent is a first-class SIGNAL — it is
 *      surfaced, not averaged away — so the downstream selector can treat a
 *      high-variance idea differently from a unanimously-strong one.
 *
 * The fusion layer is fully deterministic (no DB / clock / rng / network) and is
 * exhaustively unit-tested with injected scores.
 */

import { z } from "zod";
import { chat } from "../../agent/chat";
import type { AgentResponse, AiProvider } from "../../agent/types";
import { getSecret } from "../../config/secrets";
import { createLogger } from "../../logger";
import {
  GIANT_AXIS_KEYS,
  GIANT_AXES,
  AXIS_MIN,
  AXIS_MAX,
  aggregateGiant,
  clampAxisScore,
  parseGiant,
  type GiantAxisKey,
  type GiantAxisScores,
  type AggregateGiantOptions,
} from "./giant";

const log = createLogger("ideas-jury");

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A candidate handed to the jury. Only the title + description text is judged;
 * any provenance (author/proposedBy/source) is intentionally absent from this
 * shape so the judge can never self-prefer. {@link anonymizeCandidates} strips
 * provenance from richer inputs into this shape.
 */
export interface JuryCandidate {
  /** Stable id used to join the verdict back to the caller's candidate. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

/**
 * One judge in the jury: a provider/model pair on a (ideally) distinct model
 * family, plus the secret key whose presence gates whether the judge runs.
 */
export interface JudgeModel {
  /** Human label for logs (e.g. "anthropic-sonnet"). */
  readonly label: string;
  readonly provider: AiProvider;
  readonly model: string;
  /**
   * Name of the secret/env var whose presence is REQUIRED for this provider.
   * When absent, the judge is gracefully skipped (no error). Anthropic via the
   * Agent SDK / OAuth may run without an explicit key — pass undefined to always
   * attempt the judge.
   */
  readonly requiredSecret?: string;
}

/** One judge's GIANT scorecard for a single candidate. */
export interface JudgeScorecard {
  readonly candidateId: string;
  readonly scores: GiantAxisScores;
  /** Whether a cited demand artifact was asserted (feeds the demand cap). */
  readonly hasDemandEvidence: boolean;
}

/** The full output of one judge: its label + a scorecard per candidate it scored. */
export interface JudgeResult {
  readonly judge: string;
  readonly scorecards: readonly JudgeScorecard[];
}

/** The fused, robust verdict for one candidate (the shape the Pipeline consumes). */
export interface JuryVerdict {
  readonly candidateId: string;
  /** Robust per-axis scores (median / trimmed-mean across judges). */
  readonly giantScores: GiantAxisScores;
  /** Composite GIANT score over the fused axes, in [0, 5]. */
  readonly juryScore: number;
  /** Inter-judge agreement in [0, 1] — 1 = unanimous, 0 = maximal spread. */
  readonly juryAgreement: number;
  /**
   * Disagreement magnitude in [0, 5] — the mean per-axis spread across judges.
   * HIGH dissent is a SIGNAL (a polarizing idea), surfaced not averaged away.
   */
  readonly dissent: number;
  /** How many judges actually scored this candidate (>=1 by construction). */
  readonly judgeCount: number;
}

// ── Anonymization ────────────────────────────────────────────────────────────

/** Fields that leak provenance and must never reach a judge. */
const PROVENANCE_KEYS = [
  "author",
  "proposedBy",
  "source",
  "expertScore",
  "juryScore",
  "agentId",
  "model",
  "provider",
] as const;

/**
 * Strip any provenance from richer candidate objects into the minimal
 * {@link JuryCandidate} shape so a judge cannot recognize (and self-prefer) the
 * output of its own model family. PURE.
 */
export function anonymizeCandidates(
  candidates: readonly Record<string, unknown>[],
): JuryCandidate[] {
  return candidates.map((c, idx) => {
    const id =
      typeof c.id === "string" && c.id.trim().length > 0
        ? c.id.trim()
        : `cand-${idx}`;
    const title = typeof c.title === "string" ? c.title : "";
    const description =
      typeof c.description === "string"
        ? c.description
        : typeof c.summary === "string"
          ? c.summary
          : undefined;
    // Build a fresh object; PROVENANCE_KEYS are never copied across.
    void PROVENANCE_KEYS;
    return description !== undefined
      ? { id, title, description }
      : { id, title };
  });
}

// ── Position-switching (PURE) ────────────────────────────────────────────────

/**
 * Rotate a candidate list by `offset` to mitigate position bias: each judge
 * sees the candidates in a different order, so a model that systematically
 * over-rates the first/last item cannot bias the FUSED verdict in one direction.
 * The verdict is rejoined by id, so order is presentation-only. PURE.
 */
export function rotateForJudge<T>(items: readonly T[], offset: number): T[] {
  const n = items.length;
  if (n <= 1) return [...items];
  const shift = ((offset % n) + n) % n;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

// ── Prompt + parse ───────────────────────────────────────────────────────────

/** The GIANT rubric block the jury asks each judge to score against. */
function buildRubricBlock(): string {
  const axes = GIANT_AXIS_KEYS.map((key, i) => {
    const spec = GIANT_AXES[key];
    const gate = spec.hardGate ? " HARD GATE (<=1 is reject-worthy)." : "";
    const evidence = spec.evidenceGated
      ? " EVIDENCE-GATED: score <=2 unless a real demand artifact is cited."
      : "";
    return `${i + 1}. ${key} (0..5) — ${spec.description}${gate}${evidence}`;
  }).join("\n");
  return `Score each candidate against THE GIANT RUBRIC — 7 axes, each 0..5. Be ruthless; reserve 4-5 for genuine outliers. Reward HARD, UNGLAMOROUS, DEFENSIBLE ideas; penalize templated "X for Y app" clones.\n\n${axes}`;
}

function buildJudgePrompt(candidates: readonly JuryCandidate[]): string {
  const list = candidates
    .map(
      (c, i) =>
        `[#${i + 1}] id=${c.id}\nTitle: ${c.title}\nDescription: ${(c.description ?? "").slice(0, 600)}`,
    )
    .join("\n\n");
  return `You are an INDEPENDENT product-idea judge. You did NOT write these ideas; score them on their merits alone, with no loyalty to any author or style.

${buildRubricBlock()}

=== CANDIDATES TO JUDGE ===
${list}

Return ONLY a JSON array with one entry per candidate (you may use any order; bind by id):
[
  {
    "id": "string — copy the candidate's id EXACTLY",
    "scores": {
      "acuteProblem": number,
      "whyNow": number,
      "demand": number,
      "nonObviousness": number,
      "defensibility": number,
      "marketShape": number,
      "founderFit": number
    },
    "hasDemandEvidence": boolean
  }
]`;
}

/** Lenient zod schema for one judge scorecard row (numbers clamped later). */
const judgeRowSchema = z.object({
  id: z.string(),
  scores: z.record(z.string(), z.number()).optional().default({}),
  hasDemandEvidence: z.boolean().optional().default(false),
});

/**
 * Extract a JSON array of judge rows from a raw model response, tolerant of code
 * fences and surrounding prose. Returns [] on any parse failure (never throws).
 * PURE.
 */
export function parseJudgeResponse(
  text: string,
  validIds: ReadonlySet<string>,
): JudgeScorecard[] {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: JudgeScorecard[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    const row = judgeRowSchema.safeParse(raw);
    if (!row.success) continue;
    const id = row.data.id.trim();
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    // Reuse the GIANT parser's tolerant coercion for the 7 axes.
    const { scores } = parseGiant({ scores: row.data.scores });
    out.push({
      candidateId: id,
      scores,
      hasDemandEvidence: row.data.hasDemandEvidence === true,
    });
  }
  return out;
}

// ── judgeWithJury (IMPURE) ───────────────────────────────────────────────────

/** Options for {@link judgeWithJury}. */
export interface JudgeWithJuryOptions {
  /** Per-judge max output tokens; defaults to a wide budget for the array. */
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
  /**
   * Injectable chat fn (defaults to the real {@link chat}) — lets tests drive
   * the orchestration without network. Must mirror chat's contract.
   */
  readonly chatFn?: typeof chat;
  /**
   * Injectable secret resolver (defaults to {@link getSecret}) — lets tests
   * simulate present/absent provider keys without env mutation.
   */
  readonly secretFn?: (key: string) => Promise<string | undefined>;
}

/** Whether a judge's provider has the credential it needs to run. */
async function judgeIsAvailable(
  judge: JudgeModel,
  secretFn: (key: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (!judge.requiredSecret) return true;
  try {
    const secret = await secretFn(judge.requiredSecret);
    return typeof secret === "string" && secret.trim().length > 0;
  } catch (err) {
    log.warn("jury: secret lookup failed, skipping judge", {
      judge: judge.label,
      err,
    });
    return false;
  }
}

/** Run a single judge over the (rotated, anonymized) candidates. */
async function runOneJudge(
  judge: JudgeModel,
  candidates: readonly JuryCandidate[],
  offset: number,
  validIds: ReadonlySet<string>,
  opts: Required<Pick<JudgeWithJuryOptions, "maxOutputTokens">> &
    Pick<JudgeWithJuryOptions, "abortSignal" | "chatFn">,
): Promise<JudgeResult | undefined> {
  const ordered = rotateForJudge(candidates, offset);
  const prompt = buildJudgePrompt(ordered);
  const chatFn = opts.chatFn ?? chat;

  try {
    const response: AgentResponse = await chatFn(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      {
        systemPrompt:
          "You are a ruthless, independent product-idea judge scoring against the GIANT rubric. Output only a valid JSON array. No prose.",
        model: judge.model,
        provider: judge.provider,
        agentId: `jury:${judge.label}`,
        maxOutputTokens: opts.maxOutputTokens,
        usageContext: {
          channel: "pipeline",
          chatId: "ideas-jury",
          source: "workflow",
        },
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      },
    );
    const scorecards = parseJudgeResponse(response.text, validIds);
    if (scorecards.length === 0) {
      log.warn("jury: judge returned no parseable scorecards, skipping", {
        judge: judge.label,
      });
      return undefined;
    }
    log.info("jury: judge scored candidates", {
      judge: judge.label,
      scored: scorecards.length,
    });
    return { judge: judge.label, scorecards };
  } catch (err) {
    // A dead provider must NEVER break the run — drop this judge.
    log.warn("jury: judge errored, skipping", { judge: judge.label, err });
    return undefined;
  }
}

/**
 * Run the independent jury: score every candidate with every available judge
 * model, then return the raw per-judge results (fuse them with {@link fuseJury}).
 *
 * Anonymizes candidates (no provenance reaches a judge) and position-switches
 * (rotates order per judge) to mitigate position bias. Judges whose provider has
 * no key — or that error / return garbage — are silently skipped. Returns an
 * empty array when NO judge is available, so the caller can fall back to the
 * native SIGE/critique scores.
 */
export async function judgeWithJury(
  candidates: readonly JuryCandidate[],
  judgeModels: readonly JudgeModel[],
  opts: JudgeWithJuryOptions = {},
): Promise<readonly JudgeResult[]> {
  if (candidates.length === 0 || judgeModels.length === 0) return [];

  const validIds = new Set(candidates.map((c) => c.id));
  const secretFn = opts.secretFn ?? getSecret;
  const maxOutputTokens = opts.maxOutputTokens ?? 16000;

  // Resolve availability first so unavailable providers are skipped cheaply.
  const availability = await Promise.all(
    judgeModels.map((j) => judgeIsAvailable(j, secretFn)),
  );
  const available = judgeModels.filter((_, i) => availability[i]);

  if (available.length === 0) {
    log.warn("jury: no judge providers available — returning empty", {
      requested: judgeModels.length,
    });
    return [];
  }

  // Each judge gets a distinct rotation offset for position-switching.
  const results = await Promise.all(
    available.map((judge, i) =>
      runOneJudge(judge, candidates, i, validIds, {
        maxOutputTokens,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        ...(opts.chatFn ? { chatFn: opts.chatFn } : {}),
      }),
    ),
  );

  return results.filter((r): r is JudgeResult => r !== undefined);
}

// ── Robust statistics (PURE) ─────────────────────────────────────────────────

/** Median of a non-empty numeric list (sorted copy, no mutation). PURE. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Trimmed mean: drop the single lowest AND single highest value, then average
 * the rest — down-weights one outlier judge. With <=2 judges there is nothing to
 * trim, so it falls back to a plain mean. PURE.
 */
export function trimmedMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  if (values.length <= 2) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const inner = sorted.slice(1, sorted.length - 1);
  return inner.reduce((a, b) => a + b, 0) / inner.length;
}

/** Population standard deviation of a list (0 for <2 values). PURE. */
function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Max minus min of a list (0 for empty/singleton). PURE. */
function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

// ── fuseJury (PURE) ──────────────────────────────────────────────────────────

/** How the per-judge axis scores are reduced into one fused value. */
export type FusionMethod = "median" | "trimmed-mean";

/** Options for {@link fuseJury}. */
export interface FuseJuryOptions {
  /** Robust reducer across judges. Default "median" (max outlier robustness). */
  readonly method?: FusionMethod;
  /** GIANT aggregation options threaded into the composite juryScore. */
  readonly aggregate?: AggregateGiantOptions;
}

/** The axis spread that maps to ZERO agreement (5 = full 0..5 disagreement). */
const MAX_AXIS_SPREAD = AXIS_MAX - AXIS_MIN;

/**
 * Fuse per-judge GIANT scorecards into one robust verdict per candidate. PURE —
 * deterministic, no IO.
 *
 *   giantScores   — per axis, the MEDIAN (default) or trimmed-mean across the
 *                   judges that scored this candidate; robust to one outlier.
 *   juryScore     — the non-compensatory GIANT composite over the fused axes.
 *   juryAgreement — 1 - (mean per-axis stddev / maxStddev), in [0, 1]; 1 when all
 *                   judges agree, → 0 as they spread out. Single judge ⇒ 1.
 *   dissent       — mean per-axis SPREAD (max-min) across judges, in [0, 5]; a
 *                   first-class polarization signal, surfaced not averaged away.
 *
 * A candidate scored by exactly one judge keeps that judge's vector with
 * agreement 1 / dissent 0 (graceful single-judge fallback).
 */
export function fuseJury(
  results: readonly JudgeResult[],
  opts: FuseJuryOptions = {},
): readonly JuryVerdict[] {
  const method = opts.method ?? "median";
  const reduce = method === "trimmed-mean" ? trimmedMean : median;

  // Group every judge's per-axis score by candidate id, preserving order of
  // first appearance so the output is stable.
  const byCandidate = new Map<string, Map<GiantAxisKey, number[]>>();
  const demandEvidenceVotes = new Map<string, number>();
  const judgeCounts = new Map<string, number>();
  const order: string[] = [];

  for (const result of results) {
    for (const card of result.scorecards) {
      let axisMap = byCandidate.get(card.candidateId);
      if (!axisMap) {
        axisMap = new Map();
        for (const key of GIANT_AXIS_KEYS) axisMap.set(key, []);
        byCandidate.set(card.candidateId, axisMap);
        order.push(card.candidateId);
      }
      for (const key of GIANT_AXIS_KEYS) {
        axisMap.get(key)!.push(clampAxisScore(card.scores[key]));
      }
      judgeCounts.set(
        card.candidateId,
        (judgeCounts.get(card.candidateId) ?? 0) + 1,
      );
      if (card.hasDemandEvidence) {
        demandEvidenceVotes.set(
          card.candidateId,
          (demandEvidenceVotes.get(card.candidateId) ?? 0) + 1,
        );
      }
    }
  }

  const maxStddev = MAX_AXIS_SPREAD / 2; // worst-case stddev for a 2-point split.

  return order.map((candidateId) => {
    const axisMap = byCandidate.get(candidateId)!;
    const judgeCount = judgeCounts.get(candidateId) ?? 0;

    const giantScores = {} as GiantAxisScores;
    let stddevSum = 0;
    let spreadSum = 0;
    for (const key of GIANT_AXIS_KEYS) {
      const samples = axisMap.get(key)!;
      giantScores[key] = clampAxisScore(reduce(samples));
      stddevSum += stddev(samples);
      spreadSum += spread(samples);
    }
    const axisCount = GIANT_AXIS_KEYS.length;
    const meanStddev = stddevSum / axisCount;
    const dissent = spreadSum / axisCount;

    // Agreement: 1 when judges align, → 0 as the mean per-axis stddev approaches
    // the worst case. Clamped to [0, 1]. Single judge ⇒ stddev 0 ⇒ agreement 1.
    const agreement =
      maxStddev > 0
        ? Math.min(1, Math.max(0, 1 - meanStddev / maxStddev))
        : 1;

    // Majority of judges asserting a cited demand artifact lifts the demand cap.
    const evidenceVotes = demandEvidenceVotes.get(candidateId) ?? 0;
    const majorityDemandEvidence = evidenceVotes * 2 > judgeCount;
    const aggregate = aggregateGiant(giantScores, {
      ...opts.aggregate,
      hasDemandEvidence:
        opts.aggregate?.hasDemandEvidence ?? majorityDemandEvidence,
    });

    return {
      candidateId,
      giantScores,
      juryScore: aggregate.composite,
      juryAgreement: agreement,
      dissent,
      judgeCount,
    };
  });
}

// ── Default jury panel ───────────────────────────────────────────────────────

/**
 * A cross-family default panel: anthropic (Agent SDK / OAuth, no explicit key
 * required) + openrouter + alibaba. Providers without a key are skipped by
 * {@link judgeWithJury}, so this panel degrades to whatever is configured.
 */
export const DEFAULT_JURY_PANEL: readonly JudgeModel[] = [
  { label: "anthropic-sonnet", provider: "anthropic", model: "claude-sonnet-4-6" },
  {
    label: "openrouter-gpt",
    provider: "openrouter",
    model: "openai/gpt-4o",
    requiredSecret: "OPENROUTER_API_KEY",
  },
  {
    label: "alibaba-qwen",
    provider: "alibaba",
    model: "qwen3.7-plus",
    requiredSecret: "ALIBABA_API_KEY",
  },
];
