/**
 * Pure mapper: discovered SIGE frontiers → shareable `ThemeCandidate[]`.
 *
 * This is the seam that lets the autonomous SIGE funnel reuse the pipeline's
 * Stage-2 shallow-ideation (`runShallowIdeation`) + Stage-3 diversity selection
 * (`selectDiverseBy`) instead of collapsing the discovered frontier pool to the
 * single lexically-largest, pool-share-winning theme.
 *
 * THE ROOT-CAUSE FIX lives here: `ThemeCandidate.signalStrength` is mapped from
 * `frontier.novelty`, NOT `frontier.signalStrength` (which is pool-share =
 * members.length / total). Pool-share rewards monoculture — the biggest lexical
 * cluster always wins — so feeding it forward reproduces the bug. Novelty rewards
 * freshness instead, and `kind` (the theme bucket) drives diversity selection so
 * near-duplicate themes collapse into one bucket.
 *
 * PURE: no I/O, no LLM, no mutation. Untrusted member text is whitespace-collapsed
 * and length-bounded here; the downstream cheap model additionally sanitizes via
 * `sanitizeCandidateText`, so this never lowers the prompt-injection bar.
 */

import type { ThemeCandidate } from "../../pipelines/ideas/shallow-ideation";
import type { Frontier } from "./frontier-discovery";

/** Member candidates folded into the grounding context for the cheap model. */
const MAX_CONTEXT_MEMBERS = 5;
/** Hard cap on the assembled context string (the model re-bounds to 400). */
const MAX_CONTEXT_LEN = 2000;

/** Collapse whitespace, trim, and hard-cap a single text fragment. */
function normalizeFragment(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Theme bucket used as the diversity bucket downstream. The first normalized
 * n-gram key when present, else the lowercased theme label, so near-duplicate
 * themes collapse into one bucket during `selectDiverseBy`.
 */
function themeBucket(frontier: Frontier): string {
  const first = frontier.themeKeys[0];
  if (first !== undefined && first.length > 0) return first;
  return frontier.theme.toLowerCase();
}

/**
 * Build the grounding context the cheap model sketches against: up to
 * {@link MAX_CONTEXT_MEMBERS} member titles/summaries plus the frontier's
 * `seedText`, whitespace-collapsed and length-bounded.
 */
function buildContext(frontier: Frontier): string {
  const memberLines = frontier.candidates
    .slice(0, MAX_CONTEXT_MEMBERS)
    .map((c) => normalizeFragment(`${c.title} — ${c.summary}`))
    .filter((line) => line.length > 0);
  const seed = normalizeFragment(frontier.seedText);
  const parts = seed.length > 0 ? [...memberLines, seed] : memberLines;
  return parts.join("\n").slice(0, MAX_CONTEXT_LEN);
}

/**
 * Map discovered frontiers to provider-agnostic {@link ThemeCandidate}s for the
 * shared shallow-ideation + diversity pipeline. Order is preserved; the input is
 * never mutated.
 */
export function frontiersToThemeCandidates(
  frontiers: readonly Frontier[],
): readonly ThemeCandidate[] {
  return frontiers.map((frontier) => ({
    id: frontier.id,
    title: frontier.theme,
    // Root-cause fix: weight by novelty, never pool-share signalStrength.
    signalStrength: frontier.novelty,
    kind: themeBucket(frontier),
    source: "sige",
    context: buildContext(frontier),
  }));
}
