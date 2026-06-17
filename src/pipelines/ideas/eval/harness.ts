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
import {
  aggregateEval,
  aggregateGiantRun,
  computeEmbeddingNovelty,
  type DedupLabel,
  type EmbeddingNoveltyMetric,
  type EvalAggregate,
  type EvalIdeaRow,
  type GiantRunAggregate,
  type GiantScoredIdea,
  type NoveltyEmbedDep,
  type NoveltySearchDep,
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

const log = createLogger("ideas:eval:harness");

const DEFAULT_BASELINE_WINDOW = 5;

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

    const aggregate = aggregateEval({
      ideas,
      outcomes,
      dedupLabels: opts?.dedupLabels,
      signalRanker,
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
      alerts: alerts.length,
      judged: judgeVerdicts.size,
      signalRankerLabeled: signalRanker?.totalLabeled ?? 0,
      signalRankerLift: signalRanker?.lift ?? null,
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
