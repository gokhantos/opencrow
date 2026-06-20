/**
 * outcome-competability-correlation.ts — the LEARNED half of moat scoring.
 *
 * The competability gate (competability.ts) decides "can a small builder win this
 * market?" from STATIC constants and an LLM moat score. This module closes the
 * loop: it correlates those moat signals with REAL idea OUTCOMES that already came
 * back from mem0 (validated vs archived), and distils a small, BOUNDED directive
 * that nudges the next synthesis round — "high-moat ideas pursued here
 * underperformed; low-moat niche ideas validated". So moat preference becomes
 * learned from results, not just the hard-coded thresholds.
 *
 * Everything here is PURE aggregation over the STRUCTURED metadata of memories the
 * caller already fetched — NO new mem0 round-trip, NO LLM call. It reads only the
 * numeric/boolean competability slice on each {@link OutcomeMemory}; it never
 * parses the untrusted body text, and the lines it emits are fixed directive prose
 * built from in-code constants and counts (no scraped/LLM strings), so they need
 * no untrusted fence.
 *
 * Empty / no-competability input → "" so a default run (or a corpus with no scored
 * memories) is byte-identical to the pre-feature path.
 */

import { createLogger } from "../../logger";
import { COMPETABILITY_DIMENSIONS, type CompetabilityDimension } from "./competability";
import type { OutcomeCompetability, RetrievedOutcome } from "./outcome-memory";

const log = createLogger("pipeline:outcome-competability");

const HEADER = "MOAT LEARNINGS (correlation of competability scores with real outcomes):";

/** Display label for each moat dimension in rendered prose (stable order). */
const MOAT_LABELS: Readonly<Record<CompetabilityDimension, string>> = {
  capital: "capital",
  networkEffect: "network",
  logistics: "logistics",
  regulated: "regulated",
} as const;

/**
 * A moat dimension at or above this EFFECTIVE score is "high" — strong enough to
 * name as a barrier in a rendered sentence and to count as a high-moat memory in
 * the correlation below. Mirrors the gate's soft-band intuition (a moat in the
 * 3.5..5 range is materially in the way of a small builder).
 */
export const HIGH_MOAT_THRESHOLD = 3.5;

/**
 * Names the moat dimensions at/above {@link HIGH_MOAT_THRESHOLD} on a competability
 * slice, strongest first, mapped to display labels. Empty when no moat is high.
 * Shared by the write-side sentence renderer and the read-side correlation so both
 * agree on what "high moat" means. PURE.
 */
export function highMoats(competability: OutcomeCompetability): readonly string[] {
  return [...COMPETABILITY_DIMENSIONS]
    .filter((d) => competability.dimensions[d] >= HIGH_MOAT_THRESHOLD)
    .sort((a, b) => competability.dimensions[b] - competability.dimensions[a])
    .map((d) => MOAT_LABELS[d]);
}

/**
 * Minimum number of outcomes on EACH side of a comparison before we trust a
 * correlation. Below this the signal is noise — a single archived high-moat idea
 * should not steer a whole run. Named, not magic.
 */
export const MIN_CORRELATION_SAMPLES = 3;

/**
 * A high-moat idea is one whose EFFECTIVE overall "can-win" score is at or below
 * this — i.e. the moats are materially in the way. Symmetric with
 * {@link HIGH_MOAT_THRESHOLD} on the dimensions: an idea is "high-moat" either by a
 * low overall can-win OR by carrying a named high moat dimension.
 */
export const LOW_CAN_WIN_OVERALL = 2.5;

/** Internal tally of one verdict bucket's competability profile. */
interface MoatTally {
  /** How many outcomes in this bucket carried a high-moat signal. */
  readonly highMoat: number;
  /** How many carried a low-moat (wide-open) signal. */
  readonly lowMoat: number;
  /** Total scored outcomes in this bucket (highMoat + lowMoat + neutral). */
  readonly total: number;
  /** Distinct named high-moat dimensions seen, strongest-first preserved by insertion. */
  readonly moatNames: ReadonlySet<string>;
}

