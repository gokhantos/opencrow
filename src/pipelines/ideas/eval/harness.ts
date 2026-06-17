/**
 * Offline eval harness for the ideas pipeline.
 *
 * Orchestration only — all math lives in the pure modules (aggregate.ts,
 * regression.ts) and all IO lives in store.ts / judge.ts. This file wires them:
 *
 *   1. load generated_ideas + idea_feedback,
 *   2. (optionally) re-score with an LLM judge,
 *   3. aggregate run-level metrics,
 *   4. compare against a trailing baseline to detect regressions,
 *   5. persist an immutable snapshot to idea_eval_runs.
 *
 * NOT on the pipeline hot path. The LLM judge is OFF unless explicitly enabled.
 * The whole run degrades gracefully: any sub-step failure is logged and the
 * harness still returns a (possibly empty) result.
 */

import { createLogger } from "../../../logger";
import { getDb } from "../../../store/db";
import {
  aggregateEval,
  aggregateGiantRun,
  compareSigeAb,
  computeEmbeddingNovelty,
  computeTasteLoopDrift,
  type DedupLabel,
  type EmbeddingNoveltyMetric,
  type EvalAggregate,
  type EvalIdeaRow,
  type GiantRunAggregate,
  type GiantScoredIdea,
  type JudgeOutcomeRow,
  type NoveltyEmbedDep,
  type NoveltySearchDep,
  type SigeAbPair,
  type SigeAbReport,
  type TasteLoopDrift,
} from "./aggregate";
import type { GiantAxisKey } from "../giant";
import {
  detectRegressions,
  type RegressionAlert,
  type RegressionOptions,
} from "./regression";
import {
  judgeIdeas,
  type JudgeOptions,
  type JudgeVerdict,
  verdictToSubscores,
} from "./judge";
import {
  loadEvalIdeas,
  loadEvalOutcomes,
  loadSignalRankerRows,
  loadTrailingAggregates,
  persistEvalSnapshot,
  type LoadIdeasOptions,
} from "./store";
import { aggregateSignalRanker, type SignalRankerReport } from "./signal-ranker";
import {
  selectAntiExemplars,
  selectGoldenExemplars,
  type ScoredIdeaRow,
} from "../taste";

const log = createLogger("ideas:eval:harness");

const DEFAULT_BASELINE_WINDOW = 5;

// ── Taste-loop drift section (judge GIANT vs realized outcome) ──────────────────

/** Terminal feedback kinds → success outcome for the kappa/Spearman labels. */
const TASTE_VALIDATED_KINDS: ReadonlySet<string> = new Set(["validated", "built"]);
/** Terminal feedback kinds → failure outcome. */
const TASTE_ARCHIVED_KINDS: ReadonlySet<string> = new Set([
  "archived",
  "dismissed",
]);

interface RawJudgeOutcomeRow {
  readonly id: string;
  readonly giant_composite: string | number | null;
  readonly outcome_kind: string | null;
  readonly outcome_actor: string | null;
  readonly archetype: string | null;
  readonly segment: string | null;
  readonly demand_score: string | number | null;
  readonly whitespace: boolean | string | null;
  readonly pipeline_stage: string | null;
}

/** Coerce a DB scalar (text/numeric) into a finite number or null. PURE. */
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Map a feedback kind to the binary taste outcome, or null when non-terminal.
 * PURE — exported only via the harness consumers; kept tiny + testable.
 */
function kindToOutcome(kind: string | null): "validated" | "archived" | null {
  if (kind === null) return null;
  if (TASTE_VALIDATED_KINDS.has(kind)) return "validated";
  if (TASTE_ARCHIVED_KINDS.has(kind)) return "archived";
  return null;
}

/**
 * Project joined DB rows (generated_ideas ⟕ latest idea_feedback) into the pure
 * JudgeOutcomeRow shape, AND a parallel ScoredIdeaRow set used to count the
 * golden/anti exemplar inventory exactly as generation would select it. PURE.
 */
