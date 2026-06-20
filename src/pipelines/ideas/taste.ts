/**
 * Phase 4 "WARM THE COLD TASTE LOOP" — PURE taste machinery.
 *
 * The calibration/learning loops the earlier phases built (signal-calibration,
 * credibility, validated-exemplars) are all keyed on idea_feedback, which is
 * EMPTY at cold-start (0 human labels). Every learning loop is therefore inert.
 * This module breaks cold-start WITHOUT waiting for humans, by deriving taste
 * directly from the GIANT-scored ideas the pipeline already produces:
 *
 *   1. ANTI-EXEMPLARS  — an "AVOID these generic archetypes" block built from
 *      low-GIANT / templated ideas. The higher-leverage half for genericness
 *      AND the SAFER half for mode-collapse (negatives don't pull generation
 *      toward a seed the way positives do).
 *   2. SYNTHETIC GOLDEN-SET — when there are < goldenMinHumanLabels real
 *      human-validated ideas, derive POSITIVE exemplars from the BEST existing
 *      scored ideas (high GIANT composite, segment-diverse, grounded, NOT
 *      generic). Real human-validated ideas always take precedence and REPLACE
 *      the synthetic ones as they accrue.
 *
 * CRITICAL ANTI-MODE-COLLAPSE RULE: few-shot exemplars can collapse generation
 * TOWARD the seeds, killing novelty. So we (a) keep counts LOW (default 4),
 * (b) ROTATE the chosen set across runs by a deterministic seed so successive
 * runs vary, and (c) lean on the safer anti-exemplars. The eval-harness novelty
 * metric is the real gate — this module only supplies low, rotating sets.
 *
 * EVERYTHING here is PURE and dependency-free (no DB / clock / rng): callers
 * pass already-scored idea rows. That makes selection, rotation, and the
 * generic-archetype heuristic fully deterministic and unit-testable. The
 * DB-reading + prompt-injection glue lives in the Pipeline phase.
 */

import type { GiantAxisScores } from "./giant";
import type { SegmentId } from "./segments";

/**
 * Local, dependency-free prompt sanitizer mirroring the synthesizer's, inlined
 * so this module stays PURE (the synthesizer pulls in LLM clients / DB). Strips
 * fenced blocks, prompt-injection phrases, and role tags; bounds length.
 */
