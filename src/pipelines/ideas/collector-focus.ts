/**
 * Seed-diversity pure helpers (idea-quality fix #2).
 *
 * Attacks generation-seed MONOCULTURE at the SOURCE — extracted as pure
 * functions so the selection / rotation / down-weight logic is unit-testable
 * WITHOUT a DB. The three levers:
 *
 *   Lever 1 — selectFocusCategories(): demote the always-identical lowest-rated
 *     set; keep a high-opportunity HEAD but ROTATE the rest across the category
 *     distribution, and AVOID recently-anchored categories (complements
 *     buildSaturatedThemes()).
 *   Lever 2 — buildPainSeedSummary(): lead the pain seed with the SPECIFIC
 *     LLM-extracted pain themes so the concrete recurring complaint (not the
 *     bare store-category name) is the primary pain seed reaching the prompt.
 *   Lever 3 — isEchoChamberSignal(): identify AI-builder-meta capability signals
 *     (curated meta subreddits + generic "AI agent/LLM framework" github/PH
 *     signals) so scanCapabilities can DOWN-WEIGHT (not eliminate) their rank.
 */

import type { CategoryStat, PainTheme } from "./types";

// Re-export so existing importers (tests, collectors) can pull the type from
// either module. The canonical definition lives in ./types (TrendData carries it).
export type { CategoryStat } from "./types";

// ── Lever 1: focus-category selection / rotation ─────────────────────────────

/** Deterministic non-negative 32-bit hash for seeded rotation. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Normalize a category to a stable comparison key. */
export function normalizeCategory(category: string): string {
  return category.trim().toLowerCase();
}

export interface SelectFocusInput {
  /** Candidate categories with stats (any order). */
  readonly stats: readonly CategoryStat[];
  /** Total categories to return. */
  readonly spread: number;
  /** How many come from the high-opportunity head (lowest-rated, most acute). */
  readonly highOpportunitySlice: number;
  /**
   * Per-run rotation seed (e.g. derived from the run id). Rotates WHICH
   * mid/long-tail categories lead so consecutive runs differ.
   */
  readonly rotationSeed: number;
  /**
   * Categories anchored by RECENT runs (e.g. from recent generated_ideas.category)
   * — de-prioritized so the pipeline doesn't re-anchor on the same set.
   * Compared case-insensitively. Complements buildSaturatedThemes().
   */
  readonly recentlyAnchored?: readonly string[];
}

/**
 * Select a DIVERSE spread of focus categories.
 *
 * - The HEAD (`highOpportunitySlice` items) is the genuine high-opportunity set:
 *   lowest avgRating, then highest complaintRatio. This keeps acute pain in play.
 * - The TAIL is ROTATED: remaining categories are ordered by a seeded rotation
 *   key (so the slice that leads differs per run) with a penalty for
 *   recently-anchored categories, then the top `spread - head` are taken.
 *
 * Pure + deterministic given the same inputs (including rotationSeed).
 */
export function selectFocusCategories(input: SelectFocusInput): readonly string[] {
  const { stats, spread, highOpportunitySlice, rotationSeed, recentlyAnchored } = input;
  if (spread <= 0 || stats.length === 0) return [];

  // De-dup by normalized category, keeping the first occurrence.
  const seen = new Set<string>();
  const unique: CategoryStat[] = [];
  for (const s of stats) {
    const key = normalizeCategory(s.category);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }

  const anchoredSet = new Set((recentlyAnchored ?? []).map(normalizeCategory));

  // HEAD: highest opportunity (lowest rating, then highest complaint ratio).
  const headCount = Math.min(highOpportunitySlice, spread, unique.length);
  const byOpportunity = [...unique].sort(
    (a, b) => a.avgRating - b.avgRating || b.complaintRatio - a.complaintRatio,
  );
  const head = byOpportunity.slice(0, headCount);
  const headKeys = new Set(head.map((s) => normalizeCategory(s.category)));

  // TAIL: everything not in the head, ordered by a seeded rotation key. A
  // recently-anchored category is pushed DOWN (penalty added to its key) so the
  // rotation prefers fresh corners of the distribution this run.
  const remaining = unique.filter((s) => !headKeys.has(normalizeCategory(s.category)));
  const tailCount = Math.min(spread - head.length, remaining.length);
  const rotationKey = (cat: string): number => {
    const base = hashString(`${rotationSeed}:${normalizeCategory(cat)}`);
    const penalty = anchoredSet.has(normalizeCategory(cat)) ? 2 ** 31 : 0;
    return base + penalty;
  };
  const tail = [...remaining]
    .sort((a, b) => rotationKey(a.category) - rotationKey(b.category))
    .slice(0, tailCount);

  return [...head, ...tail].map((s) => s.category);
}

