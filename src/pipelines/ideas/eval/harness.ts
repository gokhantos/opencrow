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
  type DedupLabel,
  type EvalAggregate,
  type EvalIdeaRow,
} from "./aggregate";
import {
  detectRegressions,
  type RegressionAlert,
  type RegressionOptions,
} from "./regression";
import { judgeIdeas, type JudgeOptions, type JudgeVerdict, verdictToSubscores } from "./judge";
import {
  loadEvalIdeas,
  loadEvalOutcomes,
  loadTrailingAggregates,
  persistEvalSnapshot,
  type LoadIdeasOptions,
} from "./store";

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

    const aggregate = aggregateEval({
      ideas,
      outcomes,
      dedupLabels: opts?.dedupLabels,
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