/** Does this competability slice represent a high-moat (hard-to-win) idea? PURE. */
function isHighMoat(c: OutcomeCompetability): boolean {
  return c.overall <= LOW_CAN_WIN_OVERALL || highMoats(c).length > 0;
}

/** Does this represent a low-moat (wide-open) idea? PURE. */
function isLowMoat(c: OutcomeCompetability): boolean {
  return c.overall > LOW_CAN_WIN_OVERALL && highMoats(c).length === 0;
}

/** Tally the competability profile of one verdict bucket. PURE. */
function tally(items: readonly RetrievedOutcome[]): MoatTally {
  const moatNames = new Set<string>();
  let highMoat = 0;
  let lowMoat = 0;
  let total = 0;
  for (const item of items) {
    const c = item.metadata.competability;
    if (!c) continue;
    total += 1;
    if (isHighMoat(c)) {
      highMoat += 1;
      for (const name of highMoats(c)) moatNames.add(name);
    } else if (isLowMoat(c)) {
      lowMoat += 1;
    }
  }
  return { highMoat, lowMoat, total, moatNames };
}

/**
 * Build a small BOUNDED moat-learnings directive from retrieved outcomes by
 * correlating their competability signals with the verdict bucket they landed in:
 *
 *   - AVOID line: emitted when {@link MIN_CORRELATION_SAMPLES}+ ARCHIVED ideas
 *     carried high moats — "high-moat ideas pursued here underperformed", naming
 *     the recurring moats.
 *   - REINFORCE line: emitted when {@link MIN_CORRELATION_SAMPLES}+ VALIDATED ideas
 *     were low-moat (wide-open) — "low-moat niche ideas validated well".
 *
 * Each side is gated independently on its own sample floor, so a thin corpus emits
 * at most the line it actually has evidence for (or nothing). The lines are fixed
 * directive prose over in-code constants + counts + the named moat set; no scraped
 * or LLM text reaches the output. Caps are RESPECTED by construction: this emits
 * at most two lines and is APPENDED to the existing REINFORCE/AVOID block which the
 * caller has already de-duped and capped — it does not expand those buckets.
 *
 * Empty input or no competability-scored memories → "" (byte-identical default).
 * PURE — no I/O, no clock, no throw.
 */
export function buildMoatLearningsDirective(
  retrieved: readonly RetrievedOutcome[],
): string {
  if (retrieved.length === 0) return "";

  const validated = retrieved.filter((r) => r.metadata.verdict === "validated");
  const archived = retrieved.filter((r) => r.metadata.verdict === "archived");

  const archivedTally = tally(archived);
  const validatedTally = tally(validated);

  const lines: string[] = [];

  if (archivedTally.highMoat >= MIN_CORRELATION_SAMPLES) {
    const moats =
      archivedTally.moatNames.size > 0
        ? ` (recurring barriers: ${[...archivedTally.moatNames].join(", ")})`
        : "";
    lines.push(
      `AVOID — ${archivedTally.highMoat} high-moat ideas were ARCHIVED${moats}: ` +
        "favor markets a small/solo builder can realistically win in v1; " +
        "down-weight ideas whose incumbents sit behind heavy capital, network, " +
        "logistics, or regulatory moats.",
    );
  }

  if (validatedTally.lowMoat >= MIN_CORRELATION_SAMPLES) {
    lines.push(
      `REINFORCE — ${validatedTally.lowMoat} low-moat (wide-open) ideas were VALIDATED: ` +
        "lean toward niche, low-capital, defensible-by-focus ideas where no " +
        "incumbent moat blocks a small builder.",
    );
  }

  if (lines.length === 0) return "";

  log.info("Moat-learnings directive emitted", {
    archivedHighMoat: archivedTally.highMoat,
    validatedLowMoat: validatedTally.lowMoat,
    moatNames: [...archivedTally.moatNames],
  });

  return [HEADER, ...lines].join("\n");
}
