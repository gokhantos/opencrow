/**
 * CLI entrypoint for the offline ideas eval harness (`src/pipelines/ideas/eval/`).
 *
 * The harness (aggregate.ts / judge.ts / regression.ts / signal-ranker.ts /
 * store.ts) is a library of pure functions + a DB-parsing helper with ZERO
 * external callers — this script is the missing entrypoint that loads real
 * `generated_ideas` / `idea_feedback` rows, aggregates them, checks for
 * regressions against the trailing `idea_eval_runs` history, and (by default)
 * persists a new immutable snapshot row.
 *
 * The LLM judge stays OFF (judge_enabled=false) — this script never spends
 * tokens; it only aggregates already-persisted deterministic signals.
 *
 * Usage:
 *   bun run scripts/run-idea-eval.ts                       # compute + persist
 *   bun run scripts/run-idea-eval.ts --dry-run              # compute only, no INSERT
 *   bun run scripts/run-idea-eval.ts --category=productivity
 *   bun run scripts/run-idea-eval.ts --category=x --dry-run
 *
 * Also runnable via the package.json script: `bun run ideas:eval`.
 */

import { initDb } from "../src/store/db";
import { createLogger } from "../src/logger";
import { getErrorMessage } from "../src/lib/error-serialization";
import { runIdeaEval } from "../src/pipelines/ideas/eval/run";

const log = createLogger("run-idea-eval");

function parseCategoryFlag(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--category=")) {
      const value = arg.slice("--category=".length).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const category = parseCategoryFlag(process.argv);

  log.info("Idea-eval run starting", {
    mode: dryRun ? "dry-run" : "persist",
    category: category ?? "(all)",
  });

  await initDb(process.env.DATABASE_URL);

  const result = await runIdeaEval({
    ...(category !== undefined ? { category } : {}),
    dryRun,
  });

  log.info("Idea-eval aggregate computed", {
    totalIdeas: result.totalIdeas,
    totalOutcomes: result.totalOutcomes,
    meanSubscores: result.aggregate.meanSubscores,
    outcomeRates: result.aggregate.outcomeRates,
    demandCoverage: result.aggregate.demand?.demandCoverage ?? null,
    giant: result.aggregate.giant
      ? {
          compositeMean: result.aggregate.giant.compositeMean,
          gateKillRate: result.aggregate.giant.gateKillRate,
          totalIdeas: result.aggregate.giant.totalIdeas,
        }
      : null,
  });

  if (result.alerts.length === 0) {
    log.info("No regression alerts");
  } else {
    log.warn("Regression alerts detected", {
      count: result.alerts.length,
      alerts: result.alerts,
    });
  }

  if (dryRun) {
    log.info("DRY RUN — no row inserted into idea_eval_runs");
  } else {
    log.info("Idea-eval snapshot persisted", { runId: result.runId });
  }

  process.exit(0);
}

main().catch((err) => {
  log.error("Idea-eval run failed", { error: getErrorMessage(err) });
  process.exit(1);
});