function projectJudgeOutcomeRows(rows: readonly RawJudgeOutcomeRow[]): {
  readonly outcomeRows: readonly JudgeOutcomeRow[];
  readonly scoredRows: readonly ScoredIdeaRow[];
} {
  const outcomeRows: JudgeOutcomeRow[] = [];
  const scoredRows: ScoredIdeaRow[] = [];
  for (const r of rows) {
    const giantComposite = toFiniteNumber(r.giant_composite);
    // Outcome precedence: an explicit feedback kind wins; otherwise fall back to
    // the projected pipeline_stage so a validated/archived stage still labels.
    const outcome =
      kindToOutcome(r.outcome_kind) ?? kindToOutcome(r.pipeline_stage);
    const isHuman =
      r.outcome_actor !== null &&
      r.outcome_actor !== "pipeline" &&
      !r.outcome_actor.startsWith("proxy:");
    outcomeRows.push({
      id: r.id,
      giantComposite,
      outcome,
      source: isHuman ? "human" : "proxy",
    });
    scoredRows.push({
      id: r.id,
      title: "",
      summary: "",
      segment: r.segment,
      giantComposite,
      archetype: r.archetype,
      demandScore: toFiniteNumber(r.demand_score),
      whitespace:
        r.whitespace === null
          ? null
          : r.whitespace === true || r.whitespace === "t" || r.whitespace === "true",
      pipelineStage: r.pipeline_stage,
    });
  }
  return { outcomeRows, scoredRows };
}

/**
 * Load the taste-loop drift section: join generated_ideas to its LATEST
 * idea_feedback event, derive judge-vs-outcome rows, and count the golden/anti
 * exemplar inventory the taste module would inject. Fully guarded — returns null
 * on any failure or when disabled, so it never breaks the eval run.
 */
async function loadTasteLoopSection(
  enabled: boolean,
  exemplarCount: number,
  ideaIds: readonly string[],
): Promise<TasteLoopDrift | null> {
  if (!enabled || ideaIds.length === 0) return null;
  const db = getDb();
  try {
    const rows = (await db`
      SELECT
        gi.id AS id,
        gi.giant_composite AS giant_composite,
        gi.archetype AS archetype,
        gi.segment AS segment,
        gi.demand_score AS demand_score,
        gi.whitespace AS whitespace,
        gi.pipeline_stage AS pipeline_stage,
        fb.kind AS outcome_kind,
        fb.actor AS outcome_actor
      FROM generated_ideas gi
      LEFT JOIN LATERAL (
        SELECT kind, actor
        FROM idea_feedback
        WHERE idea_feedback.idea_id = gi.id
        ORDER BY created_at DESC
        LIMIT 1
      ) fb ON true
      WHERE gi.id IN ${db(ideaIds as string[])}
    `) as RawJudgeOutcomeRow[];

    const { outcomeRows, scoredRows } = projectJudgeOutcomeRows(rows);
    const golden = selectGoldenExemplars(scoredRows, { exemplarCount });
    const anti = selectAntiExemplars(scoredRows, { exemplarCount });

    return computeTasteLoopDrift(outcomeRows, {
      goldenExemplars: golden.length,
      antiExemplars: anti.length,
    });
  } catch (err) {
    log.warn("taste-loop section failed; omitting from eval", { err });
    return null;
  }
}

export interface RunEvalOptions {
  /** Scope which ideas to evaluate (category / run / since / limit). */
  readonly load?: LoadIdeasOptions;
  /** Labeled dedup decisions for precision/recall (optional). */
  readonly dedupLabels?: readonly DedupLabel[];
  /** Number of trailing snapshots to baseline against. Default 5. */
  readonly baselineWindow?: number;
  /** Regression-alert thresholds (see RegressionOptions). */
  readonly regression?: RegressionOptions;
  /** LLM-as-judge config; judging is OFF unless judge.enabled === true. */
  readonly judge?: JudgeOptions;
  /** When false, the computed snapshot is NOT written to idea_eval_runs. Default true. */
  readonly persist?: boolean;
  /**
   * When false, skip loading + aggregating the signal-ranker precision section.
   * Default true; the section is independently graceful (null when no labeled
   * signal rows exist), so leaving it on is safe even pre-feature.
   */
  readonly signalRanker?: boolean;
  /**
   * When false, skip the taste-loop drift section (judge-vs-outcome
   * kappa/Spearman + exemplar coverage). Default true; the section is
   * independently graceful (null when no outcome labels / GIANT composites
   * exist), so leaving it on is safe even cold-start.
   */
  readonly tasteLoop?: boolean;
  /**
   * Low few-shot exemplar count used only to SIZE the golden/anti inventory in
   * the taste-loop coverage section (mirrors smart.taste.exemplarCount). Default
   * 4. Does not affect generation — eval is off the hot path.
   */
  readonly exemplarCount?: number;
}

