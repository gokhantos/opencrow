/**
 * One ingestion cycle: iterate sources freshest-first, apply the quality gate +
 * dedup, respect the daily budget, and write surviving rows to mem0.
 */

import type { Mem0Client } from "../sige/knowledge/mem0-client";
import type { AnySourceDefinition } from "./sources";
import type { CompositeCursor, DailyBudget } from "./cursor";
import { SOURCES } from "./sources";
import { contentHash, isDuplicate, recordHash } from "./dedup";
import { passesQualityGate } from "./quality-gate";
import {
  readDailyCap,
  readDailyCount,
  resolveOrInitCursor,
  todayUtc,
  writeCursor,
  writeDailyCount,
} from "./cursor";
import { createLogger } from "../logger";

const log = createLogger("ingestion");

/** Resolved, behaviour-affecting knobs for a cycle (from config.ingestion). */
export interface IngestionRuntime {
  readonly mem0: Mem0Client;
  readonly userId: string;
  readonly batchSize: number;
  readonly maxRecordsPerDay: number;
  readonly minContentLength: number;
}

interface SourceRunResult {
  readonly sourceName: string;
  readonly fetched: number;
  readonly ingested: number;
  readonly droppedQuality: number;
  readonly droppedDup: number;
  readonly cappedRemaining: number;
  readonly caughtUp: boolean;
  /** Number of records where mem0.addMemory threw (content was valid but write failed). */
  readonly mem0Failures: number;
  /** True when the cursor was freshly initialised from MAX(indexed_at) this cycle. */
  readonly cursorInitialised: boolean;
}

async function ingestSource(
  source: AnySourceDefinition,
  runtime: IngestionRuntime,
  budget: DailyBudget,
): Promise<SourceRunResult> {
  const { cursor, wasInitialised } = await resolveOrInitCursor(source);

  let rows: ReadonlyArray<{ readonly id: string; readonly indexed_at: number | null }>;
  try {
    rows = await source.fetchBatch(cursor, runtime.batchSize);
  } catch (err) {
    log.warn("Failed to fetch batch — skipping source this cycle", {
      source: source.name,
      err,
    });
    return {
      sourceName: source.name,
      fetched: 0,
      ingested: 0,
      droppedQuality: 0,
      droppedDup: 0,
      cappedRemaining: 0,
      caughtUp: false,
      mem0Failures: 0,
      cursorInitialised: wasInitialised,
    };
  }

  if (rows.length === 0) {
    return {
      sourceName: source.name,
      fetched: 0,
      ingested: 0,
      droppedQuality: 0,
      droppedDup: 0,
      cappedRemaining: 0,
      caughtUp: true,
      mem0Failures: 0,
      cursorInitialised: wasInitialised,
    };
  }

  let ingested = 0;
  let droppedQuality = 0;
  let droppedDup = 0;
  let cappedRemaining = 0;
  let mem0Failures = 0;

  // The newest high-water we've consumed this batch. We start from the existing
  // cursor and advance as we process rows. Since rows are ordered DESC, the
  // FIRST successfully processed row carries the highest indexed_at/id.
  // We track the cursor after each consumed row so we can persist the progress
  // even if capping kicks in mid-batch.
  let latestConsumedCursor: CompositeCursor = cursor;
  let cappedAt: string | null = null;

  for (const row of rows) {
    const rawContent = source.getContent(row).trim();
    const metadata = source.toMetadata(row);
    const sourceType = (metadata["source_type"] as string | undefined) ?? source.name;
    const credibility = (metadata["credibility"] as number | undefined) ?? 0;
    const rowTs = row.indexed_at ?? cursor.ts;

    // ── Quality gate ──────────────────────────────────────────────────────────
    const gate = passesQualityGate(rawContent, sourceType, credibility, runtime.minContentLength);
    if (!gate.ok) {
      droppedQuality++;
      // Advance high-water — this row is consumed, never re-evaluated.
      latestConsumedCursor = { ts: rowTs, id: row.id };
      continue;
    }

    // ── Exact-dup dedup ───────────────────────────────────────────────────────
    const hash = contentHash(rawContent);
    let dup = false;
    try {
      dup = await isDuplicate(hash);
    } catch (err) {
      // Dedup DB error is non-fatal — let the row through (safe side is to ingest).
      log.warn("Dedup check failed — treating row as non-duplicate", {
        source: source.name,
        id: row.id,
        err,
      });
    }

    if (dup) {
      droppedDup++;
      latestConsumedCursor = { ts: rowTs, id: row.id };
      continue;
    }

    // ── Daily budget cap ──────────────────────────────────────────────────────
    if (budget.count >= budget.cap || cappedAt !== null) {
      // Cap reached — stop consuming rows from this source. Cursor is NOT
      // advanced past this row; it will resume next cycle / next day.
      cappedRemaining++;
      if (cappedAt === null) cappedAt = row.id;
      continue;
    }

    // ── Ingest ────────────────────────────────────────────────────────────────
    const text = source.toText(row);
    try {
      await runtime.mem0.addMemory({ content: text, userId: runtime.userId, metadata });
      // Record hash so future cycles skip this content.
      await recordHash(hash, source.name);
      ingested++;
      budget.count++;
      latestConsumedCursor = { ts: rowTs, id: row.id };
    } catch (err) {
      mem0Failures++;
      log.warn("Failed to ingest record — skipping", {
        source: source.name,
        id: row.id,
        err,
      });
      // Advance cursor past this row — do not retry forever.
      latestConsumedCursor = { ts: rowTs, id: row.id };
    }
  }

  // Persist cursor to the latest consumed position. Capped rows do NOT advance
  // latestConsumedCursor so they stay in the backlog and resume once the budget resets.
  // We only persist if we actually made progress.
  const movedForward =
    latestConsumedCursor.ts > cursor.ts ||
    (latestConsumedCursor.ts === cursor.ts && latestConsumedCursor.id > cursor.id);

  if (movedForward) {
    try {
      await writeCursor(source.name, latestConsumedCursor);
    } catch (err) {
      log.error("Failed to persist cursor — next run will re-process this batch", {
        source: source.name,
        latestConsumedCursor,
        err,
      });
    }
  }

  if (cappedAt !== null) {
    log.info("Daily cap reached — remaining rows held in backlog", {
      source: source.name,
      cappedRemaining,
      budgetUsed: budget.count,
      budgetCap: budget.cap,
    });
  }

  const caughtUp = cappedRemaining === 0 && rows.length < runtime.batchSize;

  log.info("Source cycle progress", {
    source: source.name,
    high_water_ts: latestConsumedCursor.ts,
    high_water_id: latestConsumedCursor.id,
    fetched: rows.length,
    ingested,
    droppedQuality,
    droppedDup,
    cappedRemaining,
  });

  return {
    sourceName: source.name,
    fetched: rows.length,
    ingested,
    droppedQuality,
    droppedDup,
    cappedRemaining,
    caughtUp,
    mem0Failures,
    cursorInitialised: wasInitialised,
  };
}