function sanitizeForPrompt(text: string): string {
  return (text ?? "")
    .replace(/`{3,}/g, "'''")
    .replace(
      /\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|prompts?)\b/gi,
      "[filtered]",
    )
    .replace(/<\/?(?:system|assistant|user|human)>/gi, "[filtered]")
    .slice(0, 80000);
}

// ── Input: an already-scored idea row ─────────────────────────────────────────

/**
 * The minimal projection of a `generated_ideas` row this module needs. Mirrors
 * the persisted GIANT/segment/demand columns (giant_composite, giant_scores_json,
 * archetype, segment, demand_score, whitespace, pipeline_stage). All scoring
 * fields are OPTIONAL so the module degrades gracefully on partial rows — a row
 * with no GIANT data simply scores as ungrounded/low and is treated accordingly.
 */
export interface ScoredIdeaRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category?: string | null;
  /** Canonical opportunity-space tag (consumer/b2b_saas/devtools/...). */
  readonly segment?: SegmentId | string | null;
  /** Weighted geometric-mean GIANT composite, 0..5. */
  readonly giantComposite?: number | null;
  /** Full 7-axis GIANT scorecard, when present. */
  readonly giantScores?: Partial<GiantAxisScores> | null;
  /** Sequoia-style archetype tag. */
  readonly archetype?: string | null;
  /** Demand-artifact score, 0..5 (grounding signal). */
  readonly demandScore?: number | null;
  /** Whitespace flag from the demand probe (uncontested opportunity). */
  readonly whitespace?: boolean | null;
  /**
   * Pipeline stage. `'validated'` marks a HUMAN-validated idea, which always
   * takes precedence over synthetic golden picks.
   */
  readonly pipelineStage?: string | null;
}

// ── Output shapes (reported for the Pipeline phase) ───────────────────────────

/**
 * A positive few-shot exemplar — a high-quality idea to produce "MORE like".
 * `synthetic` distinguishes a bootstrap pick (derived from a high-GIANT scored
 * idea) from a real human-validated one; the prompt block does not need it but
 * callers/eval can use it to know when the golden set is still synthetic.
 */
export interface GoldenExemplar {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category?: string;
  readonly segment?: string;
  readonly giantComposite: number;
  /** true when derived from a scored idea (bootstrap), false when human-validated. */
  readonly synthetic: boolean;
}

/**
 * A negative archetype — a generic/low-GIANT idea to steer AWAY from. `reason`
 * is the human-readable "why this is generic/weak" string surfaced in the
 * AVOID block so the model learns the pattern, not just the instance.
 */
export interface AntiExemplar {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category?: string;
  readonly giantComposite: number;
  /** Why this was flagged (generic-archetype reason and/or low-GIANT). */
  readonly reason: string;
}

// ── Tunable thresholds ────────────────────────────────────────────────────────

/** Default cap on how many exemplars to inject (LOW, to resist mode-collapse). */
export const DEFAULT_EXEMPLAR_COUNT = 4;

/**
 * Default minimum number of HUMAN-validated ideas before the golden set stops
 * using synthetic bootstrap picks entirely.
 */
export const DEFAULT_GOLDEN_MIN_HUMAN_LABELS = 10;

/** A "grounded" idea has a demand score at or above this (out of 5). */
export const GROUNDED_DEMAND_MIN = 2;

/**
 * A golden bootstrap pick must clear this GIANT composite (out of 5). Synthetic
 * positives need a real quality bar so we don't seed the loop with mediocrity.
 */
export const GOLDEN_GIANT_MIN = 3.2;

/** An anti-exemplar is flagged on LOW GIANT at or below this composite. */
export const ANTI_GIANT_MAX = 2.2;

/**
 * Generic-archetype detection: an idea whose novelty/defensibility axes are BOTH
 * at or below this is treated as undifferentiated (template territory).
 */
export const GENERIC_AXIS_MAX = 2;

// ── Generic-archetype heuristic (PURE) ────────────────────────────────────────

/** Result of {@link isGenericArchetype}: the verdict plus a human-readable why. */
export interface GenericVerdict {
  readonly generic: boolean;
  readonly reason: string;
}

/**
 * Templated "X for Y" / "Uber for Z" / "AI-powered <noun>" patterns. Matching is
 * case-insensitive on the title + the first sentence of the summary. These are
 * the classic undifferentiated shells — a vehicle with no acute problem behind
 * it. Kept conservative so we flag SHELLS, not legitimately-scoped ideas.
 */
const TEMPLATE_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /\b(uber|airbnb|tinder|netflix|shopify)\s+for\s+\w+/i, label: '"<famous-app> for X" template' },
  { re: /\bai[-\s]?powered\s+\w+/i, label: '"AI-powered <noun>" shell' },
  { re: /\b(an?\s+)?app\s+for\s+\w+/i, label: '"an app for X" shell' },
  { re: /\b\w+\s+app\s+for\s+\w+/i, label: '"X app for Y" template' },
  { re: /\ball[-\s]in[-\s]one\s+\w+/i, label: '"all-in-one <noun>" shell' },
  { re: /\b(platform|marketplace|dashboard|tool)\s+for\s+\w+/i, label: '"<generic-noun> for X" shell' },
];

/** Vague openers that, absent any acute-problem grounding, signal a vitamin. */
const VAGUE_OPENERS: readonly RegExp[] = [
  /\bhelps?\s+(?:people|users|you)\b/i,
  /\bmakes?\s+it\s+easy\b/i,
  /\bstreamlines?\b/i,
  /\bone[-\s]stop\b/i,
];

/**
 * First sentence (rough) of a free-text blob, lower-bounded so an empty/odd
 * summary still yields a string. PURE.
 */
function firstSentence(text: string): string {
  const trimmed = (text ?? "").trim();
  const dot = trimmed.search(/[.!?]\s/);
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

function clampScore(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, value));
}

/**
 * Pure heuristic flagging a templated / undifferentiated "generic archetype".
 *
 * An idea is generic when EITHER:
 *   - its title/lead matches a known template shell ("X for Y", "AI-powered
 *     <noun>", "all-in-one <noun>", ...) AND it lacks acute-problem grounding
 *     (low acuteProblem axis or a vague-opener summary with no demand), OR
 *   - its GIANT novelty AND defensibility axes are BOTH at/below
 *     {@link GENERIC_AXIS_MAX} (the model itself judged it undifferentiated).
 *
 * Conservative on purpose: a template phrase ALONE is not enough — a genuinely
 * acute "Uber for X" with a high acuteProblem axis is NOT flagged. PURE: no DB,
 * clock, or rng; deterministic for the same row.
 */
export function isGenericArchetype(idea: ScoredIdeaRow): GenericVerdict {
  const scores = idea.giantScores ?? undefined;
  const novelty = scores ? clampScore(scores.nonObviousness) : undefined;
  const defensibility = scores ? clampScore(scores.defensibility) : undefined;
  const acute = scores ? clampScore(scores.acuteProblem) : undefined;
  const demand = clampScore(idea.demandScore);

  // 1) Model-judged undifferentiation: both novelty AND defensibility are weak.
  if (
    typeof novelty === "number" &&
    typeof defensibility === "number" &&
    novelty <= GENERIC_AXIS_MAX &&
    defensibility <= GENERIC_AXIS_MAX
  ) {
    return {
      generic: true,
      reason: `low novelty (${novelty}) AND defensibility (${defensibility}) — undifferentiated`,
    };
  }

  // 2) Template-shell title/lead with no acute-problem grounding.
  const haystack = `${idea.title ?? ""}. ${firstSentence(idea.summary ?? "")}`;
  const template = TEMPLATE_PATTERNS.find((p) => p.re.test(haystack));
  const acuteGrounded =
    (typeof acute === "number" && acute >= 3) || demand >= GROUNDED_DEMAND_MIN;
  if (template && !acuteGrounded) {
    return {
      generic: true,
      reason: `${template.label} with no acute-problem grounding`,
    };
  }

  // 3) Vague-opener vitamin: hand-wavy "helps people…" with no demand evidence.
  const vague = VAGUE_OPENERS.some((re) => re.test(haystack));
  if (vague && demand < GROUNDED_DEMAND_MIN && !acuteGrounded) {
    return {
      generic: true,
      reason: "vague vitamin framing with no demand evidence",
    };
  }

  return { generic: false, reason: "" };
}

// ── Uncompetable-market detector (PURE) ───────────────────────────────────────

/**
 * Moat-keyword families that signal a structurally hard-to-enter market for a
 * small builder (delivery/logistics/marketplace/regulated). Complements the
 * template detector above: a "DoorDash for X" idea can pass the template check
 * (high acuteProblem) yet still be uncompetable. Conservative — these are FLAGS.
 */
const UNCOMPETABLE_MARKET_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /\b(food|grocery|package|parcel|meal)\s+deliver(y|ies)\b/i, label: "physical delivery / last-mile logistics" },
  { re: /\blast[-\s]?mile\b/i, label: "last-mile logistics" },
  { re: /\bride[-\s]?(hail|shar)(ing|e)\b/i, label: "ride-hailing fleet ops" },
  { re: /\b(two|2)[-\s]?sided\s+marketplace\b/i, label: "two-sided marketplace network effect" },
  { re: /\bgig\s+(economy|marketplace)\b/i, label: "gig marketplace network effect" },
  { re: /\bsocial\s+network(ing)?\b/i, label: "social-network cold-start moat" },
  { re: /\b(streaming\s+(service|platform)|content\s+licens(e|ing))\b/i, label: "content-licensing capital moat" },
  { re: /\b(neobank|banking\s+app|insuranc(e|er))\b/i, label: "regulated / licensed market" },
];

/** Result of {@link isUncompetableMarket}: verdict + human-readable why. */
export interface UncompetableVerdict {
  readonly uncompetable: boolean;
  readonly reason: string;
}

/**
 * Pure heuristic flagging an idea whose MARKET is structurally uncompetable for a
 * small/solo builder — a moat (logistics, two-sided network, capital, regulation)
 * the small builder cannot overcome. Complements {@link isGenericArchetype}
 * (which catches templated SHELLS) by catching well-specified but un-winnable
 * markets.
 *
 * Flagged when the title/summary names a known uncompetable-market pattern.
 * Conservative: a high GIANT defensibility axis (>= 4) means the idea itself has
 * a credible counter-moat, so it is NOT flagged (the model judged it winnable).
 * PURE — no DB, clock, or rng.
 */
export function isUncompetableMarket(idea: ScoredIdeaRow): UncompetableVerdict {
  const scores = idea.giantScores ?? undefined;
  const defensibility = scores ? clampScore(scores.defensibility) : undefined;
  // The idea has a credible counter-moat of its own — don't flag the market.
  if (typeof defensibility === "number" && defensibility >= 4) {
    return { uncompetable: false, reason: "" };
  }

  const haystack = `${idea.title ?? ""}. ${idea.summary ?? ""}`;
  const match = UNCOMPETABLE_MARKET_PATTERNS.find((p) => p.re.test(haystack));
  if (match) {
    return {
      uncompetable: true,
      reason: `${match.label} — incumbent moat a small builder cannot overcome`,
    };
  }
  return { uncompetable: false, reason: "" };
}

// ── Grounding ─────────────────────────────────────────────────────────────────

/** A "grounded" idea has real demand evidence (demand score or whitespace). */
export function isGrounded(idea: ScoredIdeaRow): boolean {
  return clampScore(idea.demandScore) >= GROUNDED_DEMAND_MIN || idea.whitespace === true;
}

function isHumanValidated(idea: ScoredIdeaRow): boolean {
  return idea.pipelineStage === "validated";
}

// ── Deterministic rotation (PURE, anti-mode-collapse) ─────────────────────────

/**
 * Rotate a list deterministically by a non-negative integer seed (e.g. a run
 * index), so successive runs surface a DIFFERENT slice of an over-long pool and
 * never collapse generation toward a fixed seed set. A simple cyclic shift
 * preserves the relative quality order within the rotated window. PURE.
 */
export function rotateBySeed<T>(items: readonly T[], seed: number): readonly T[] {
  const n = items.length;
  if (n <= 1) return items.slice();
  const s = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) : 0;
  const offset = s % n;
  if (offset === 0) return items.slice();
  return [...items.slice(offset), ...items.slice(0, offset)];
}

// ── Options ───────────────────────────────────────────────────────────────────

/** Options for {@link selectGoldenExemplars}. */
export interface GoldenSelectOptions {
  /** Cap on the returned set (LOW — default {@link DEFAULT_EXEMPLAR_COUNT}). */
  readonly exemplarCount?: number;
  /** Min human-validated count before synthetic picks are dropped entirely. */
  readonly goldenMinHumanLabels?: number;
  /** Deterministic rotation seed (e.g. run index) — varies the set across runs. */
  readonly rotationSeed?: number;
  /** Min GIANT composite for a SYNTHETIC bootstrap pick. */
  readonly giantMin?: number;
}

/** Options for {@link selectAntiExemplars}. */
export interface AntiSelectOptions {
  /** Cap on the returned set (LOW — default {@link DEFAULT_EXEMPLAR_COUNT}). */
  readonly exemplarCount?: number;
  /** Deterministic rotation seed (e.g. run index). */
  readonly rotationSeed?: number;
  /** Max GIANT composite below which a row counts as a low-GIANT negative. */
  readonly giantMax?: number;
}

// ── Segment-diverse golden selection (PURE) ───────────────────────────────────

function toGolden(idea: ScoredIdeaRow, synthetic: boolean): GoldenExemplar {
  return {
    id: idea.id,
    title: idea.title,
    summary: idea.summary,
    ...(idea.category ? { category: idea.category } : {}),
    ...(idea.segment ? { segment: String(idea.segment) } : {}),
    giantComposite: clampScore(idea.giantComposite),
    synthetic,
  };
}

/**
 * Greedily pick at most `count` rows from `ordered` (already best-first) while
 * MAXIMIZING segment diversity: first pass takes one per unseen segment, then
 * later passes backfill the remaining slots in order. Keeps the set from being
 * "4 consumer apps". PURE; preserves the input order within each pass.
 */
function pickSegmentDiverse(
  ordered: readonly ScoredIdeaRow[],
  count: number,
): readonly ScoredIdeaRow[] {
  if (count <= 0) return [];
  const chosen: ScoredIdeaRow[] = [];
  const seenSegments = new Set<string>();
  const seenIds = new Set<string>();

  // Pass 1: one per distinct segment (untagged rows grouped under "").
  for (const idea of ordered) {
    if (chosen.length >= count) break;
    const seg = idea.segment ? String(idea.segment) : "";
    if (seenSegments.has(seg)) continue;
    seenSegments.add(seg);
    seenIds.add(idea.id);
    chosen.push(idea);
  }

  // Pass 2: backfill remaining slots, best-first, skipping already-chosen.
  for (const idea of ordered) {
    if (chosen.length >= count) break;
    if (seenIds.has(idea.id)) continue;
    seenIds.add(idea.id);
    chosen.push(idea);
  }

  return chosen;
}

/**
 * Select the BEST positive exemplars to inject as a "produce MORE like these"
 * block. PURE — takes already-scored rows, no DB.
 *
 * Precedence + cold-start fallback:
 *   - HUMAN-validated rows (pipeline_stage='validated') always come first and
 *     are NEVER synthetic.
 *   - Only when the human-validated count is < goldenMinHumanLabels do we
 *     backfill with SYNTHETIC bootstrap picks: high-GIANT (>= giantMin),
 *     grounded, NOT generic. As real labels accrue, synthetic picks are dropped.
 *
 * Quality + diversity + anti-mode-collapse:
 *   - Candidates sorted by GIANT composite (desc), then rotated by rotationSeed
 *     so successive runs vary, then thinned to be SEGMENT-DIVERSE, then capped
 *     to exemplarCount (LOW by default).
 */
export function selectGoldenExemplars(
  scoredIdeas: readonly ScoredIdeaRow[],
  opts: GoldenSelectOptions = {},
): readonly GoldenExemplar[] {
  const count = Math.max(0, opts.exemplarCount ?? DEFAULT_EXEMPLAR_COUNT);
  if (count === 0 || scoredIdeas.length === 0) return [];
  const minHuman = opts.goldenMinHumanLabels ?? DEFAULT_GOLDEN_MIN_HUMAN_LABELS;
  const giantMin = opts.giantMin ?? GOLDEN_GIANT_MIN;
  const seed = opts.rotationSeed ?? 0;

  const byCompositeDesc = (a: ScoredIdeaRow, b: ScoredIdeaRow) =>
    clampScore(b.giantComposite) - clampScore(a.giantComposite);

  const human = scoredIdeas
    .filter(isHumanValidated)
    .slice()
    .sort(byCompositeDesc);

  const humanRotated = rotateBySeed(human, seed);
  const humanPicks = pickSegmentDiverse(humanRotated, count).map((i) =>
    toGolden(i, false),
  );

  // Enough real labels, or already full → no synthetic backfill.
  if (human.length >= minHuman || humanPicks.length >= count) {
    return humanPicks.slice(0, count);
  }

  const chosenIds = new Set(humanPicks.map((g) => g.id));
  const synthetic = scoredIdeas
    .filter(
      (i) =>
        !isHumanValidated(i) &&
        !chosenIds.has(i.id) &&
        clampScore(i.giantComposite) >= giantMin &&
        isGrounded(i) &&
        !isGenericArchetype(i).generic,
    )
    .slice()
    .sort(byCompositeDesc);

  const syntheticRotated = rotateBySeed(synthetic, seed);
  const remaining = count - humanPicks.length;
  const syntheticPicks = pickSegmentDiverse(syntheticRotated, remaining).map((i) =>
    toGolden(i, true),
  );

  return [...humanPicks, ...syntheticPicks].slice(0, count);
}

// ── Anti-exemplar selection (PURE) ────────────────────────────────────────────

function toAnti(idea: ScoredIdeaRow, reason: string): AntiExemplar {
  return {
    id: idea.id,
    title: idea.title,
    summary: idea.summary,
    ...(idea.category ? { category: idea.category } : {}),
    giantComposite: clampScore(idea.giantComposite),
    reason,
  };
}

/**
 * Select clear NEGATIVE archetypes for the "AVOID these" block. PURE.
 *
 * A row qualifies when it is a generic archetype ({@link isGenericArchetype})
 * AND/OR scores at/below `giantMax` on the GIANT composite. Human-validated
 * ideas are NEVER used as negatives (a human said they're good). Picks are
 * ordered WORST-first (lowest composite), rotated by rotationSeed, then capped.
 *
 * Anti-exemplars are the SAFER lever against mode-collapse than positives — they
 * teach the model what to avoid without pulling generation toward a seed — so we
 * favor surfacing them even at low counts.
 */
export function selectAntiExemplars(
  scoredIdeas: readonly ScoredIdeaRow[],
  opts: AntiSelectOptions = {},
): readonly AntiExemplar[] {
  const count = Math.max(0, opts.exemplarCount ?? DEFAULT_EXEMPLAR_COUNT);
  if (count === 0 || scoredIdeas.length === 0) return [];
  const giantMax = opts.giantMax ?? ANTI_GIANT_MAX;
  const seed = opts.rotationSeed ?? 0;

  const candidates: AntiExemplar[] = [];
  for (const idea of scoredIdeas) {
    if (isHumanValidated(idea)) continue; // a human approved it — not a negative
    const verdict = isGenericArchetype(idea);
    const composite = clampScore(idea.giantComposite);
    const lowGiant = composite <= giantMax;
    if (!verdict.generic && !lowGiant) continue;

    const reasons: string[] = [];
    if (verdict.generic) reasons.push(verdict.reason);
    if (lowGiant) reasons.push(`low GIANT composite (${composite.toFixed(2)})`);
    candidates.push(toAnti(idea, reasons.join("; ")));
  }

  // Worst-first so the most-egregious negatives lead the AVOID block.
  const ordered = candidates
    .slice()
    .sort((a, b) => a.giantComposite - b.giantComposite);

  return rotateBySeed(ordered, seed).slice(0, count);
}

// ── Prompt-block rendering (PURE) ─────────────────────────────────────────────

/**
 * Render the positive golden block ("produce MORE like these"). Empty in →
 * empty string out, so callers can inject unconditionally. Symmetric to the
 * synthesizer's buildValidatedExemplars block.
 */
export function renderGoldenBlock(exemplars: readonly GoldenExemplar[]): string {
  if (exemplars.length === 0) return "";
  const lines = exemplars.map((ex) => {
    const cat = ex.category ? `[${sanitizeForPrompt(ex.category)}] ` : "";
    const seg = ex.segment ? ` {${sanitizeForPrompt(ex.segment)}}` : "";
    return `  • ${cat}${sanitizeForPrompt(ex.title)}${seg}: ${sanitizeForPrompt(
      ex.summary.slice(0, 160),
    )}`;
  });
  return [
    "",
    "=== HIGH-BAR EXEMPLARS (produce MORE like these — same rigor, NOT duplicates) ===",
    "These scored highest on the GIANT rubric: acute problem, dated why-now, real demand.",
    "Match their specificity and grounding. Do NOT copy them — generate fundamentally new ideas.",
    ...lines,
  ].join("\n");
}

/**
 * Render the negative anti-exemplar block ("AVOID these generic archetypes").
 * Empty in → empty string out. This is the genericness lever: it names the
 * PATTERN to avoid (via each row's reason), not just the instance.
 */
export function renderAntiBlock(antiExemplars: readonly AntiExemplar[]): string {
  if (antiExemplars.length === 0) return "";
  const lines = antiExemplars.map((ex) => {
    const cat = ex.category ? `[${sanitizeForPrompt(ex.category)}] ` : "";
    const why = ex.reason ? ` — ${sanitizeForPrompt(ex.reason)}` : "";
    return `  ✗ ${cat}${sanitizeForPrompt(ex.title)}: ${sanitizeForPrompt(
      ex.summary.slice(0, 120),
    )}${why}`;
  });
  return [
    "",
    "=== AVOID these generic archetypes that scored POORLY (do NOT generate anything like them) ===",
    "These are undifferentiated shells — templated 'X for Y', vague 'AI-powered <noun>', no acute problem.",
    "Steer AWAY from this entire pattern, not just these exact titles.",
    ...lines,
  ].join("\n");
}
