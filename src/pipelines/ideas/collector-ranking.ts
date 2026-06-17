/**
 * Pure collector-side ranking & field-promotion helpers.
 *
 * All functions here are dependency-free, side-effect-free, and deterministic
 * (given an injected `rng` where randomness is used). They power the
 * credibility × velocity × corroboration × recency weighted top-K selection in
 * collectors.ts and the promotion of structured JSON columns (Product Hunt
 * makers/topics, Reddit/HN top-comments) into the Capability shape.
 *
 * Extracted from collectors.ts to keep that file focused and these primitives
 * independently unit-testable in the fast unit lane.
 */

import type { CapabilityMaker } from "./types";

/** Clamp a number into the inclusive [0, 1] range; NaN → 0. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Coerce an unknown DB cell to a finite number (default 0). */
export function toNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Min-max normalize a set of raw velocity values into [0, 1] keyed by row id.
 *
 * Negative velocities (decelerating) clamp to 0; a flat batch (all equal)
 * yields 0 for every row (no momentum signal). Pure and deterministic.
 */
export function normalizeVelocities(
  entries: readonly { readonly id: string; readonly velocity: number }[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (entries.length === 0) return out;

  const positive = entries.map((e) => Math.max(0, toNumber(e.velocity)));
  const max = Math.max(...positive);
  if (max <= 0) {
    for (const e of entries) out.set(e.id, 0);
    return out;
  }
  entries.forEach((e, i) => {
    out.set(e.id, clamp01(positive[i]! / max));
  });
  return out;
}

/**
 * Recency factor in [0, 1] from an epoch-seconds timestamp using exponential
 * decay with a half-life in days. Missing/zero timestamps → neutral 0.5.
 */
export function recencyFactor(
  epochSeconds: number | null | undefined,
  nowSeconds: number,
  halfLifeDays = 7,
): number {
  const ts = toNumber(epochSeconds);
  if (ts <= 0) return 0.5;
  const ageDays = Math.max(0, (nowSeconds - ts) / 86_400);
  const halfLife = Math.max(0.1, halfLifeDays);
  return clamp01(Math.pow(0.5, ageDays / halfLife));
}

/** Inputs to the combined per-row rank score. */
export interface RankInputs {
  /** Source-credibility weight in [0, 1]. Defaults to 0.5 when absent. */
  readonly credibility?: number;
  /** Normalized momentum in [0, 1]. Defaults to 0 when absent. */
  readonly velocityNorm?: number;
  /** Distinct-source corroboration count (1 = single source). */
  readonly corroborationCount?: number;
  /** Recency factor in [0, 1]. Defaults to 0.5 when absent. */
  readonly recency?: number;
}

/**
 * Combine credibility × velocity × corroboration × recency into a single
 * additive rank score, then fold in a small exploration jitter so the top-K is
 * not perfectly deterministic (exploration/exploitation). Pure given `rng`.
 *
 * Weighting (documented intentionally): credibility dominates (authority +
 * engagement), momentum and corroboration are meaningful boosts, recency is a
 * mild tie-breaker. Corroboration is log-scaled so a 3rd source matters less
 * than the 2nd. The result is in roughly [0, 1] before jitter.
 */
export function computeRankScore(
  inputs: RankInputs,
  rng: () => number = Math.random,
  explorationWeight = 0.15,
): number {
  const credibility = clamp01(inputs.credibility ?? 0.5);
  const velocityNorm = clamp01(inputs.velocityNorm ?? 0);
  const recency = clamp01(inputs.recency ?? 0.5);
  const corro = Math.max(1, toNumber(inputs.corroborationCount, 1));
  // log2(corro): 1→0, 2→1, 4→2 … scaled into [0, ~0.6].
  const corroBoost = clamp01(Math.log2(corro) / 3);

  const base =
    0.45 * credibility +
    0.25 * velocityNorm +
    0.2 * corroBoost +
    0.1 * recency;

  const jitter = explorationWeight * rng();
  return base + jitter;
}

/**
 * Filter rows to unconsumed (fresh) ones, then select the top-`target` by a
 * caller-supplied combined score (descending). Falls back to input order when
 * `adaptive` is false (preserves the legacy raw-popularity selection).
 *
 * Returns the selected rows in ranked order plus their ids. Pure given `score`.
 */
export function selectRanked<T>(
  rows: readonly T[],
  consumed: ReadonlySet<string>,
  idExtractor: (row: T) => string,
  target: number,
  score: (row: T) => number,
  adaptive: boolean,
): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] } {
  const fresh: T[] = [];
  for (const row of rows) {
    if (!consumed.has(idExtractor(row))) fresh.push(row);
  }

  const ordered = adaptive
    ? [...fresh]
        .map((row, i) => ({ row, i, s: score(row) }))
        // Stable: tie-break by original index to keep determinism.
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.row)
    : fresh;

  const selected = ordered.slice(0, target);
  return { selected, selectedIds: selected.map(idExtractor) };
}

// ── Structured-field promotion (best-effort JSON parsing, never throws) ───────

/** Safe JSON parse of a text column to an array; never throws → []. */
export function parseJsonArray<T = unknown>(raw: unknown): readonly T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Extract Product Hunt makers from makers_json (best-effort, never throws). */
export function parseMakers(raw: unknown): readonly CapabilityMaker[] {
  const arr = parseJsonArray<Record<string, unknown>>(raw);
  const makers: CapabilityMaker[] = [];
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    const name =
      typeof m.name === "string"
        ? m.name
        : typeof m.username === "string"
          ? m.username
          : "";
    if (!name) continue;
    const handle =
      typeof m.username === "string"
        ? m.username
        : typeof m.handle === "string"
          ? m.handle
          : undefined;
    makers.push(handle ? { name, handle } : { name });
  }
  return makers.slice(0, 5);
}

/** Extract topic/tag labels from topics_json (best-effort). */
export function parseTopics(raw: unknown): readonly string[] {
  const arr = parseJsonArray<unknown>(raw);
  const topics: string[] = [];
  for (const t of arr) {
    if (typeof t === "string" && t.trim()) topics.push(t.trim());
    else if (t && typeof t === "object") {
      const name = (t as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) topics.push(name.trim());
    }
  }
  return topics.slice(0, 8);
}

/** Extract top comment texts from top_comments_json (best-effort, trimmed). */
export function parseTopComments(raw: unknown, max = 3): readonly string[] {
  const arr = parseJsonArray<unknown>(raw);
  const out: string[] = [];
  for (const c of arr) {
    let text = "";
    if (typeof c === "string") text = c;
    else if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      const candidate = obj.text ?? obj.content ?? obj.body;
      if (typeof candidate === "string") text = candidate;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text) out.push(text.slice(0, 240));
    if (out.length >= max) break;
  }
  return out;
}