export interface RunEvalResult {
  readonly aggregate: EvalAggregate;
  /** Aggregate computed over LLM-judge re-scores (only when judging ran). */
  readonly judgeAggregate: EvalAggregate | null;
  readonly alerts: readonly RegressionAlert[];
  readonly judgeVerdicts: ReadonlyMap<string, JudgeVerdict>;
  readonly baselineCount: number;
  /** id of the persisted snapshot, or null when not persisted/failed. */
  readonly snapshotId: string | null;
}

/**
 * Build a parallel EvalIdeaRow set whose critique_subscores come from the LLM
 * judge instead of the persisted ones, so we can aggregate the judge's view and
 * compare it against the pipeline's. Pure (no IO).
 */
function ideasFromJudge(
  ideas: readonly EvalIdeaRow[],
  verdicts: ReadonlyMap<string, JudgeVerdict>,
): readonly EvalIdeaRow[] {
  return ideas
    .map((idea): EvalIdeaRow | null => {
      const v = verdicts.get(idea.id);
      if (!v) return null;
      return { ...idea, critique_subscores: verdictToSubscores(v) };
    })
    .filter((x): x is EvalIdeaRow => x !== null);
}

/**
 * Load + aggregate the ranker-precision section, fully guarded. Returns null
 * when disabled, when no labeled signal rows exist (cold start / ranking off /
 * pre-migration), or on any read failure — so it never breaks the eval run.
 */
async function loadSignalRankerSection(
  enabled: boolean,
): Promise<SignalRankerReport | null> {
  if (!enabled) return null;
  try {
    const rows = await loadSignalRankerRows();
    return aggregateSignalRanker(rows);
  } catch (err) {
    log.warn("signal-ranker section failed; omitting from eval", { err });
    return null;
  }
}

/**
 * Run one offline eval pass. Never throws — failures degrade to a best-effort
 * result with whatever could be computed.
 */
