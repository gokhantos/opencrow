/**
 * outcome-memory-segments.ts — the PURE Pass-1 SEED segment-diversity directive.
 *
 * Extracted from outcome-memory.ts so the recall-ranking layer and the
 * segment-diversity layer stay in small, focused files. Aggregates a per-segment
 * exploration score over retrieved outcome memories and emits a bounded,
 * sanitized "explore these under-explored segments" directive. No I/O, no clock.
 *
 * SECURITY — over-explored labels come from UNTRUSTED mem0 bodies, so the
 * over-explored clause is sanitizeScrapedField'd AND wrapUntrusted-fenced. The
 * under-explored list is built from the trusted SEGMENT_IDS constant.
 */

import { sanitizeScrapedField, wrapUntrusted } from "../../sige/untrusted";
import type { OutcomeMemory, RetrievedOutcome } from "./outcome-memory";
import { SEGMENT_IDS } from "./segments";

const DIVERSITY_HEADER = "SEGMENT DIVERSITY (learned from past runs):";

/**
 * Number of over-explored segments to surface in the directive. Bounded so the
 * seed prompt does not balloon with a long tail of one-off segments.
 */
const MAX_OVER_EXPLORED = 4;
/**
 * Number of under-explored canonical segments to RECOMMEND. v2 names several
 * (not one) and asks for a balanced spread across them, so the run produces a
 * MIX rather than swapping one monopoly (healthcare) for another (fintech).
 */
const MAX_UNDER_EXPLORED = 5;
/**
 * Minimum distinct under-explored segments the model is asked to draw from. The
 * "at least N of [list]" framing is what prevents the candidate pool from
 * collapsing onto a single under-explored segment (the v1 over-correction).
 */
const MIN_UNDER_EXPLORED_TARGET = 3;

/**
 * Normalize a free-text segment label (e.g. "B2B-SaaS", "health care",
 * "ai native") to a canonical {@link SEGMENT_IDS} token for comparison: lower-
 * cased, non-alphanumeric runs collapsed to single underscores, edges trimmed.
 * Labels that do not map onto a canonical id keep their normalized form (they
 * still aggregate as over-explored, they just never count as "under-explored").
 * PURE.
 */
function normalizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Weight one retrieved outcome as an EXPLORATION signal for its segment. An
 * AVOID verdict (archived / dedup-rejected) means the segment was mined and the
 * result was thrown away — a strong "over-explored" signal, so it counts double.
 * A validated outcome is a mild positive signal (the segment paid off), so it
 * counts as a small NEGATIVE pressure (we subtract) — we do not want to flag a
 * segment that keeps producing winners as "over-explored". PURE.
 */
function explorationWeight(verdict: OutcomeMemory["verdict"]): number {
  switch (verdict) {
    case "archived":
    case "dedup-rejected":
      return 2;
    case "validated":
      return -1;
    case "stored-pending":
      return 0;
  }
}

/**
 * Deterministically rotate `items` left by `seed % length` positions so that
 * which under-explored segments LEAD the recommendation varies run-to-run while
 * the set stays stable. `seed = 0` (default) is a no-op. PURE + immutable.
 */
