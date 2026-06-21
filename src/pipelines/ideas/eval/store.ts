/**
 * DB access for the offline ideas eval harness.
 *
 * Reads generated_ideas + idea_feedback into the pure-aggregation row shapes,
 * and appends immutable eval snapshots to idea_eval_runs (migration 012). Every
 * function degrades gracefully: a read failure returns [] and a write failure
 * returns null, so an eval run never breaks the caller.
 *
 * The parsing of critique_subscores_json out of generated_ideas is split into a
 * PURE helper ({@link parseCritiqueSubscores}) so it can be unit-tested without a DB.
 */

import type { CritiqueSubscores } from "./aggregate";
import {
  IMPORTANCE_BUCKETS,
} from "../signal-calibration";
import type { RankerEvalRow } from "./signal-ranker";
import type { SignalImportance } from "../../../memory/signal-facets";

// ── Pure parsing helpers ───────────────────────────────────────────────────────

/**
 * Parse a persisted critique_subscores_json value into a CritiqueSubscores, or
 * null when absent/malformed. Accepts either a JSON string (sql driver returning
 * text) or an already-parsed object (JSONB auto-parse). PURE — unit-testable.
 */
export function parseCritiqueSubscores(value: unknown): CritiqueSubscores | null {
  if (value === null || value === undefined) return null;

  let obj: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "null") return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const src = obj as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(src)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? (out as CritiqueSubscores) : null;
}

// ── Signal-ranker labeled rows (importance ↔ outcome ↔ asserted relevance) ─────

/** Terminal idea kinds/stages that count as a validated (success) outcome. */
const SUCCESS_KINDS: ReadonlySet<string> = new Set(["validated", "built"]);
/** Terminal idea kinds/stages that count as a killed (failure) outcome. */
const FAILURE_KINDS: ReadonlySet<string> = new Set(["archived", "dismissed"]);

interface RawSignalRankerRow {
  readonly importance: string | null;
  readonly category: string | null;
  readonly relevance_to_ideas: string | number | null;
  /** Latest terminal kind for the idea this signal contributed to. */
  readonly kind: string | null;
}

function asBucket(value: unknown): SignalImportance | null {
  return typeof value === "string" &&
    (IMPORTANCE_BUCKETS as readonly string[]).includes(value)
    ? (value as SignalImportance)
    : null;
}

function asRelevance(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Pure projection of joined DB rows into ranker eval rows. Exported for unit
 * testing without a DB. Skips rows with a non-terminal/unknown kind or an
 * unparseable importance bucket; carries through the LLM's asserted
 * relevance_to_ideas when present (used for the calibration gap).
 */
export function projectSignalRankerRows(
  rows: readonly RawSignalRankerRow[],
): readonly RankerEvalRow[] {
  const out: RankerEvalRow[] = [];
  for (const row of rows) {
    const kind = row?.kind ?? null;
    const success = kind !== null && SUCCESS_KINDS.has(kind);
    const failure = kind !== null && FAILURE_KINDS.has(kind);
    if (!success && !failure) continue; // non-terminal → not labeled
    const importance = asBucket(row?.importance);
    if (importance === null) continue;
    const category =
      typeof row.category === "string" && row.category.trim().length > 0
        ? row.category.trim()
        : undefined;
    out.push({
      importance,
      category,
      success,
      relevanceToIdeas: asRelevance(row.relevance_to_ideas),
    });
  }
  return out;
}