export async function runEval(opts?: RunEvalOptions): Promise<RunEvalResult> {
  const baselineWindow = opts?.baselineWindow ?? DEFAULT_BASELINE_WINDOW;
  const category = opts?.load?.category ?? null;
  const persist = opts?.persist ?? true;

  try {
    const ideas = await loadEvalIdeas(opts?.load);
    const outcomes = await loadEvalOutcomes(ideas.map((i) => i.id));

    // Ranker-precision section (graceful, optional). Loads the labeled
    // signal_facets ↔ idea-outcome join and folds it into the run aggregate.
    const signalRanker = await loadSignalRankerSection(opts?.signalRanker ?? true);

    // Taste-loop drift section (graceful, optional). Joins each idea to its
    // latest outcome label + GIANT composite and measures judge-vs-outcome
    // agreement (kappa/Spearman) plus golden/anti exemplar coverage.
    const tasteLoop = await loadTasteLoopSection(
      opts?.tasteLoop ?? true,
      opts?.exemplarCount ?? 4,
      ideas.map((i) => i.id),
    );

    const aggregate = aggregateEval({
      ideas,
      outcomes,
      dedupLabels: opts?.dedupLabels,
      signalRanker,
      tasteLoop,
    });

    // Optional LLM-as-judge re-scoring (gated inside judgeIdeas).
    const judgeVerdicts = await judgeIdeas(
      ideas.map((i) => ({ id: i.id, title: i.title ?? "", summary: i.summary ?? "" })),
      opts?.judge,
    );
    const judgeAggregate =
      judgeVerdicts.size > 0
        ? aggregateEval({
            ideas: ideasFromJudge(ideas, judgeVerdicts),
            outcomes,
            dedupLabels: opts?.dedupLabels,
            signalRanker,
            tasteLoop,
          })
        : null;

    // Regression detection vs trailing baseline (excludes this run, which is
    // not yet persisted).
    const trailing = await loadTrailingAggregates(baselineWindow, category);
    const alerts = detectRegressions(aggregate, trailing, opts?.regression);

    if (alerts.length > 0) {
      log.warn("Eval regression alerts detected", {
        count: alerts.length,
        metrics: alerts.map((a) => `${a.metric}:${a.severity}`),
      });
    }

    let snapshotId: string | null = null;
    if (persist) {
      snapshotId = await persistEvalSnapshot({
        aggregate,
        alerts,
        judgeEnabled: judgeVerdicts.size > 0,
        category,
        pipelineRunId: opts?.load?.pipelineRunId ?? null,
      });
    }

    log.info("Eval run complete", {
      totalIdeas: aggregate.totalIdeas,
      killedRate: aggregate.outcomeRates.killedRate,
      humanValidatedRate: aggregate.outcomeRates.humanValidatedRate,
      demandCoverage: aggregate.demand?.demandCoverage ?? null,
      meanDemandScore: aggregate.demand?.meanDemandScore ?? null,
      demandEvidenceGated: aggregate.demand?.evidenceGatedCount ?? 0,
      demandEvidenced: aggregate.demand?.evidencedCount ?? 0,
      alerts: alerts.length,
      judged: judgeVerdicts.size,
      signalRankerLabeled: signalRanker?.totalLabeled ?? 0,
      signalRankerLift: signalRanker?.lift ?? null,
      judgeOutcomeKappa: tasteLoop?.kappa.kappa ?? null,
      judgeOutcomeSpearman: tasteLoop?.rankCorrelation.spearman ?? null,
      tasteLoopLabeledFraction: tasteLoop?.coverage.labeledFraction ?? null,
      goldenExemplars: tasteLoop?.coverage.goldenExemplars ?? 0,
      antiExemplars: tasteLoop?.coverage.antiExemplars ?? 0,
      snapshotId,
    });

    return {
      aggregate,
      judgeAggregate,
      alerts,
      judgeVerdicts,
      baselineCount: trailing.length,
      snapshotId,
    };
  } catch (err) {
    log.error("runEval failed; returning empty result", { err });
    return {
      aggregate: aggregateEval({ ideas: [], outcomes: [], dedupLabels: opts?.dedupLabels }),
      judgeAggregate: null,
      alerts: [],
      judgeVerdicts: new Map(),
      baselineCount: 0,
      snapshotId: null,
    };
  }
}

// ── Re-judge stored ideas under GIANT ──────────────────────────────────────────

/** Per-axis weight overrides for the GIANT run aggregate (defaults the rest). */
export type GiantWeightOverrides = Partial<Record<GiantAxisKey, number>>;

export interface ReJudgeOptions {
  /** Scope which stored ideas to re-score (category / run / since / limit). */
  readonly load?: LoadIdeasOptions;
  /**
   * LLM-judge config. Re-judging is the WHOLE point of this entrypoint, so the
   * judge defaults to ENABLED here (unlike runEval) unless explicitly disabled.
   */
  readonly judge?: JudgeOptions;
  /** GIANT axis weight overrides forwarded to the run aggregate. */
  readonly weights?: GiantWeightOverrides;
  /**
   * Optional injected embedding dep for the objective novelty metric. Graceful:
   * omitted → novelty metric is null. Kept injectable so the harness has no hard
   * dependency on memory/Qdrant and the pure math stays unit-testable.
   */
  readonly embed?: NoveltyEmbedDep | null;
  /** Optional injected corpus-search dep (known products/ideas). */
  readonly search?: NoveltySearchDep | null;
}

