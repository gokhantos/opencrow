/**
 * Pure, unit-testable helpers for binding Pass-3 GIANT critiques back to their
 * candidates.
 *
 * Background (the live regression these helpers fix): the GIANT critic used to
 * score the ENTIRE over-generated pool (~20 candidates) in ONE LLM call. With
 * deepseek-v4-flash on the wide pass the 38-41k-char response TRUNCATED even at
 * a 32k output cap, so:
 *   - the strict parser fell to the lenient walker EVERY run (the model's
 *     `\`\`\`json`-fenced + truncated output never parsed strictly), and
 *   - the lenient walker only salvaged the COMPLETE front-half scorecards
 *     (~10-11 of 20), so the back half was dropped.
 * The positional fallback then refused to bind (recovered count != pool count),
 * and reworded titles missed the title map — so NO candidate received a GIANT
 * scorecard and every `giant_*` column persisted NULL.
 *
 * The fix is to CHUNK the critique: score a small batch (~6-8) per call so each
 * response fits the token budget and fully parses, and positional alignment
 * holds PER BATCH. These helpers hold the chunk/parse/bind math so it can be
 * tested without a `chat` client; the orchestration (the per-chunk chat loop)
 * lives in `critiqueIdeas`.
 */

import { parseJsonArrayLenient, parseJsonFromResponse } from "./synthesizer";
import { parseGiant, type ParsedGiant } from "./giant";
import { parseCompetability, type CompetabilityScore } from "./competability";

/** One parsed GIANT critique entry, keyed back to its idea by title. */
export interface GiantCritiqueEntry {
  readonly title: string;
  readonly parsed: ParsedGiant;
  readonly painSeverity: number;
  readonly verdict: string;
  /** Layer B: parsed competability moat score (present only when emitted). */
  readonly competability?: CompetabilityScore;
}

/**
 * Strict-then-lenient parse of a critique response into raw objects.
 *
 * The strict pass (`parseJsonFromResponse`) handles a clean `\`\`\`json` fence
 * or a complete bare array. When that yields nothing — the live failure mode is
 * a fenced array TRUNCATED at the token cap, whose missing closing `\`\`\`` and
 * `]` defeat the strict regex/`JSON.parse` — we fall back to the truncation-
 * tolerant walker, which recovers every COMPLETE top-level element and discards
 * only an incomplete trailing one. Never throws; returns `[]` on no array.
 */
export function parseRawCritiques(text: string): readonly unknown[] {
  const strict = parseJsonFromResponse<unknown[]>(text, []);
  if (strict.length > 0) return strict;
  return parseJsonArrayLenient(text);
}

/**
 * Tolerantly normalize raw critique objects into ordered {@link GiantCritiqueEntry}
 * values. `parseGiant`/`parseCompetability` never throw, so a malformed row
 * degrades to safe defaults rather than killing the pass. Rows without a usable
 * title are skipped (they cannot be bound). Order is preserved so a POSITIONAL
 * fallback can bind by index when the count matches the batch.
 */
export function buildCritiqueEntries(
  rawCritiques: readonly unknown[],
  competabilityOn: boolean,
): readonly GiantCritiqueEntry[] {
  const entries: GiantCritiqueEntry[] = [];
  for (const raw of rawCritiques) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    if (title.trim().length === 0) continue;
    const parsed = parseGiant(raw);
    const painSeverity =
      typeof r.painSeverity === "number"
        ? Math.min(5, Math.max(0, r.painSeverity))
        : parsed.scores.acuteProblem;
    const competabilityScore =
      competabilityOn && "competability" in r
        ? parseCompetability(r.competability)
        : undefined;
    entries.push({
      title,
      parsed,
      painSeverity,
      verdict: typeof r.verdict === "string" ? r.verdict : "",
      ...(competabilityScore ? { competability: competabilityScore } : {}),
    });
  }
  return entries;
}

/** One critiqued batch: the parsed entries plus the candidates that batch scored. */
export interface CritiqueBatch {
  /** Candidate titles in the order they were sent to the critic for this batch. */
  readonly batchTitles: readonly string[];
  /** Parsed critique entries recovered for this batch (emission order). */
  readonly entries: readonly GiantCritiqueEntry[];
}

/**
 * A resolved binder: a candidate (identified by its 0-based pool index and its
 * title) maps to its GIANT critique, or `undefined` when none was recovered.
 */
export interface CritiqueBinder {
  readonly lookup: (poolIndex: number, title: string) => GiantCritiqueEntry | undefined;
}

/**
 * Merge per-batch critique results into a single binder over the WHOLE pool.
 *
 * Binding strategy, in priority order, per candidate:
 *   1. exact title match (case-insensitive, trimmed) — robust across batches;
 *   2. PER-BATCH positional fallback — only when a batch returned exactly one
 *      entry per candidate it scored (the prompt's "same order" contract), so a
 *      lightly-reworded title still binds by index WITHOUT the whole-pool count
 *      having to match. This is the key win over the old single-call path, where
 *      one truncated entry disabled positional binding for the entire pool.
 *
 * `batches` MUST be in pool order and partition the pool contiguously (batch 0
 * is pool indices [0, n0), batch 1 is [n0, n0+n1), ...). That mirrors how the
 * orchestrator chunks the candidate list.
 */
export function bindCritiques(batches: readonly CritiqueBatch[]): CritiqueBinder {
  const byTitle = new Map<string, GiantCritiqueEntry>();
  // poolIndex -> entry, populated only for batches that are positionally aligned.
  const byIndex = new Map<number, GiantCritiqueEntry>();

  let poolOffset = 0;
  for (const batch of batches) {
    // Title map: first writer wins so an earlier, complete batch is not clobbered
    // by a later duplicate-titled row (set only when absent).
    for (const entry of batch.entries) {
      const key = entry.title.toLowerCase().trim();
      if (key.length > 0 && !byTitle.has(key)) byTitle.set(key, entry);
    }

    // Positional fallback is sound only when THIS batch returned one entry per
    // candidate it scored. Aligned per batch — not gated on the whole pool.
    if (batch.entries.length === batch.batchTitles.length) {
      for (let i = 0; i < batch.entries.length; i++) {
        byIndex.set(poolOffset + i, batch.entries[i]!);
      }
    }
    poolOffset += batch.batchTitles.length;
  }

  return {
    lookup: (poolIndex, title) =>
      byTitle.get(title.toLowerCase().trim()) ?? byIndex.get(poolIndex),
  };
}
