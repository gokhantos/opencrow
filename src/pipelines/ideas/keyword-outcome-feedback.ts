/**
 * keyword-outcome-feedback.ts — Batch F, F5 leg 4: run-aggregate outcome
 * attribution back to App Store keyword-gap seeds.
 *
 * Mirrors graph-outcome-feedback.ts's Postgres bookkeeping shape (migration
 * 033) for a DIFFERENT target: `appstore_keyword_verdicts` (source='pipeline',
 * migration 055) instead of Neo4j `:Entity` seeds. Reuses that module's PURE
 * credit-assignment builder ({@link buildSeedOutcomeEvents}) UNCHANGED — a
 * keyword IS just a seed name from that builder's point of view, so no
 * duplicate pure logic lives here.
 *
 * Why RUN-AGGREGATE, not per-idea: a `GapSeed` keyword is prompt CONTEXT fed
 * to synthesis (see `collector-keyword-gaps.ts`'s module doc) — nothing links
 * a specific generated idea back to a specific seed keyword. So this
 * attributes the run's AGGREGATE gold/reprobe verdict (the exact same net
 * signal `graph-outcome-feedback.ts` computes from the same `proxyLabels`)
 * across every keyword that fed the run's collection step, not a hard
 * per-idea mapping.
 *
 * Consumed by `collectKeywordGaps` (`keyword-verdict-store.ts`'s
 * `getPipelineKilledWeights`): `killed_count` is a SOFT downweight on sort
 * rank, never a hard exclude — see that module's and
 * `keyword-verdict-store.ts`'s doc comments on the existing human/pipeline
 * hard/soft exclude distinction (F5 legs 1-3) this deliberately extends, not
 * replaces. A human `dismissed`/`killed` verdict still hard-excludes; this
 * pipeline-derived signal only ever nudges sort order.
 *
 * Every IO function here is best-effort (never throws) so a failure can
 * never break a pipeline run.
 */

import { applyTemporalDecay } from "../../memory/temporal-decay";
import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import type { GraphOutcomeEvent } from "./graph-outcome-feedback";

const log = createLogger("ideas:keyword-outcome-feedback");

/**
 * Record which gap-seed keywords fed a run (provenance for credit
 * assignment). Idempotent via the (run_id, keyword) PK. Best-effort: swallows
 * its own errors. An empty keyword list is a no-op.
 */
export async function recordKeywordSeedExposure(
  runId: string,
  keywords: readonly string[],
): Promise<void> {
  const unique = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length > 0))];
  if (unique.length === 0) return;
  try {
    const db = getDb();
    for (const keyword of unique) {
      await db`
        INSERT INTO appstore_keyword_seed_exposure (run_id, keyword)
        VALUES (${runId}, ${keyword})
        ON CONFLICT (run_id, keyword) DO NOTHING
      `;
    }
  } catch (err) {
    log.warn("recordKeywordSeedExposure failed — skipping", { err });
  }
}

/** Load the keywords that fed a run (for the write-back credit assignment). */
export async function loadRunKeywordSeeds(runId: string): Promise<readonly string[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT keyword FROM appstore_keyword_seed_exposure WHERE run_id = ${runId}
    `) as { keyword: string }[];
    return rows.map((r) => r.keyword);
  } catch (err) {
    log.warn("loadRunKeywordSeeds failed — returning empty", { err });
    return [];
  }
}

/**
 * Append outcome events to the immutable log, de-duped by the (run_id,
 * keyword, verdict) UNIQUE constraint (ON CONFLICT DO NOTHING) so a re-run
 * never double-counts. Best-effort. Empty input is a no-op.
 */
export async function appendKeywordOutcomeEvents(
  events: readonly GraphOutcomeEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    const db = getDb();
    for (const event of events) {
      await db`
        INSERT INTO appstore_keyword_outcome_events (run_id, keyword, verdict, weight, created_at_sec)
        VALUES (${event.runId}, ${event.seedName}, ${event.verdict}, ${event.weight}, ${event.createdAtSec})
        ON CONFLICT (run_id, keyword, verdict) DO NOTHING
      `;
    }
  } catch (err) {
    log.warn("appendKeywordOutcomeEvents failed — skipping", { err });
  }
}

interface KeywordOutcomeEventRow {
  readonly run_id: string;
  readonly keyword: string;
  readonly verdict: "validated" | "killed";
  readonly weight: number | string;
  readonly created_at_sec: number | string;
}

/**
 * Materialize `validated_count` / `killed_count` onto `appstore_keyword_verdicts`
 * (source='pipeline', migration 055). Reads ALL keyword-outcome events, groups
 * by keyword, decays each event's magnitude by age (`applyTemporalDecay`, same
 * mechanism as graph feedback's `success_weight`) and sums the validated vs
 * killed decayed magnitude SEPARATELY per keyword — UNLIKE
 * `graph_seed_weights` (which nets the two into one signed score),
 * `collectKeywordGaps` specifically needs `killed_count` as its own
 * non-negative downweight signal (a keyword with many validated AND a few
 * killed runs should still show its kill signal, not have it canceled out).
 *
 * Upserts a source='pipeline' row per keyword: on first insert (no existing
 * pipeline row for that keyword — e.g. no screener dismissal ever fired) this
 * INSERTs one with a placeholder `verdict` matching the outcome's own sign
 * purely to satisfy the NOT NULL CHECK constraint; on conflict this ONLY
 * updates `validated_count`/`killed_count` — an existing row's `verdict`/
 * `note`/`decided_at` (e.g. a screener 'dismissed' downweight from F5 leg 2)
 * is left untouched. Best-effort; never throws. Returns the number of
 * keywords materialized.
 */
export async function recomputeKeywordOutcomeCounts(params: {
  readonly now: number;
  readonly halfLifeDays: number;
}): Promise<number> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT run_id, keyword, verdict, weight, created_at_sec
      FROM appstore_keyword_outcome_events
    `) as KeywordOutcomeEventRow[];

    const byKeyword = new Map<string, KeywordOutcomeEventRow[]>();
    for (const row of rows) {
      const list = byKeyword.get(row.keyword);
      if (list) list.push(row);
      else byKeyword.set(row.keyword, [row]);
    }

    let materialized = 0;
    for (const [keyword, events] of byKeyword) {
      let validatedCount = 0;
      let killedCount = 0;
      for (const event of events) {
        const decayed = applyTemporalDecay(
          Math.abs(Number(event.weight)),
          Number(event.created_at_sec),
          params.now,
          params.halfLifeDays,
        );
        if (event.verdict === "validated") validatedCount += decayed;
        else killedCount += decayed;
      }

      const placeholderVerdict = killedCount >= validatedCount ? "killed" : "validated";
      await db`
        INSERT INTO appstore_keyword_verdicts (
          keyword, verdict, source, note, decided_at, updated_at, validated_count, killed_count
        ) VALUES (
          ${keyword}, ${placeholderVerdict}, 'pipeline', 'run-outcome attribution',
          ${params.now}, ${params.now}, ${validatedCount}, ${killedCount}
        )
        ON CONFLICT (keyword, source) DO UPDATE SET
          validated_count = EXCLUDED.validated_count,
          killed_count = EXCLUDED.killed_count
      `;
      materialized += 1;
    }
    log.debug("recomputeKeywordOutcomeCounts done", { keywords: materialized, events: rows.length });
    return materialized;
  } catch (err) {
    log.warn("recomputeKeywordOutcomeCounts failed — skipping", { err });
    return 0;
  }
}