export interface ReJudgeResult {
  /** Re-scored verdicts keyed by idea id (GIANT 7-axis + composite + gate). */
  readonly verdicts: ReadonlyMap<string, JudgeVerdict>;
  /** Run-level GIANT aggregate over the re-scored batch (null when nothing scored). */
  readonly giant: GiantRunAggregate | null;
  /** Objective embedding-novelty metric (null when no embed dep / memory off). */
  readonly embeddingNovelty: EmbeddingNoveltyMetric | null;
  /** The ids that were loaded and submitted for re-judging. */
  readonly ideaIds: readonly string[];
}

const EMPTY_REJUDGE: ReJudgeResult = {
  verdicts: new Map(),
  giant: null,
  embeddingNovelty: null,
  ideaIds: [],
};

/**
 * Load existing generated_ideas and RE-SCORE them under the GIANT rubric.
 *
 * This is how we re-score the historical FoodMemory / BudgetBloom / LangLoop
 * batch and confirm the generic ones rank LOWER on the non-compensatory
 * composite. Returns the per-idea verdicts plus the run-level GIANT aggregate
 * (per-axis means, gate-kill rate, composite distribution) and the objective
 * embedding-novelty metric.
 *
 * NOT on the pipeline hot path. Never throws — every sub-step degrades to a
 * best-effort partial result so a re-judge run can't break the caller.
 */
export async function reJudgeStoredIdeas(
  opts?: ReJudgeOptions,
): Promise<ReJudgeResult> {
  try {
    const ideas = await loadEvalIdeas(opts?.load);
    if (ideas.length === 0) {
      log.info("reJudgeStoredIdeas: no stored ideas to re-score");
      return EMPTY_REJUDGE;
    }

    // Re-score under GIANT (judge ENABLED by default for this entrypoint).
    const verdicts = await judgeIdeas(
      ideas.map((i) => ({ id: i.id, title: i.title ?? "", summary: i.summary ?? "" })),
      { enabled: true, ...opts?.judge },
    );

    // Run-level GIANT aggregate over whatever was scored.
    const scored: readonly GiantScoredIdea[] = [...verdicts.values()].map((v) => ({
      id: v.id,
      scores: v.giantScores,
      // Demand evidence presence is re-derived from the gate result the judge
      // already computed: if its gateReasons carried no demand cap, the demand
      // axis was treated as evidenced (or already <= cap).
      hasDemandEvidence: !v.gateReasons.some((r) =>
        r.startsWith("demand-evidence-gate:"),
      ),
    }));
    const giant =
      scored.length > 0
        ? aggregateGiantRun(scored, { weights: opts?.weights })
        : null;

    // Objective embedding-novelty (optional + graceful).
    const embeddingNovelty =
      opts?.embed != null
        ? await computeEmbeddingNovelty(
            ideas.map((i) => ({
              id: i.id,
              text: `${i.title ?? ""}\n${i.summary ?? ""}`.trim(),
            })),
            { embed: opts.embed, search: opts.search ?? null },
          )
        : null;

    log.info("reJudgeStoredIdeas complete", {
      loaded: ideas.length,
      scored: verdicts.size,
      gateKillRate: giant?.gateKillRate ?? null,
      compositeMean: giant?.compositeMean ?? null,
    });

    return {
      verdicts,
      giant,
      embeddingNovelty,
      ideaIds: ideas.map((i) => i.id),
    };
  } catch (err) {
    log.error("reJudgeStoredIdeas failed; returning empty result", { err });
    return EMPTY_REJUDGE;
  }
}

// ── Hardened-SIGE vs self-critique A/B ──────────────────────────────────────────

