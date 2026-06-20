/**
 * Layer C — INCUMBENT EXCLUSION.
 *
 * The idea funnel kept seeding "build a DoorDash / Spotify / Uber" ideas because
 * the collectors surface the highest-engagement (= most-incumbent) signals, and
 * the review/pain clusters are dominated by complaints ABOUT those giants. A solo
 * builder cannot out-execute a top-100 charted app, so signals that PROMINENTLY
 * name such an incumbent are noise for THIS pipeline.
 *
 * This module derives the set of top-N charted / high-review-count app names from
 * the EXISTING app-store tables and provides PURE matchers so the collectors can:
 *   - HARD-DROP review/pain signals that are complaints about a named giant, and
 *   - STRONG-DOWN-RANK capability-scan signals that prominently name one (so they
 *     can't seed the head of the candidate pool).
 *
 * The name-loading touches the DB; everything else here is PURE and dependency-
 * free (no clock / rng) so the matching logic is fully unit-testable. The matcher
 * guards against trivially-short names ("x", "hi") to avoid false positives.
 */

import type { SQL } from "bun";

/** The shape returned by {@link getDb} — a Bun.sql tagged-template client. */
type Db = InstanceType<typeof SQL>;

// ── Tunable constants (exported so callers / tests can override) ──────────────

/** Default top-N charted apps treated as incumbents. */
export const DEFAULT_TOP_N_INCUMBENTS = 100;

/**
 * Minimum normalized-name length before a name is allowed to match. Short tokens
 * like "x", "hi", "go" produce rampant false positives against arbitrary review
 * text, so anything below this is dropped from the incumbent set entirely.
 */
export const MIN_INCUMBENT_NAME_LENGTH = 3;

/**
 * Down-rank multiplier applied to a capability-scan rank score whose text
 * prominently names a top-N incumbent. Strong enough that an incumbent-named
 * signal cannot seed the head of the pool, but not zero (it can still corroborate
 * a niche idea further down). PURE-logic, default-ON safe.
 */
export const INCUMBENT_DOWNRANK_FACTOR = 0.1;

// ── Pure name normalization ──────────────────────────────────────────────────

/**
 * Normalize a raw app/product name into a comparison key: lowercase, strip
 * punctuation to spaces, collapse whitespace, trim. PURE — deterministic.
 *
 * e.g. "DoorDash - Food Delivery" → "doordash food delivery"; "Uber!" → "uber".
 */
export function normalizeName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .normalize("NFKD")
    // Replace anything that is not a letter/number/space with a space.
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduce a normalized full name to its salient leading token(s) for matching.
 *
 * App names are usually "<Brand> - <tagline>" / "<Brand>: <descriptor>", so the
 * brand we want to match on is the FIRST word (or first two for two-word brands
 * like "google maps"). We index BOTH the first token and the first-two-token
 * prefix so "doordash" matches and "google maps" matches, without indexing the
 * entire tagline (which would over-match). PURE.
 */
export function incumbentMatchKeys(normalizedName: string): readonly string[] {
  if (normalizedName.length < MIN_INCUMBENT_NAME_LENGTH) return [];
  const tokens = normalizedName.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const keys = new Set<string>();
  const first = tokens[0];
  if (first && first.length >= MIN_INCUMBENT_NAME_LENGTH) keys.add(first);
  if (tokens.length >= 2) {
    const firstTwo = `${tokens[0]} ${tokens[1]}`;
    if (firstTwo.length >= MIN_INCUMBENT_NAME_LENGTH) keys.add(firstTwo);
  }
  return [...keys];
}

/**
 * Build a normalized incumbent-name match set from raw app names. PURE — exposed
 * so {@link loadIncumbentNames} (DB) and unit tests share the exact same logic.
 *
 * Each raw name is normalized and reduced to its salient match keys; trivially
 * short keys are dropped (see {@link MIN_INCUMBENT_NAME_LENGTH}).
 */
export function buildIncumbentSet(
  rawNames: readonly (string | null | undefined)[],
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const raw of rawNames) {
    const normalized = normalizeName(raw);
    for (const key of incumbentMatchKeys(normalized)) set.add(key);
  }
  return set;
}

/**
 * Whether `text` PROMINENTLY names an incumbent from `incumbentSet`. Matching is
 * word-boundary-ish on the normalized text: a key matches only when it appears as
 * a whole-word token sequence, not as a substring of a larger word (so "uber"
 * does NOT match "ubered" arbitrarily and "go" never matched at all, being below
 * the min length). PURE — deterministic, no IO.
 */
export function mentionsIncumbent(
  text: string | null | undefined,
  incumbentSet: ReadonlySet<string>,
): boolean {
  if (incumbentSet.size === 0) return false;
  const normalized = normalizeName(text);
  if (normalized.length < MIN_INCUMBENT_NAME_LENGTH) return false;
  // Pad with spaces so every token has a leading + trailing boundary; then a key
  // is present iff " <key> " is a substring (whole-word, multi-word safe).
  const padded = ` ${normalized} `;
  for (const key of incumbentSet) {
    if (key.length < MIN_INCUMBENT_NAME_LENGTH) continue;
    if (padded.includes(` ${key} `)) return true;
  }
  return false;
}

// ── DB loader ────────────────────────────────────────────────────────────────

/**
 * Load the set of top-N charted + high-review-count app names from the app-store
 * tables and normalize them into an incumbent match set. Parameterized topN; no
 * string interpolation into SQL. Never throws — returns an empty set on any DB
 * failure so the caller's de-bias path degrades to a no-op rather than breaking
 * the pipeline.
 */
export async function loadIncumbentNames(
  db: Db,
  topN: number = DEFAULT_TOP_N_INCUMBENTS,
): Promise<ReadonlySet<string>> {
  const limit = Math.max(1, Math.floor(topN));
  const names: (string | null | undefined)[] = [];

  try {
    // Top-charted incumbents: top-free ∪ top-paid by rank (rank 1 = top).
    const charted = (await db`
      SELECT name
      FROM appstore_rankings
      WHERE list_type IN ('top-free', 'top-paid') AND rank > 0
      ORDER BY rank ASC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    for (const row of charted) {
      if (typeof row.name === "string") names.push(row.name);
    }
  } catch {
    // appstore_rankings may be absent / empty — fall through to reviews.
  }

  try {
    // High-review-count apps: the most-reviewed apps are de-facto incumbents even
    // if they are not currently top-charted.
    const reviewed = (await db`
      SELECT app_name, COUNT(*) AS review_count
      FROM appstore_reviews
      WHERE app_name IS NOT NULL AND app_name <> ''
      GROUP BY app_name
      ORDER BY review_count DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    for (const row of reviewed) {
      if (typeof row.app_name === "string") names.push(row.app_name);
    }
  } catch {
    // appstore_reviews may lack app_name — ignore.
  }

  return buildIncumbentSet(names);
}
