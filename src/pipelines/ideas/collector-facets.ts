/**
 * Facet-aggregate enrichment for the trend-intersection collectors.
 *
 * GATED behind `pipelines.ideas.smart.signalFacets` (DEFAULT OFF). When enabled,
 * the collectors read the `signal_facets` table (populated at ingest by the
 * Foundations phase) and fold the aggregated problem_type / target_audience /
 * jtbd / sentiment distributions into the LLM context as a supplementary
 * "facet signal" block. This adds NO new external calls and NO LLM calls — it
 * is a pure read of already-extracted structured facets.
 *
 * Keying note: `signal_facets` rows are keyed by
 *   (source_table = MemorySourceKind, source_id = memory_sources.id)
 * NOT by the raw scraper-table ids the collectors query. Because there is no
 * stable per-item join from a collector row to a facet row, we DO NOT attempt a
 * row-level join. Instead we aggregate facets by their MemorySourceKind and
 * surface the distribution as context — a directional signal of what problem
 * types / audiences / jobs-to-be-done the underlying corpus is talking about.
 *
 * Everything here degrades gracefully: any failure returns an empty string so
 * the collector's existing behaviour is unchanged.
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";

const log = createLogger("pipeline:collector-facets");

/** How many top values to surface per facet dimension. */
const TOP_N = 8;

/** Minimum occurrences for a value to be worth surfacing (noise floor). */
const MIN_COUNT = 2;

/**
 * MemorySourceKind groups relevant to each collector. The collectors query raw
 * scraper tables; facets are keyed by MemorySourceKind, so we map a collector to
 * the set of kinds whose facets are the most relevant context for it.
 */
export const REVIEW_FACET_KINDS: readonly string[] = [
  "appstore_review",
  "playstore_review",
];

export const CAPABILITY_FACET_KINDS: readonly string[] = [
  "producthunt_product",
  "hackernews_story",
  "github_repo",
  "reddit_post",
  "x_post",
  "reuters_news",
  "cointelegraph_news",
  "cryptopanic_news",
  "investingnews_news",
];

export const LANDSCAPE_FACET_KINDS: readonly string[] = [
  "appstore_app",
  "playstore_app",
  "appstore_review",
  "playstore_review",
];

interface FacetValueCount {
  readonly value: string;
  readonly count: number;
}

interface FacetAggregate {
  readonly total: number;
  readonly problemTypes: readonly FacetValueCount[];
  readonly targetAudiences: readonly FacetValueCount[];
  readonly jtbd: readonly FacetValueCount[];
  readonly sentiments: readonly FacetValueCount[];
}

const EMPTY_AGGREGATE: FacetAggregate = {
  total: 0,
  problemTypes: [],
  targetAudiences: [],
  jtbd: [],
  sentiments: [],
};

/** Tally a column's non-null values into a sorted, thresholded distribution. */
function tally(
  rows: readonly Record<string, unknown>[],
  column: string,
  applyFloor: boolean,
): readonly FacetValueCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = row[column];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => (applyFloor ? count >= MIN_COUNT : true))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([value, count]) => ({ value, count }));
}

/**
 * Read + aggregate `signal_facets` for the given MemorySourceKinds.
 *
 * Never throws — returns an empty aggregate on any failure so callers can fold
 * the (possibly empty) result into context unconditionally.
 */
export async function aggregateFacets(
  kinds: readonly string[],
): Promise<FacetAggregate> {
  if (kinds.length === 0) return EMPTY_AGGREGATE;

  try {
    const db = getDb();
    const rows = (await db`
      SELECT problem_type, target_audience, jtbd, sentiment
      FROM signal_facets
      WHERE source_table = ANY(${kinds as string[]})
    `) as Array<Record<string, unknown>>;

    if (rows.length === 0) return EMPTY_AGGREGATE;

    return {
      total: rows.length,
      problemTypes: tally(rows, "problem_type", true),
      targetAudiences: tally(rows, "target_audience", true),
      jtbd: tally(rows, "jtbd", true),
      // Sentiment is a tiny enum — no noise floor.
      sentiments: tally(rows, "sentiment", false),
    };
  } catch (err) {
    log.warn("Facet aggregation failed; continuing without facet context", {
      err,
    });
    return EMPTY_AGGREGATE;
  }
}

/** Render one facet dimension as a compact `value (n)` list. */
function renderDimension(
  label: string,
  values: readonly FacetValueCount[],
): string | null {
  if (values.length === 0) return null;
  const body = values.map((v) => `${v.value} (${v.count})`).join(", ");
  return `  ${label}: ${body}`;
}

/**
 * Format an aggregate into a self-contained context block. Returns an empty
 * string when there is nothing meaningful to surface, so it can be appended
 * unconditionally without altering prompt shape.
 */
export function formatFacetAggregate(
  heading: string,
  aggregate: FacetAggregate,
): string {
  if (aggregate.total === 0) return "";

  const dims = [
    renderDimension("Problem types", aggregate.problemTypes),
    renderDimension("Target audiences", aggregate.targetAudiences),
    renderDimension("Jobs-to-be-done", aggregate.jtbd),
    renderDimension("Sentiment mix", aggregate.sentiments),
  ].filter((line): line is string => line !== null);

  if (dims.length === 0) return "";

  return [
    `\n=== ${heading} (structured facets over ${aggregate.total} signals) ===`,
    ...dims,
  ].join("\n");
}

/**
 * Convenience: aggregate + format in one step for a collector. Returns "" on any
 * failure or when there are no facets to surface (fully graceful).
 */
export async function buildFacetContext(
  heading: string,
  kinds: readonly string[],
): Promise<string> {
  const aggregate = await aggregateFacets(kinds);
  return formatFacetAggregate(heading, aggregate);
}