export interface RunSigeAbOptions {
  /**
   * Id-paired GIANT scores: each idea scored by the hardened SIGE jury AND by
   * the synthesizer self-critique. The impure jury/SIGE LLM calls are the
   * caller's (pipeline-phase) responsibility — they MUST be gated behind
   * `smart.sigeValuation` (default OFF). This entrypoint only does the pure
   * comparison math + regression detection + persistence.
   */
  readonly pairs: readonly SigeAbPair[];
  /**
   * One boolean per evaluated SIGE round (true = convergence-vetoed). Drives the
   * convergenceVetoRate. Empty when no round-level health was measured.
   */
  readonly vetoes?: readonly boolean[];
  /** Tolerance below which a negative groundedness delta is still "flat". Default 0.05. */
  readonly groundednessTolerance?: number;
  /** Number of trailing snapshots to baseline against. Default 5. */
  readonly baselineWindow?: number;
  /** Regression-alert thresholds (see RegressionOptions). */
  readonly regression?: RegressionOptions;
  /** Scope label for trailing-baseline lookup (category). */
  readonly category?: string | null;
  /** When false, the computed snapshot is NOT written. Default false (A/B is exploratory). */
  readonly persist?: boolean;
  /** Optional pipeline run id to stamp on a persisted snapshot. */
  readonly pipelineRunId?: string | null;
}

export interface RunSigeAbResult {
  /** The hardened-SIGE vs self-critique comparison report. */
  readonly report: SigeAbReport;
  /**
   * The A/B report folded into a run-level aggregate (so `sigeLift` /
   * `sigeGroundednessDelta` flow through the standard regression tracker).
   */
  readonly aggregate: EvalAggregate;
  readonly alerts: readonly RegressionAlert[];
  readonly baselineCount: number;
  readonly snapshotId: string | null;
}

/**
 * Run the hardened-SIGE vs self-critique A/B GATE on a set of id-paired GIANT
 * scores. Reports the headline `sigeLift`, the groundedness delta (must be
 * flat-or-up), jury agreement, dissent distribution, and the convergence-veto
 * rate — then runs the standard regression tracker so a regression in lift or
 * groundedness alerts like any other tracked metric.
 *
 * This is the decision gate for ever defaulting `smart.sigeValuation` on: a real
 * win is `report.liftWithoutGroundednessRegression === true`.
 *
 * NOT on the pipeline hot path. Never throws — degrades to a best-effort result.
 */
export async function runSigeAb(
  opts: RunSigeAbOptions,
): Promise<RunSigeAbResult> {
  const baselineWindow = opts.baselineWindow ?? DEFAULT_BASELINE_WINDOW;
  const category = opts.category ?? null;
  const persist = opts.persist ?? false;

  let report: SigeAbReport;
  try {
    report = compareSigeAb(opts.pairs, opts.vetoes ?? [], {
      groundednessTolerance: opts.groundednessTolerance,
    });
  } catch (err) {
    // compareSigeAb is pure and defensive, but never let the gate break a run.
    log.error("compareSigeAb failed; returning empty A/B report", { err });
    report = compareSigeAb([], []);
  }

  const aggregate = aggregateEval({ ideas: [], outcomes: [], sigeAb: report });

  let alerts: readonly RegressionAlert[] = [];
  let baselineCount = 0;
  try {
    const trailing = await loadTrailingAggregates(baselineWindow, category);
    baselineCount = trailing.length;
    alerts = detectRegressions(aggregate, trailing, opts.regression);
  } catch (err) {
    log.warn("SIGE A/B baseline load failed; skipping regression alerts", {
      err,
    });
  }

  let snapshotId: string | null = null;
  if (persist) {
    try {
      snapshotId = await persistEvalSnapshot({
        aggregate,
        alerts,
        judgeEnabled: true,
        category,
        pipelineRunId: opts.pipelineRunId ?? null,
      });
    } catch (err) {
      log.warn("SIGE A/B snapshot persist failed", { err });
    }
  }

  log.info("SIGE A/B gate complete", {
    pairedCount: report.pairedCount,
    sigeLift: report.sigeLift,
    groundednessDelta: report.groundednessDelta,
    liftWithoutGroundednessRegression: report.liftWithoutGroundednessRegression,
    meanJuryAgreement: report.meanJuryAgreement,
    dissentMean: report.dissentDistribution.mean,
    convergenceVetoRate: report.convergenceVetoRate,
    alerts: alerts.length,
    snapshotId,
  });

  return { report, aggregate, alerts, baselineCount, snapshotId };
}