export async function runIngestionCycle(runtime: IngestionRuntime): Promise<void> {
  log.info("Ingestion cycle started");

  // Read the daily cap and today's running count ONCE per cycle (not per row).
  const today = todayUtc();
  const [cap, countAtStart] = await Promise.all([
    readDailyCap(runtime.maxRecordsPerDay),
    readDailyCount(today),
  ]);
  const budget: DailyBudget = { date: today, cap, count: countAtStart };

  // Sort by priority ascending so highest-signal sources are processed first
  const sorted = [...SOURCES].sort((a, b) => a.priority - b.priority);

  const results: SourceRunResult[] = [];

  for (const source of sorted) {
    // Short-circuit: if the budget is already exhausted, skip all remaining sources.
    if (budget.count >= budget.cap) {
      log.info("Daily cap exhausted — skipping remaining sources this cycle", {
        source: source.name,
        budgetUsed: budget.count,
        budgetCap: budget.cap,
      });
      break;
    }
    const result = await ingestSource(source, runtime, budget);
    results.push(result);
  }

  // Persist the updated daily count once at the end of the cycle.
  if (budget.count !== countAtStart) {
    try {
      await writeDailyCount(today, budget.count);
    } catch (err) {
      log.warn("Failed to persist daily count — next cycle may re-count", { err });
    }
  }

  // Aggregate totals across all sources for quick at-a-glance observability
  const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0);
  const totalIngested = results.reduce((sum, r) => sum + r.ingested, 0);
  const totalDroppedQuality = results.reduce((sum, r) => sum + r.droppedQuality, 0);
  const totalDroppedDup = results.reduce((sum, r) => sum + r.droppedDup, 0);
  const totalCappedRemaining = results.reduce((sum, r) => sum + r.cappedRemaining, 0);
  const totalMem0Failures = results.reduce((sum, r) => sum + r.mem0Failures, 0);

  // Per-source structured log — operators can grep by source name.
  for (const r of results) {
    log.info("Source cycle result", {
      source: r.sourceName,
      fetched: r.fetched,
      droppedQuality: r.droppedQuality,
      droppedDup: r.droppedDup,
      ingested: r.ingested,
      cappedRemaining: r.cappedRemaining,
      caughtUp: r.caughtUp,
      mem0Failures: r.mem0Failures,
      cursorInitialised: r.cursorInitialised,
    });
  }

  if (totalIngested === 0) {
    log.info("Ingestion cycle complete — nothing new this cycle", {
      totalFetched,
      totalIngested,
      totalDroppedQuality,
      totalDroppedDup,
      totalCappedRemaining,
      totalMem0Failures,
      dailyCount: budget.count,
      dailyCap: budget.cap,
    });
  } else {
    log.info("Ingestion cycle complete", {
      totalFetched,
      totalIngested,
      totalDroppedQuality,
      totalDroppedDup,
      totalCappedRemaining,
      totalMem0Failures,
      dailyCount: budget.count,
      dailyCap: budget.cap,
    });
  }
}
