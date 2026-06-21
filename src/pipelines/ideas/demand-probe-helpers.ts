/**
 * Phase 2 — DEMAND-PROBE SHARED HELPERS (LEAF module).
 *
 * Pure, dependency-light helpers shared by the demand-grounding probes. These
 * live here — and NOT in ./demand-probes.ts — to break a module-init cycle:
 * ./semantic-demand-probe.ts needs these helpers, while ./demand-probes.ts needs
 * `semanticDemandProbe` for its top-level {@link DEFAULT_DEMAND_PROBES} array.
 * Co-locating the helpers in ./demand-probes.ts made that a circular import whose
 * evaluation order produced a TDZ crash ("Cannot access 'semanticDemandProbe'
 * before initialization") when ./semantic-demand-probe.ts was loaded first.
 *
 * This module is a LEAF: it imports ONLY from ./demand (itself a leaf) and the
 * std lib — crucially NOT from ./demand-probes or ./semantic-demand-probe — so it
 * stays acyclic. ./demand-probes.ts re-exports every symbol below to keep its
 * public surface unchanged.
 *
 * Behaviour here is byte-identical to the previous in-place definitions; this is
 * a pure move, no logic change.
 */

import {
  DEFAULT_MIN_KEYWORD_HITS,
  keywordPrefilterTerm,
  type DemandProbeOptions,
} from "./demand";

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default look-back window for demand evidence: 180 days (buyer-intent is slow). */
const DEFAULT_WINDOW_SEC = 180 * 24 * 3600;
/** Default row scan ceiling per probe. */
const DEFAULT_LIMIT = 60;
/** Max distinct keywords actually queried (cheaper, sharper). */
const MAX_QUERY_KEYWORDS = 8;
/** Trim quotes to keep evidence compact and auditable. */
const QUOTE_MAX_LEN = 240;

/** Lever 1/3 defaults (mirror smart.demand schema; used when opts omit them). */
const DEFAULT_WEAK_INTENT_FACTOR = 0.35;
const DEFAULT_WEAK_INTENT_MIN_ENGAGEMENT = 1.5;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp + default the probe window/limit/relevance-gate + fuzzy/weak options. */
export function resolveOpts(opts: DemandProbeOptions): {
  windowSec: number;
  limit: number;
  minKeywordHits: number;
  fuzzy: boolean;
  weakIntent: boolean;
  weakIntentFactor: number;
  weakIntentMinEngagement: number;
} {
  const windowSec =
    typeof opts.windowSec === "number" && opts.windowSec > 0
      ? Math.floor(opts.windowSec)
      : DEFAULT_WINDOW_SEC;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.floor(opts.limit)
      : DEFAULT_LIMIT;
  const minKeywordHits =
    typeof opts.minKeywordHits === "number" && opts.minKeywordHits >= 1
      ? Math.floor(opts.minKeywordHits)
      : DEFAULT_MIN_KEYWORD_HITS;
  // Fuzzy + weak-intent default ON (the recall fix); each reversible per-flag.
  const fuzzy = opts.fuzzyMatch !== false;
  const weakIntent = opts.weakIntent !== false;
  const weakIntentFactor =
    typeof opts.weakIntentFactor === "number" &&
    opts.weakIntentFactor >= 0 &&
    opts.weakIntentFactor <= 1
      ? opts.weakIntentFactor
      : DEFAULT_WEAK_INTENT_FACTOR;
  const weakIntentMinEngagement =
    typeof opts.weakIntentMinEngagement === "number" &&
    opts.weakIntentMinEngagement >= 1
      ? opts.weakIntentMinEngagement
      : DEFAULT_WEAK_INTENT_MIN_ENGAGEMENT;
  return {
    windowSec,
    limit,
    minKeywordHits,
    fuzzy,
    weakIntent,
    weakIntentFactor,
    weakIntentMinEngagement,
  };
}

/** Take the top-N keywords actually worth querying (cap cost, keep determinism). */
export function queryKeywords(keywords: readonly string[]): readonly string[] {
  return keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 3)
    .slice(0, MAX_QUERY_KEYWORDS);
}

/** Build a compact, verbatim quote around the matched marker for auditability. */
export function quoteAround(text: string, marker: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const idx = collapsed.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) return collapsed.slice(0, QUOTE_MAX_LEN);
  const start = Math.max(0, idx - 60);
  return collapsed.slice(start, start + QUOTE_MAX_LEN).trim();
}

/** Coerce an unknown DB cell to a trimmed string (empty when absent). */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Build a parameterized "any keyword appears in any of these columns" SQL filter.
 *
 * Bun 1.3.14 cannot bind `ILIKE ANY` / `= ANY` over a `db(arr)` array, so we
 * compose the OR-filter explicitly: each keyword becomes a `%kw%` parameter and
 * each (column × keyword) pair an `ILIKE $N` clause. The KEYWORD TEXT is ALWAYS
 * a bound parameter (never string-concatenated into SQL) — injection-safe. Only
 * the static column identifiers and `$N` placeholders are concatenated, and the
 * columns come from a fixed allow-list at each call site (never user input).
 *
 * Returns the SQL boolean expression (e.g. `(title ILIKE $1 OR content ILIKE $1
 * OR title ILIKE $2 OR ...)`) and the ordered `%kw%` params to pass to
 * `db.unsafe(sql, params)`. `startIndex` lets callers reserve leading params
 * (e.g. the window cutoff) before the keyword params.
 */
export function buildKeywordFilter(
  columns: readonly string[],
  keywords: readonly string[],
  startIndex: number,
  fuzzy = true,
): { clause: string; params: readonly string[] } {
  const params: string[] = [];
  const orParts: string[] = [];
  let idx = startIndex;
  for (const kw of keywords) {
    // Prefilter on the STEM body (e.g. "scheduling" → "%schedul%") so the cheap
    // ILIKE candidate filter is recall-safe across morphological variants; the
    // precise stem/boundary/synonym gate runs in code per row. The keyword text
    // is ALWAYS a bound parameter (never concatenated) — injection-safe.
    params.push(`%${keywordPrefilterTerm(kw, fuzzy)}%`);
    const placeholder = `$${idx}`;
    for (const col of columns) {
      orParts.push(`${col} ILIKE ${placeholder}`);
    }
    idx += 1;
  }
  return { clause: `(${orParts.join(" OR ")})`, params };
}

/** Coerce an unknown DB numeric cell to a finite non-negative number. */
export function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