// ── Lever 2: pain-seed summary (specific themes lead) ────────────────────────

/**
 * Render the SPECIFIC LLM pain themes as the LEADING pain seed, with the
 * category-aggregate cluster summary demoted to BACKGROUND context.
 *
 * When no specific themes exist (extraction failed / none returned), returns the
 * raw category summary unchanged — fully backward-compatible.
 *
 * NOTE: callers MUST sanitize scraped text BEFORE passing it here. This helper
 * does no sanitization (it only re-orders already-prepared strings).
 */
export function buildPainSeedSummary(
  painThemes: readonly Pick<PainTheme, "name" | "description" | "frequency" | "affectedApps">[],
  categorySummary: string,
  maxThemes = 15,
): string {
  if (painThemes.length === 0) return categorySummary;

  const themeLines = painThemes.slice(0, maxThemes).map((t) => {
    const apps = t.affectedApps.slice(0, 3).join(", ");
    const appNote = apps ? ` (seen in: ${apps})` : "";
    return `  • [${t.frequency}] ${t.name}: ${t.description}${appNote}`;
  });

  const parts = [
    "=== SPECIFIC USER PAIN THEMES (the concrete recurring problems — PRIMARY pain seed) ===",
    ...themeLines,
  ];
  if (categorySummary.trim()) {
    parts.push(
      "",
      "--- category-level review aggregates (BACKGROUND context only) ---",
      categorySummary,
    );
  }
  return parts.join("\n");
}

// ── Lever 3: AI-builder echo-chamber detection ───────────────────────────────

/**
 * Curated AI-builder-meta subreddits. Lowercased, no "r/" prefix. A capability
 * signal originating from one of these is META about building with AI, not real
 * end-user pain, so it is DOWN-WEIGHTED (not removed).
 */
export const META_SUBREDDITS: ReadonlySet<string> = new Set([
  "vibecoding",
  "saas",
  "microsaas",
  "claudecode",
  "claudeai",
  "chatgpt",
  "chatgptcoding",
  "openai",
  "anthropic",
  "artificialinteligence",
  "artificial",
  "promptengineering",
  "deepseek",
  "localllama",
  "machinelearning",
  "singularity",
  "llmdevs",
  "aiagents",
  "ollama",
  "stablediffusion",
  "midjourney",
  "automate",
  "indiehackers",
]);

/**
 * Generic "AI agent / LLM framework" meta phrases that mark a github repo / PH
 * launch / HN story as AI-builder meta rather than an end-user product signal.
 * Matched case-insensitively as substrings against the title + description.
 */
export const META_PHRASES: readonly string[] = [
  "ai agent",
  "agent framework",
  "agentic framework",
  "agent-native",
  "agent native",
  "llm framework",
  "llm agent",
  "llm orchestrat",
  "agent orchestrat",
  "rag framework",
  "prompt engineering",
  "prompt framework",
  "vector database",
  "fine-tun",
  "mcp server",
  "model context protocol",
  "multi-agent",
  "autonomous agent",
  "ai sdk",
  "llm gateway",
  "build your own agent",
  "open-source llm",
  "open source llm",
];

export interface EchoChamberInput {
  /** Lowercased subreddit (no "r/"), if the signal came from reddit. */
  readonly subreddit?: string | null;
  /** Free-text tag (e.g. github topic, PH topic) if available. */
  readonly tag?: string | null;
  /** Title + description text used for phrase matching. */
  readonly text?: string | null;
}

/**
 * True when a capability candidate is AI-builder META (curated meta subreddit OR
 * a generic agent/LLM-framework phrase in its tag/text). Used to apply the
 * configurable echo-chamber down-weight multiplier.
 */