function rotateBySeed<T>(items: readonly T[], seed: number): readonly T[] {
  if (items.length <= 1) return items;
  const offset = ((seed % items.length) + items.length) % items.length;
  if (offset === 0) return items;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/**
 * Build a bounded, sanitized SEGMENT-DIVERSITY directive for the SEED stage
 * (Pass 1) from retrieved outcome memories. Aggregates a per-segment exploration
 * score: archived + dedup-rejected weigh heavily (the segment was mined and
 * discarded), validated subtracts (it is paying off, leave it alone). Segments
 * with a net-positive score are "over-explored"; the highest-scoring few are
 * named. "Under-explored" is the set of canonical {@link SEGMENT_IDS} that are
 * NOT over-explored, capped to {@link MAX_UNDER_EXPLORED}.
 *
 * v2 TUNING — balanced spread, not a new monopoly. The directive asks the model
 * to draw from AT LEAST {@link MIN_UNDER_EXPLORED_TARGET} of the named
 * under-explored segments and caps any single one at roughly half the ideas, so
 * the Pass-1 seed produces a MULTI-segment pool that the downstream
 * enforceSegmentSpread cap can actually balance (v1 steered the whole run onto a
 * single under-explored segment, leaving the cap nothing to spread). The
 * `rotationSeed` (derived from the run id upstream) rotates WHICH under-explored
 * segments lead, so consecutive runs explore different corners.
 *
 * SECURITY — the over-explored labels come from UNTRUSTED mem0 bodies, so the
 * whole over-explored clause is sanitizeScrapedField'd AND wrapUntrusted-fenced
 * (mirroring the Pass-2 sibling `bullet`). The under-explored list is built from
 * the trusted {@link SEGMENT_IDS} constant and the fixed instruction text, so it
 * stays outside the fence as plain directive prose.
 *
 * Empty input (or no net-over-explored segment) → "" so a default run is
 * byte-identical and the seed prompt is unchanged. PURE — no I/O, no throw.
 */
export function buildSegmentDiversityDirective(
  retrieved: readonly RetrievedOutcome[],
  rotationSeed = 0,
): string {
  if (retrieved.length === 0) return "";

  // Aggregate exploration score per normalized segment, remembering a display
  // label (first-seen, sanitized) for each.
  const scores = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const r of retrieved) {
    const seg = r.metadata.segment;
    if (!seg) continue;
    const key = normalizeSegment(seg);
    if (key.length === 0) continue;
    scores.set(key, (scores.get(key) ?? 0) + explorationWeight(r.metadata.verdict));
    if (!labels.has(key)) labels.set(key, sanitizeScrapedField(seg, 40));
  }

  // Net-positive exploration pressure = over-explored. Compute once; derive both
  // the named (display, capped) list and the masking key set from it.
  const overEntries = [...scores.entries()].filter(([, score]) => score > 0);

  // Named over-explored: strongest first, capped, mapped to display labels.
  const overExplored = [...overEntries]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_OVER_EXPLORED)
    .map(([key]) => labels.get(key) ?? key);

  if (overExplored.length === 0) return "";

  // Under-explored = canonical segments NOT flagged over-explored. Use the FULL
  // over-explored key set (not just the capped/named subset) so a free-text
  // "health care" over-explored entry masks the canonical "healthcare" id, and a
  // segment over the MAX_OVER_EXPLORED cap is still not recommended. Rotate so
  // the lead segments vary per run.
  const overKeys = new Set(overEntries.map(([key]) => key));
  const underAll = SEGMENT_IDS.filter((id) => !overKeys.has(id));
  const underExplored = rotateBySeed(underAll, rotationSeed).slice(0, MAX_UNDER_EXPLORED);

  // No canonical room left to spread into → degrade to neutral (do not emit a
  // directive that only names over-explored segments with nowhere to send the run).
  if (underExplored.length === 0) return "";

  const overText = overExplored.join(", ");
  const underText = underExplored.join(", ");
  // How many distinct segments to ask for: at least MIN, but never more than the
  // number we actually named.
  const drawCount = Math.min(MIN_UNDER_EXPLORED_TARGET, underExplored.length);

  // The over-explored clause is untrusted (mem0-derived) → fence it. The
  // instruction prose + canonical under-explored list are trusted → plain text.
  const overClause = wrapUntrusted(
    "outcome-memory-segments",
    `over-explored (frequently archived/duplicated in past runs): ${overText}`,
  );

  return (
    `${DIVERSITY_HEADER}\n${overClause}\n` +
    `Aim for a BALANCED SPREAD this run — draw from at least ${drawCount} of: ${underText}. ` +
    "Favor variety across these under-explored, defensible segments; " +
    "no more than ~half the ideas should come from any single segment, " +
    "and do not over-index on the over-explored ones."
  );
}