export function isEchoChamberSignal(input: EchoChamberInput): boolean {
  const sub = input.subreddit?.trim().toLowerCase();
  if (sub && META_SUBREDDITS.has(sub)) return true;

  const haystack = `${input.tag ?? ""} ${input.text ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return META_PHRASES.some((p) => haystack.includes(p));
}

// ── Source-pick HARD-DROP exclusion (audience + region-lock) ─────────────────
//
// A parallel of the echo-chamber lever, but a HARD ELIMINATION (drop the signal
// before it can become a candidate) rather than a down-weight. It mirrors the
// generation-time NEVER_GENERATE_BLOCK exclusions at SOURCE-PICK time so junk is
// gone earliest: signals whose audience is a LOCAL / SMB SERVICE BUSINESS (its
// owner or trade/field workers), and signals whose core is REGION-LOCKED to a
// single nation's system / payment rail / locale. Distinct from
// isEchoChamberSignal — keep the two predicates separate.

/**
 * Curated skilled-trades / field-service + local-SMB-service-business
 * subreddits. Lowercased, no "r/" prefix. A signal originating from one of these
 * is about a LOCAL / SMB SERVICE BUSINESS audience, which is out of scope, so it
 * is HARD-DROPPED. Curated for high precision — extend conservatively (a too-broad
 * entry risks dropping legitimately-global signals; the generation/jury layers
 * are the backstop, not this list).
 */
export const EXCLUDED_AUDIENCE_SUBREDDITS: ReadonlySet<string> = new Set([
  // skilled trades & field-service
  "hvac",
  "hvacadvice",
  "plumbing",
  "plumbingrepair",
  "electricians",
  "electrical",
  "askelectricians",
  "construction",
  "contractor",
  "handyman",
  "landscaping",
  "lawncare",
  "autorepair",
  "mechanicadvice",
  "autodetailing",
  "cleaning",
  // local service businesses
  "restaurateur",
  "kitchenconfidential",
  "restaurant",
  "bartenders",
  "salon",
  "hairstylist",
  "barber",
  "esthetics",
  "personaltraining",
  "fitnesstrainers",
  "dentistry",
  "veterinary",
  "realestate",
  "realtors",
]);

/**
 * Substring markers (lowercased) for a LOCAL / SMB SERVICE-BUSINESS AUDIENCE.
 * Matched against the `${tag} ${text}` haystack. High-precision "for X" forms
 * are preferred over bare nouns so a passing mention of a trade doesn't drop a
 * globally-applicable signal.
 */
export const EXCLUDED_AUDIENCE_PHRASES: readonly string[] = [
  "for electricians",
  "for plumbers",
  "for hvac",
  "for contractors",
  "for landscapers",
  "for cleaners",
  "for restaurants",
  "for cafes",
  "for salons",
  "for barbershops",
  "for gyms",
  "for dental practices",
  "for vet clinics",
  "field service business",
  "home service business",
  "for local businesses",
  "for small service businesses",
];

/**
 * HIGH-PRECISION national-system / payment-rail tokens that mark a signal's core
 * as REGION-LOCKED to a single country/region. Region detection on raw text is
 * noisy, so this list is intentionally TIGHT — only tokens that strongly imply a
 * non-generalizable, single-nation binding. FALSE-POSITIVE RISK: a globally
 * applicable signal that merely mentions one of these in passing could be
 * dropped; we accept that tradeoff because the generation prompt
 * (NEVER_GENERATE_BLOCK) and the jury are the broader backstop, and we keep the
 * tokens specific to reduce it.
 */
export const REGION_LOCKED_PHRASES: readonly string[] = [
  "upi payment",
  "upi id",
  "pix payment",
  "ideal payment",
  "sepa direct debit",
  "aadhaar",
  "pan card",
  "gst filing",
  "gst return",
  "tds filing",
  "irs tax filing",
  "1099 filing",
  "hmrc",
  "self assessment tax",
  "section 8 housing",
  "nhs",
  "medicare billing",
  "cpf",
  "pix key",
];

/**
 * True when a source signal should be HARD-DROPPED at pick time: it originates
 * from an excluded local/SMB service-business subreddit, OR its tag/text matches
 * a local/SMB service-business AUDIENCE phrase or a REGION-LOCKED token. Pure;
 * mirrors {@link isEchoChamberSignal}'s structure but is a DROP, not a
 * down-weight. Distinct from isEchoChamberSignal — do not conflate them.
 */
export function isExcludedSourceSignal(input: EchoChamberInput): boolean {
  const sub = input.subreddit?.trim().toLowerCase();
  if (sub && EXCLUDED_AUDIENCE_SUBREDDITS.has(sub)) return true;

  const haystack = `${input.tag ?? ""} ${input.text ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  if (EXCLUDED_AUDIENCE_PHRASES.some((p) => haystack.includes(p))) return true;
  return REGION_LOCKED_PHRASES.some((p) => haystack.includes(p));
}
