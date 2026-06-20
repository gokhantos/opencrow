/**
 * Trend-intersection data collectors.
 *
 * Three focused collectors that use our FULL app store data:
 * 1. analyzeAppLandscape() — what apps exist, what they do, where satisfaction is lowest
 * 2. clusterPainPoints() — what's broken + what people love (both negative AND positive reviews)
 * 3. scanCapabilities() — what new tech/shifts enable solutions (PH/HN/GitHub/Reddit/News/X)
 *
 * Each collector runs a single LLM pass after data collection to extract structured
 * insights. If insight extraction fails the raw data is returned without insights
 * (graceful degradation).
 */

import { getDb } from "../../store/db";
import type { ModelProvider } from "../../store/model-routing";
import { createLogger } from "../../logger";
import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import { loadConfig } from "../../config/loader";
import { sourceCredibility } from "../../sources/shared/source-credibility";
import {
  resolveEntities,
  type EntityRow,
} from "../../sources/shared/entity-resolution";
import { sanitizeForPrompt } from "./synthesizer";
import {
  buildFacetContext,
  REVIEW_FACET_KINDS,
  CAPABILITY_FACET_KINDS,
  LANDSCAPE_FACET_KINDS,
} from "./collector-facets";
import {
  toNumber,
  normalizeVelocities,
  recencyFactor,
  computeRankScore,
  obscurityFromEngagement,
  selectRanked,
  selectStratified,
  lookupLearnedCredibility,
  parseMakers,
  parseTopics,
  parseTopComments,
} from "./collector-ranking";
import {
  loadIncumbentNames,
  mentionsIncumbent,
  INCUMBENT_DOWNRANK_FACTOR,
} from "./incumbents";
import { buildPainSeedSummary, isEchoChamberSignal } from "./collector-focus";
import type {
  TrendData,
  CategoryTrend,
  CategoryStat,
  ClusteredPains,
  PainCluster,
  CapabilityScan,
  Capability,
  LandscapeInsight,
  ReviewInsight,
  CapabilityInsight,
} from "./types";

// Re-export the pure ranking/promotion helpers so consumers (and the existing
// unit tests) can keep importing them from "./collectors".
export {
  clamp01,
  toNumber,
  normalizeVelocities,
  recencyFactor,
  computeRankScore,
  learnedCredibilityMultiplier,
  lookupLearnedCredibility,
  NEUTRAL_LEARNED_CREDIBILITY,
  selectRanked,
  selectStratified,
  parseJsonArray,
  parseMakers,
  parseTopics,
  parseTopComments,
  type RankInputs,
} from "./collector-ranking";

const log = createLogger("pipeline:collectors");

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ── Layer A — long-tail fetch window ─────────────────────────────────────────
//
// Instead of fetching ONLY the top-50-by-engagement (which biases the pool
// toward viral / incumbent signals), each capability source now fetches a TOP
// slice (by velocity/engagement) PLUS a MID-TIER fresh window (lower-ranked but
// recently-fresh rows) so an underserved long-tail signal can surface. The niche
// bonus in computeRankScore then lets a sharp low-engagement signal out-rank a
// viral one. Sizes are named constants; the total fetched is bounded.

/** Top-by-engagement/velocity slice fetched per capability source. */
export const COLLECTOR_TOP_SLICE = 30;
/** Mid-tier fresh-window slice fetched per source (lower-ranked, recent rows). */
export const COLLECTOR_MIDTIER_SLICE = 70;
/** Total rows fetched per source (top slice + mid-tier window). */
export const COLLECTOR_FETCH_LIMIT = COLLECTOR_TOP_SLICE + COLLECTOR_MIDTIER_SLICE;

// ── Collector context for consumed-signal tracking ───────────────────────────

/**
 * Passed into each collector. Provides the set of already-consumed source IDs
 * (per table) and accumulates the IDs selected by this run so pipeline.ts can
 * mark them consumed after the store step.
 */
export interface CollectorContext {
  /** Table name → set of IDs already consumed in prior runs (permanent). */
  readonly consumed: ReadonlyMap<string, ReadonlySet<string>>;
  /** Accumulates: table name → IDs selected by collectors in the current run. */
  readonly selected: Map<string, string[]>;
  /**
   * Learned per-source Beta-Bernoulli posteriors keyed by
   * `credibilityKey(source_table, signal_type, category)` (see
   * {@link import("./credibility").credibilityKey} — `<table>::<signal>::<cat>`).
   * Value = posterior mean in [0, 1] of "this source yields good ideas".
   *
   * OPTIONAL: when absent/empty, collector ranking degrades to the static
   * source-credibility-only behavior (no-op multiplier of 1.0). Populated by
   * pipeline.ts from {@link loadCredibilityPosteriors}.
   */
  readonly credibilityPosteriors?: ReadonlyMap<string, number>;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Shuffle array and return first N. */
function sampleRandom<T>(items: readonly T[], n: number): readonly T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}

/**
 * Filter rows to ONLY unconsumed (fresh) ones. Never reuses consumed sources.
 * Returns up to `target` fresh rows. If zero fresh rows exist, returns empty.
 */
export function excludeConsumed<T>(
  rows: readonly T[],
  consumed: ReadonlySet<string>,
  idExtractor: (row: T) => string,
  target: number,
): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] } {
  const fresh: T[] = [];

  for (const row of rows) {
    const id = idExtractor(row);
    if (!consumed.has(id)) {
      fresh.push(row);
    }
  }

  const selected = fresh.slice(0, target);
  const selectedIds = selected.map(idExtractor);
  return { selected, selectedIds };
}

/**
 * Build the chat options for a collector LLM insight pass. The PROVIDER is
 * threaded from the routed `pipeline.generator` provider so a non-Anthropic
 * route (e.g. alibaba) actually dispatches the collector call to that provider.
 * Defaults to "agent-sdk" — the collectors' historical provider — so callers
 * that omit it keep today's behavior. Exported for unit testing.
 */
export function buildChatOptions(
  model: string,
  provider: ModelProvider = "agent-sdk",
) {
  return {
    systemPrompt: "",
    model,
    provider,
    agentId: "idea-pipeline",
    usageContext: { channel: "pipeline" as const, chatId: "ideas", source: "workflow" as const },
  };
}

function parseJsonFromResponse<T>(text: string, fallback: T): T {
  const jsonMatch =
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ??
    text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);

  if (!jsonMatch?.[1]) return fallback;

  try {
    return JSON.parse(jsonMatch[1].trim()) as T;
  } catch {
    log.warn("Failed to parse LLM insight response as JSON", {
      preview: text.slice(0, 200),
    });
    return fallback;
  }
}

function makeUserMessage(content: string): ConversationMessage {
  return { role: "user", content, timestamp: Date.now() };
}

// ── Step 1: App Landscape Analysis ──────────────────────────────────────────

async function extractLandscapeInsights(
  rawSummary: string,
  model: string,
  provider?: ModelProvider,
): Promise<LandscapeInsight | undefined> {
  const systemPrompt =
    "You are a market analyst. Extract structured insights from app store data. Return only valid JSON.";

  const userContent = `Analyze this app store landscape data and return a JSON object with exactly these keys:

{
  "underservedSegments": [5-7 items, each: { "category": string, "gap": string, "evidence": string }],
  "workingPatterns": [5 items, each: { "pattern": string, "evidence": string, "categories": string[] }],
  "whiteSpaces": [3-5 items, each: { "description": string, "adjacentCategories": string[], "reason": string }]
}

underservedSegments: categories with high complaint ratios or low ratings — what specific user need is unmet?
workingPatterns: features or product patterns that users consistently love across multiple apps.
whiteSpaces: combinations of app categories or feature sets that do not currently exist but would be useful.

APP STORE DATA:
${sanitizeForPrompt(rawSummary).slice(0, 60000)}`;

  const messages: readonly ConversationMessage[] = [makeUserMessage(userContent)];

  try {
    const response = await chat(messages, { ...buildChatOptions(model, provider), systemPrompt });
    return parseJsonFromResponse<LandscapeInsight | undefined>(response.text, undefined);
  } catch (err) {
    log.warn("Landscape insight extraction failed", { err });
    return undefined;
  }
}

/**
 * Analyze the FULL app landscape:
 * - Category satisfaction scores (avg rating from reviews)
 * - What existing apps offer (descriptions = feature landscape)
 * - Which categories are underserved (low satisfaction + many apps = opportunity)
 */
export async function analyzeAppLandscape(
  model?: string,
  _ctx?: CollectorContext,
  provider?: ModelProvider,
): Promise<TrendData> {
  const db = getDb();
  const resolvedModel = model ?? DEFAULT_MODEL;
  const resolvedProvider = provider ?? "agent-sdk";
  const summaryLines: string[] = [];

  // B7 — accumulate selected IDs into a local map; return them in the result
  // so pipeline.ts can merge them after runStep (survives cache-replay path).
  // ctx is no longer mutated; _ctx is kept in the signature for API stability.
  const localSelected = new Map<string, string[]>();
  const registerSelected = (table: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const existing = localSelected.get(table) ?? [];
    localSelected.set(table, [...existing, ...ids]);
  };

  try {
    // Category health: satisfaction scores from reviews
    const categoryHealth = (await db`
      SELECT a.category,
        COUNT(DISTINCT a.id) as app_count,
        COUNT(r.id) as review_count,
        ROUND(AVG(r.rating)::numeric, 1) as avg_rating,
        COUNT(CASE WHEN r.rating <= 2 THEN 1 END) as negative_reviews,
        COUNT(CASE WHEN r.rating >= 4 THEN 1 END) as positive_reviews
      FROM appstore_apps a
      LEFT JOIN appstore_reviews r ON r.app_id = a.id
      WHERE a.category IS NOT NULL AND a.category != ''
      GROUP BY a.category
      HAVING COUNT(r.id) >= 10
      ORDER BY AVG(r.rating) ASC
    `) as Array<Record<string, unknown>>;

    // Same for Play Store
    const playCategoryHealth = (await db`
      SELECT a.category,
        COUNT(DISTINCT a.id) as app_count,
        COUNT(r.id) as review_count,
        ROUND(AVG(r.rating)::numeric, 1) as avg_rating,
        COUNT(CASE WHEN r.rating <= 2 THEN 1 END) as negative_reviews,
        COUNT(CASE WHEN r.rating >= 4 THEN 1 END) as positive_reviews
      FROM playstore_apps a
      LEFT JOIN playstore_reviews r ON r.app_id = a.id
      WHERE a.category IS NOT NULL AND a.category != ''
      GROUP BY a.category
      HAVING COUNT(r.id) >= 10
      ORDER BY AVG(r.rating) ASC
    `) as Array<Record<string, unknown>>;

    summaryLines.push("=== CATEGORY SATISFACTION SCORES (lowest = most opportunity) ===");
    summaryLines.push("iOS App Store:");
    for (const c of categoryHealth) {
      const ratio = Number(c.negative_reviews) / Math.max(Number(c.positive_reviews), 1);
      summaryLines.push(
        `  ${c.category}: ${c.avg_rating}/5 avg (${c.app_count} apps, ${c.review_count} reviews, ${c.negative_reviews} negative, complaint ratio: ${ratio.toFixed(1)})`,
      );
    }
    if (playCategoryHealth.length > 0) {
      summaryLines.push("Google Play Store:");
      for (const c of playCategoryHealth) {
        const ratio = Number(c.negative_reviews) / Math.max(Number(c.positive_reviews), 1);
        summaryLines.push(
          `  ${c.category}: ${c.avg_rating}/5 avg (${c.app_count} apps, ${c.review_count} reviews, complaint ratio: ${ratio.toFixed(1)})`,
        );
      }
    }

    // ── Rank-velocity momentum: which apps are CLIMBING the charts fastest ──
    // Compute per-app rank delta from appstore_ranking_history (earlier→latest
    // snapshot within the window). A negative delta = rank number falling =
    // the app is RISING. Surfaced as a momentum signal for the analyst.
    try {
      const rankMomentum = (await db`
        WITH ranked AS (
          SELECT app_id, list_type, rank, scraped_at,
                 ROW_NUMBER() OVER (PARTITION BY app_id, list_type ORDER BY scraped_at DESC) AS rn_new,
                 ROW_NUMBER() OVER (PARTITION BY app_id, list_type ORDER BY scraped_at ASC) AS rn_old
          FROM appstore_ranking_history
          WHERE scraped_at >= ${Math.floor(Date.now() / 1000) - 14 * 24 * 3600}
        ),
        latest AS (SELECT app_id, list_type, rank AS new_rank FROM ranked WHERE rn_new = 1),
        earliest AS (SELECT app_id, list_type, rank AS old_rank FROM ranked WHERE rn_old = 1)
        SELECT a.name, a.category, l.list_type, e.old_rank, l.new_rank,
               (e.old_rank - l.new_rank) AS rank_gain
        FROM latest l
        JOIN earliest e ON e.app_id = l.app_id AND e.list_type = l.list_type
        JOIN appstore_apps a ON a.id = l.app_id
        WHERE e.old_rank IS NOT NULL AND l.new_rank IS NOT NULL
          AND (e.old_rank - l.new_rank) > 0
        ORDER BY (e.old_rank - l.new_rank) DESC
        LIMIT 25
      `) as Array<Record<string, unknown>>;

      if (rankMomentum.length > 0) {
        summaryLines.push("\n=== FASTEST-CLIMBING APPS (chart rank momentum, last 14d) ===");
        for (const m of rankMomentum) {
          summaryLines.push(
            `  ${m.name} (${m.category}, ${m.list_type}): #${m.old_rank} → #${m.new_rank} (+${m.rank_gain} positions)`,
          );
        }
      }
    } catch (err) {
      log.warn("App rank-velocity momentum query failed; continuing", { err });
    }

    // What existing top apps offer — random sample of app descriptions
    // This tells the AI WHAT THE MARKET PROVIDES so it can find GAPS
    const allApps = (await db`
      SELECT id, name, category, LEFT(description, 400) as description
      FROM appstore_apps
      WHERE description IS NOT NULL AND description != '' AND LENGTH(description) > 100
      ORDER BY updated_at DESC
      LIMIT 200
    `) as Array<Record<string, unknown>>;

    const sampledApps = sampleRandom(allApps, 40);

    // Track which app rows fed this landscape pass so pipeline.ts can bind
    // provenance / chain-of-evidence to them (best-effort; ids may be absent).
    registerSelected(
      "appstore_apps",
      sampledApps.map((a) => a.id as string).filter((id): id is string => Boolean(id)),
    );

    // Group sampled apps by category
    const appsByCategory = new Map<string, Array<Record<string, unknown>>>();
    for (const app of sampledApps) {
      const cat = app.category as string;
      const list = appsByCategory.get(cat) ?? [];
      list.push(app);
      appsByCategory.set(cat, list);
    }

    summaryLines.push("\n=== WHAT EXISTING APPS OFFER (sampled descriptions — find what's MISSING) ===");
    for (const [category, apps] of appsByCategory) {
      summaryLines.push(`\n${category}:`);
      for (const app of apps) {
        // B6 — sanitize scraped app name + description at the per-field level
        // before they enter the summary that will be interpolated into the LLM prompt.
        const safeName = sanitizeForPrompt(app.name as string);
        const safeDesc = sanitizeForPrompt((app.description as string).replace(/\n/g, " ").slice(0, 300));
        summaryLines.push(`  ${safeName}: ${safeDesc}`);
      }
    }

    // Play Store apps with install data
    const playApps = (await db`
      SELECT id, name, category, installs, rating, LEFT(description, 300) as description
      FROM playstore_apps
      WHERE description IS NOT NULL AND description != '' AND category != ''
      ORDER BY updated_at DESC
      LIMIT 100
    `) as Array<Record<string, unknown>>;

    const sampledPlayApps = sampleRandom(playApps, 20);
    registerSelected(
      "playstore_apps",
      sampledPlayApps.map((a) => a.id as string).filter((id): id is string => Boolean(id)),
    );
    if (sampledPlayApps.length > 0) {
      summaryLines.push("\n=== PLAY STORE APPS (with install counts) ===");
      for (const app of sampledPlayApps) {
        // B6 — sanitize scraped Play Store app name + description at the per-field
        // level before they enter the summary interpolated into the LLM prompt.
        const safeName = sanitizeForPrompt(app.name as string);
        const safeDesc = sanitizeForPrompt((app.description as string).replace(/\n/g, " ").slice(0, 200));
        summaryLines.push(`  ${safeName} (${app.category}, ${app.installs} installs, ${app.rating}/5): ${safeDesc}`);
      }
    }

    // Build category trends from satisfaction data
    const trendingCategories: CategoryTrend[] = categoryHealth
      .filter((c) => Number(c.avg_rating) <= 3.5)
      .map((c) => ({
        category: c.category as string,
        store: "appstore" as const,
        newEntrants: Number(c.app_count),
        avgRankChange: 5 - Number(c.avg_rating), // higher = more opportunity
        topApps: [],
      }));

    // Seed-diversity lever 1: per-category satisfaction stats over the FULL iOS +
    // Play distribution (not just the <=3.5 trending slice). selectFocusCategories
    // ranks the high-opportunity head on these and rotates the tail per run.
    const categoryStats: CategoryStat[] = [...categoryHealth, ...playCategoryHealth]
      .map((c) => ({
        category: c.category as string,
        avgRating: Number(c.avg_rating),
        complaintRatio: Number(c.negative_reviews) / Math.max(Number(c.positive_reviews), 1),
      }))
      .filter((s) => s.category && Number.isFinite(s.avgRating));

    // Structured-facet enrichment (gated; DEFAULT OFF, graceful no-op otherwise).
    if (loadConfig().pipelines.ideas.smart.signalFacets) {
      const facetBlock = await buildFacetContext(
        "APP LANDSCAPE — INGESTED SIGNAL FACETS",
        LANDSCAPE_FACET_KINDS,
      );
      if (facetBlock) summaryLines.push(facetBlock);
    }

    log.info("App landscape analysis complete", {
      iosCategories: categoryHealth.length,
      playCategories: playCategoryHealth.length,
      sampledApps: sampledApps.length + sampledPlayApps.length,
    });

    // LLM insight extraction (graceful degradation on failure)
    const insights = await extractLandscapeInsights(
      summaryLines.join("\n"),
      resolvedModel,
      resolvedProvider,
    );

    return {
      risingApps: [],
      trendingCategories,
      categoryStats,
      summary: summaryLines.join("\n"),
      insights,
      selectedIds: new Map(localSelected) as ReadonlyMap<string, readonly string[]>,
    };
  } catch (err) {
    log.warn("App landscape analysis failed", { err });
    return { risingApps: [], trendingCategories: [], summary: "App landscape data unavailable." };
  }
}

// ── Step 2: Pain Point Clustering (negative AND positive reviews) ────────────

async function extractReviewInsights(
  rawSummary: string,
  model: string,
  provider?: ModelProvider,
): Promise<ReviewInsight | undefined> {
  const systemPrompt =
    "You are a UX researcher. Extract structured insights from user reviews. Return only valid JSON.";

  const userContent = `Analyze these user reviews from multiple app categories and return a JSON object with exactly these keys:

{
  "painThemes": [15-25 items, each: {
    "name": string,
    "description": string,
    "frequency": "very_common" | "common" | "emerging",
    "affectedApps": string[],
    "sampleQuotes": string[] (2-3 direct quotes from reviews)
  }],
  "workaroundSignals": [5-10 items, each: {
    "description": string,
    "currentSolution": string,
    "evidence": string
  }],
  "loveSignals": [10-15 items, each: {
    "feature": string,
    "whyUsersLoveIt": string,
    "category": string
  }]
}

painThemes: recurring problems that cut across multiple apps/categories — name them conceptually, not by app.
workaroundSignals: users describing manual workarounds, switching tools, or DIY solutions to fill gaps.
loveSignals: specific features or experiences that users explicitly praise or say they cannot live without.

USER REVIEW DATA:
${rawSummary.slice(0, 60000)}`;

  const messages: readonly ConversationMessage[] = [makeUserMessage(userContent)];

  try {
    const response = await chat(messages, { ...buildChatOptions(model, provider), systemPrompt });
    return parseJsonFromResponse<ReviewInsight | undefined>(response.text, undefined);
  } catch (err) {
    log.warn("Review insight extraction failed", { err });
    return undefined;
  }
}

/**
 * Cluster reviews by category — both COMPLAINTS (what's broken)
 * and PRAISES (what people love and want more of).
 */
export async function clusterReviews(
  focusCategories?: readonly string[],
  model?: string,
  _ctx?: CollectorContext,
  provider?: ModelProvider,
): Promise<ClusteredPains> {
  const db = getDb();
  const resolvedModel = model ?? DEFAULT_MODEL;
  const resolvedProvider = provider ?? "agent-sdk";
  const clusters: PainCluster[] = [];

  // Layer C: load the incumbent set so complaints ABOUT a top-N giant (which a
  // small builder cannot out-execute) are HARD-DROPPED from the pain clusters.
  const incumbentCfg = loadConfig().pipelines.ideas.smart.incumbentExclusion;
  const incumbentSet = incumbentCfg.enabled
    ? await loadIncumbentNames(db, incumbentCfg.topN)
    : new Set<string>();
  const isIncumbentReview = (r: Record<string, unknown>): boolean =>
    incumbentSet.size > 0 &&
    mentionsIncumbent((r.app_name as string | undefined) ?? null, incumbentSet);

  // B7 — accumulate selected IDs locally; return in result instead of
  // mutating the shared ctx.selected Map. _ctx is kept in the signature for
  // API stability; clusterReviews does not use ctx.consumed (reviews are not
  // de-duplicated by consumption ledger).
  const localSelected = new Map<string, string[]>();
  const registerSelected = (table: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const existing = localSelected.get(table) ?? [];
    localSelected.set(table, [...existing, ...ids]);
  };

  try {
    // NEGATIVE reviews — what's broken
    const negativeReviews = focusCategories?.length
      ? (await db`
          SELECT r.id, a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating <= 2 AND a.category IN ${db(focusCategories as string[])}
          ORDER BY r.first_seen_at DESC LIMIT 400
        `) as Array<Record<string, unknown>>
      : (await db`
          SELECT r.id, a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating <= 2
          ORDER BY r.first_seen_at DESC LIMIT 400
        `) as Array<Record<string, unknown>>;

    // POSITIVE reviews — what people love
    const positiveReviews = focusCategories?.length
      ? (await db`
          SELECT r.id, a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating >= 4 AND LENGTH(r.content) > 30 AND a.category IN ${db(focusCategories as string[])}
          ORDER BY r.first_seen_at DESC LIMIT 200
        `) as Array<Record<string, unknown>>
      : (await db`
          SELECT r.id, a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating >= 4 AND LENGTH(r.content) > 30
          ORDER BY r.first_seen_at DESC LIMIT 200
        `) as Array<Record<string, unknown>>;

    // Play Store negative + positive
    const playNegative = (await db`
      SELECT r.id, a.category, a.name as app_name, r.title, r.content, r.rating
      FROM playstore_reviews r
      JOIN playstore_apps a ON a.id = r.app_id
      WHERE r.rating <= 2 AND a.category != ''
      ORDER BY r.first_seen_at DESC LIMIT 400
    `) as Array<Record<string, unknown>>;

    const playPositive = (await db`
      SELECT r.id, a.category, a.name as app_name, r.title, r.content, r.rating
      FROM playstore_reviews r
      JOIN playstore_apps a ON a.id = r.app_id
      WHERE r.rating >= 4 AND LENGTH(r.content) > 30 AND a.category != ''
      ORDER BY r.first_seen_at DESC LIMIT 200
    `) as Array<Record<string, unknown>>;

    // Group by category
    const byCat = new Map<string, { negative: Array<Record<string, unknown>>; positive: Array<Record<string, unknown>> }>();

    // Tag each row with its origin table so selected review ids can be
    // registered for provenance / chain-of-evidence binding in pipeline.ts.
    const tag = (
      rows: readonly Record<string, unknown>[],
      table: string,
    ): Array<Record<string, unknown>> => rows.map((r) => ({ ...r, __table: table }));

    // Layer C: HARD-DROP reviews about a top-N incumbent (complaints about giants
    // a small builder cannot out-execute) before they cluster into pain themes.
    let droppedIncumbentReviews = 0;
    const keepReview = (r: Record<string, unknown>): boolean => {
      if (isIncumbentReview(r)) {
        droppedIncumbentReviews++;
        return false;
      }
      return true;
    };

    for (const r of [
      ...tag(sampleRandom(negativeReviews, 150), "appstore_reviews"),
      ...tag(sampleRandom(playNegative, 150), "playstore_reviews"),
    ]) {
      if (!keepReview(r)) continue;
      const cat = r.category as string;
      if (!cat) continue;
      const entry = byCat.get(cat) ?? { negative: [], positive: [] };
      entry.negative.push(r);
      byCat.set(cat, entry);
    }
    for (const r of [
      ...tag(sampleRandom(positiveReviews, 80), "appstore_reviews"),
      ...tag(sampleRandom(playPositive, 80), "playstore_reviews"),
    ]) {
      if (!keepReview(r)) continue;
      const cat = r.category as string;
      if (!cat) continue;
      const entry = byCat.get(cat) ?? { negative: [], positive: [] };
      entry.positive.push(r);
      byCat.set(cat, entry);
    }

    if (droppedIncumbentReviews > 0) {
      log.info("Layer C: dropped incumbent-named reviews from pain clusters", {
        dropped: droppedIncumbentReviews,
      });
    }

    // Collect review ids that survive into prompt-feeding clusters, per table.
    const selectedReviewIds = new Map<string, string[]>();
    const noteReview = (r: Record<string, unknown>): void => {
      const table = r.__table as string | undefined;
      const id = r.id as string | undefined;
      if (!table || !id) return;
      const list = selectedReviewIds.get(table) ?? [];
      list.push(id);
      selectedReviewIds.set(table, list);
    };

    for (const [category, reviews] of byCat) {
      if (reviews.negative.length < 3 && reviews.positive.length < 3) continue;

      for (const r of reviews.negative) noteReview(r);
      for (const r of reviews.positive) noteReview(r);

      const negApps = [...new Set(reviews.negative.map((r) => r.app_name as string))];
      // B6 — sanitize attacker-controllable review content before it reaches
      // the LLM prompt. sanitizeForPrompt strips prompt-injection patterns
      // (role tags, "ignore previous instructions"). The content is also
      // delimited as a fenced DATA block so the model treats it as data, not
      // as additional instructions.
      const negSamples = reviews.negative
        .slice(0, 6)
        .map(
          (r) =>
            `[${r.rating}/5] "${sanitizeForPrompt(r.app_name as string)}":\n<<<review\n${sanitizeForPrompt((r.content as string).slice(0, 150))}\n>>>`,
        );

      const posSamples = reviews.positive
        .slice(0, 4)
        .map(
          (r) =>
            `[${r.rating}/5] "${sanitizeForPrompt(r.app_name as string)}":\n<<<review\n${sanitizeForPrompt((r.content as string).slice(0, 150))}\n>>>`,
        );

      clusters.push({
        category,
        theme: category,
        complaintCount: reviews.negative.length,
        sampleComplaints: [...negSamples, "--- WHAT USERS LOVE ---", ...posSamples],
        affectedApps: negApps.slice(0, 5),
      });
    }

    clusters.sort((a, b) => b.complaintCount - a.complaintCount);

    for (const [table, ids] of selectedReviewIds) {
      registerSelected(table, [...new Set(ids)]);
    }
  } catch (err) {
    log.warn("Review clustering failed", { err });
  }

  const summaryLines = clusters.slice(0, 12).map((c) => {
    return [
      `=== ${c.category.toUpperCase()} (${c.complaintCount} complaints, ${c.affectedApps.length} apps) ===`,
      `Affected apps: ${c.affectedApps.join(", ")}`,
      ...c.sampleComplaints.map((s) => `  ${s}`),
    ].join("\n");
  });

  // Structured-facet enrichment (gated; DEFAULT OFF, graceful no-op otherwise).
  let facetBlock = "";
  if (loadConfig().pipelines.ideas.smart.signalFacets) {
    facetBlock = await buildFacetContext(
      "USER REVIEWS — INGESTED SIGNAL FACETS",
      REVIEW_FACET_KINDS,
    );
  }

  log.info("Review clustering complete", { clusters: clusters.length });

  const summaryText = facetBlock
    ? [...summaryLines, facetBlock].join("\n\n")
    : summaryLines.join("\n\n");

  // LLM insight extraction (graceful degradation on failure)
  const insights = await extractReviewInsights(summaryText, resolvedModel, resolvedProvider);

  // Seed-diversity lever 2: lead pains.summary with the SPECIFIC LLM-extracted
  // pain themes so the generator's Pass-1 (which consumes pains.summary directly)
  // seeds on concrete recurring complaints, not the "=== BUSINESS (340
  // complaints) ===" category headers that dominate the cluster aggregate.
  // The category aggregate is demoted to clearly-labeled BACKGROUND context.
  // SECURITY: buildPainSeedSummary does NO sanitization — every scraped field
  // (theme name/description, affected-app names) is sanitizeForPrompt'd HERE
  // before it reaches the helper / the prompt.
  const seedDiversity = loadConfig().pipelines.ideas.smart.seedDiversity;
  let summary = summaryText;
  if (
    seedDiversity.enabled &&
    seedDiversity.painThemesLeadSummary &&
    insights?.painThemes?.length
  ) {
    const safeThemes = insights.painThemes.map((t) => ({
      name: sanitizeForPrompt(t.name),
      description: sanitizeForPrompt(t.description),
      frequency: t.frequency,
      affectedApps: t.affectedApps.map((a) => sanitizeForPrompt(a)),
    }));
    summary = buildPainSeedSummary(safeThemes, summaryText, seedDiversity.maxLeadingPainThemes);
    log.info("Seed-diversity lever 2: specific pain themes lead pains.summary", {
      themes: safeThemes.length,
      maxLeading: seedDiversity.maxLeadingPainThemes,
    });
  }

  return {
    clusters: clusters.slice(0, 15),
    summary,
    insights,
    selectedIds: new Map(localSelected) as ReadonlyMap<string, readonly string[]>,
  };
}

// ── Step 3: Capability Scan ──────────────────────────────────────────────────

async function extractCapabilityInsights(
  capabilities: readonly import("./types").Capability[],
  model: string,
  provider?: ModelProvider,
): Promise<CapabilityInsight | undefined> {
  const lines: string[] = [];
  for (const c of capabilities) {
    // B6 — sanitize scraped capability title + description at the per-field level
    // before they are joined into the raw text interpolated into the LLM prompt.
    const safeTitle = sanitizeForPrompt(c.title);
    const safeDesc = sanitizeForPrompt(c.description);
    lines.push(`[${c.source.toUpperCase()}] ${safeTitle}\n  ${safeDesc}`);
  }
  const rawText = lines.join("\n");

  const systemPrompt =
    "You are a technology analyst. Classify capabilities and find connections to user pain areas. Return only valid JSON.";

  const userContent = `Analyze these technology signals and return a JSON object with exactly these keys:

{
  "genuinelyNew": [items, each: {
    "title": string (exact title from input),
    "source": string (exact source from input),
    "classification": "breakthrough" | "enabler" | "incremental",
    "whyNew": string (1-2 sentences)
  }],
  "technologyWaves": [3-6 items, each: {
    "name": string (descriptive wave name),
    "capabilities": string[] (titles of capabilities in this wave),
    "implication": string (what this wave enables builders to create)
  }],
  "painCapabilityLinks": [10-20 items, each: {
    "painTheme": string (a user pain area, e.g. "complex onboarding", "poor sync"),
    "capability": string (capability title that could address it),
    "connectionReason": string (how this capability solves the pain)
  }]
}

genuinelyNew: classify EVERY item — breakthrough = category-defining, enabler = unlocks new product types, incremental = better version of existing.
technologyWaves: group capabilities by the underlying technology shift they represent.
painCapabilityLinks: cross-reference capabilities with common mobile app pain points — imagine which user frustrations each capability could finally solve.

CAPABILITY DATA:
${sanitizeForPrompt(rawText).slice(0, 50000)}`;

  const messages: readonly ConversationMessage[] = [makeUserMessage(userContent)];

  try {
    const response = await chat(messages, { ...buildChatOptions(model, provider), systemPrompt });
    return parseJsonFromResponse<CapabilityInsight | undefined>(response.text, undefined);
  } catch (err) {
    log.warn("Capability insight extraction failed", { err });
    return undefined;
  }
}

/**
 * A fresh (unconsumed) source row enriched with the signals needed for ranking,
 * plus a builder that produces the final {@link Capability}. Kept internal so
 * each source's native field mapping lives next to its query.
 */
interface RawCandidate {
  readonly table: string;
  readonly id: string;
  readonly entity: EntityRow;
  /**
   * Sub-source granularity (e.g. "feed", "front-page", "trending", a news
   * domain, a subreddit tier). Used as the `signal_type` component when looking
   * up the learned-credibility posterior for this row.
   */
  readonly signalType: string;
  /**
   * Category component for the learned-credibility lookup. Capability signals
   * are not pre-categorized, so this is "unknown" — the lookup falls back across
   * looser keys (see {@link lookupLearnedCredibility}).
   */
  readonly category: string;
  /** Source-credibility weight in [0, 1]. */
  readonly credibility: number;
  /** Raw velocity (per-scrape momentum) before normalization. */
  readonly velocity: number;
  /** Raw engagement metric used for credibility. */
  readonly engagement: number;
  /** Recency factor in [0, 1]. */
  readonly recency: number;
  /**
   * Seed-diversity lever 3: signals used to detect AI-builder-meta "echo
   * chamber" candidates (curated meta subreddit + generic agent/LLM-framework
   * phrases in the github full_name / PH topics / title + description). Such
   * candidates are DOWN-WEIGHTED (not dropped) in the rank score. Optional —
   * sources that can't be meta (e.g. news) omit it.
   */
  readonly echoChamber?: {
    readonly subreddit?: string | null;
    readonly tag?: string | null;
    readonly text?: string | null;
  };
  /** Builds the final Capability given the resolved corroboration + velocityNorm. */
  build: (extra: {
    readonly corroborationCount: number;
    readonly velocityNorm: number;
    readonly rankScore: number;
  }) => Capability;
}

export async function scanCapabilities(
  model?: string,
  ctx?: CollectorContext,
  provider?: ModelProvider,
): Promise<CapabilityScan> {
  const db = getDb();
  const resolvedModel = model ?? DEFAULT_MODEL;
  const resolvedProvider = provider ?? "agent-sdk";
  const smart = loadConfig().pipelines.ideas.smart;
  const adaptive = smart.adaptiveCollection;
  const strat = smart.stratifiedIntake;
  const incumbentCfg = smart.incumbentExclusion;
  const nowSec = Math.floor(Date.now() / 1000);

  // Layer C: load the top-N incumbent name set once (empty / no-op when the
  // feature is off or the load fails). Capability signals naming an incumbent are
  // STRONG-down-ranked below so they can't seed the head of the pool.
  const incumbentSet = incumbentCfg.enabled
    ? await loadIncumbentNames(db, incumbentCfg.topN)
    : new Set<string>();

  const capabilities: Capability[] = [];

  // Helper to retrieve the consumed set for a given table (empty set if not provided).
  const consumedFor = (table: string): ReadonlySet<string> =>
    ctx?.consumed.get(table) ?? new Set<string>();

  // B7 — accumulate selected IDs locally; return in result instead of
  // mutating the shared ctx.selected Map.
  const localSelected = new Map<string, string[]>();
  const registerSelected = (table: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const existing = localSelected.get(table) ?? [];
    localSelected.set(table, [...existing, ...ids]);
  };

  // Accumulate per-source fresh candidate pools (before top-K selection) so we
  // can compute cross-source corroboration over the full union, then rank.
  const pools: Array<{ readonly table: string; readonly target: number; readonly candidates: readonly RawCandidate[] }> = [];

  try {
    // ── Product Hunt ──────────────────────────────────────────────────────────
    // Fetch 50 rows so we have enough fresh ones after filtering consumed.
    const cutoff30d = nowSec - 30 * 24 * 3600;
    // Layer A: TOP slice by engagement UNION a MID-TIER fresh window (rows ranked
    // below the top slice, ordered by recency) so the long-tail surfaces. One
    // parameterized query via window functions — no value interpolation into SQL.
    let phRaw = (await db`
      WITH ranked AS (
        SELECT id, name, tagline, description, url, website_url, votes_count, comments_count,
               makers_json, topics_json, first_seen_at,
               ROW_NUMBER() OVER (ORDER BY (votes_count + comments_count * 3) DESC) AS eng_rank
        FROM ph_products
        WHERE first_seen_at >= ${cutoff30d}
      )
      (SELECT id, name, tagline, description, url, website_url, votes_count, comments_count,
              makers_json, topics_json, first_seen_at
       FROM ranked WHERE eng_rank <= ${COLLECTOR_TOP_SLICE})
      UNION
      (SELECT id, name, tagline, description, url, website_url, votes_count, comments_count,
              makers_json, topics_json, first_seen_at
       FROM ranked WHERE eng_rank > ${COLLECTOR_TOP_SLICE}
       ORDER BY first_seen_at DESC LIMIT ${COLLECTOR_MIDTIER_SLICE})
    `) as Array<Record<string, unknown>>;

    // Fallback: all-time with random offset to ensure variation across runs
    if (phRaw.length < 5) {
      phRaw = (await db`
        SELECT id, name, tagline, description, url, website_url, votes_count, comments_count,
               makers_json, topics_json, first_seen_at
        FROM ph_products
        ORDER BY (votes_count + comments_count * 3) DESC
        LIMIT 50
        OFFSET floor(random() * 10)::int
      `) as Array<Record<string, unknown>>;
    }

    pools.push({
      table: "ph_products",
      target: 15,
      candidates: phRaw
        .filter((p) => !consumedFor("ph_products").has(p.id as string))
        .map((p) => {
          const votes = toNumber(p.votes_count);
          const cred = sourceCredibility("producthunt", "feed", { metric: votes });
          const makers = parseMakers(p.makers_json);
          const topics = parseTopics(p.topics_json);
          return {
            table: "ph_products",
            id: p.id as string,
            signalType: "feed",
            category: "unknown",
            entity: {
              id: p.id as string,
              source: "producthunt",
              url: (p.website_url as string) || (p.url as string) || null,
              name: (p.name as string) || null,
            },
            credibility: cred.weight,
            velocity: 0, // ph has no persisted velocity column
            engagement: votes,
            recency: recencyFactor(toNumber(p.first_seen_at), nowSec),
            echoChamber: {
              tag: topics.join(" "),
              text: `${(p.name as string) ?? ""} ${(p.tagline as string) ?? ""} ${(p.description as string) ?? ""}`,
            },
            build: ({ corroborationCount, velocityNorm, rankScore }) => ({
              title: `${p.name}: ${p.tagline}`,
              source: "producthunt",
              url: (p.url as string) || (p.website_url as string) || "",
              description: (p.description as string)?.slice(0, 200) ?? "",
              type: "new_tech" as const,
              credibility: cred.weight,
              engagement: votes,
              corroborationCount,
              velocityNorm,
              rankScore,
              ...(makers.length ? { makers } : {}),
              ...(topics.length ? { topics } : {}),
            }),
          } satisfies RawCandidate;
        }),
    });

    // ── Hacker News ───────────────────────────────────────────────────────────
    const hnRaw = (await db`
      WITH ranked AS (
        SELECT id, title, url, hn_url, points, comment_count, top_comments_json,
               points_velocity, updated_at, feed_type,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(points_velocity, 0) DESC, updated_at DESC, (points + comment_count * 2) DESC
               ) AS eng_rank
        FROM hn_stories
        WHERE updated_at >= ${nowSec - 7 * 24 * 3600}
      )
      (SELECT id, title, url, hn_url, points, comment_count, top_comments_json,
              points_velocity, updated_at, feed_type
       FROM ranked WHERE eng_rank <= ${COLLECTOR_TOP_SLICE})
      UNION
      (SELECT id, title, url, hn_url, points, comment_count, top_comments_json,
              points_velocity, updated_at, feed_type
       FROM ranked WHERE eng_rank > ${COLLECTOR_TOP_SLICE}
       ORDER BY updated_at DESC LIMIT ${COLLECTOR_MIDTIER_SLICE})
    `) as Array<Record<string, unknown>>;

    pools.push({
      table: "hn_stories",
      target: 15,
      candidates: hnRaw
        .filter((s) => !consumedFor("hn_stories").has(s.id as string))
        .map((s) => {
          const points = toNumber(s.points);
          const subSource =
            s.feed_type === "ask" ? "ask" : s.feed_type === "show" ? "show" : "front-page";
          const cred = sourceCredibility("hackernews", subSource, { metric: points });
          const topComments = parseTopComments(s.top_comments_json);
          const vel = toNumber(s.points_velocity);
          return {
            table: "hn_stories",
            id: s.id as string,
            signalType: subSource,
            category: "unknown",
            entity: {
              id: s.id as string,
              source: "hackernews",
              url: (s.url as string) || null,
              name: (s.title as string) || null,
            },
            credibility: cred.weight,
            velocity: vel,
            engagement: points,
            recency: recencyFactor(toNumber(s.updated_at), nowSec),
            echoChamber: { text: (s.title as string) ?? "" },
            build: ({ corroborationCount, velocityNorm, rankScore }) => ({
              title: s.title as string,
              source: "hackernews",
              url: (s.url as string) || (s.hn_url as string) || "",
              description: `${points} points, ${s.comment_count} comments${vel ? `, momentum ${vel.toFixed(1)}/scrape` : ""}`,
              type: "new_tech" as const,
              credibility: cred.weight,
              velocity: vel,
              engagement: points,
              corroborationCount,
              velocityNorm,
              rankScore,
              ...(topComments.length ? { topComments } : {}),
            }),
          } satisfies RawCandidate;
        }),
    });

    // ── GitHub ────────────────────────────────────────────────────────────────
    let reposRaw = (await db`
      WITH ranked AS (
        SELECT id, full_name, description, language, stars, stars_today, url, stars_velocity, updated_at,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(stars_velocity, 0) DESC, stars_today DESC, stars DESC
               ) AS eng_rank
        FROM github_repos
        WHERE stars_today > 0
      )
      (SELECT id, full_name, description, language, stars, stars_today, url, stars_velocity, updated_at
       FROM ranked WHERE eng_rank <= ${COLLECTOR_TOP_SLICE})
      UNION
      (SELECT id, full_name, description, language, stars, stars_today, url, stars_velocity, updated_at
       FROM ranked WHERE eng_rank > ${COLLECTOR_TOP_SLICE}
       ORDER BY updated_at DESC LIMIT ${COLLECTOR_MIDTIER_SLICE})
    `) as Array<Record<string, unknown>>;

    // Fallback: all-time with random offset if no active trending data
    if (reposRaw.length < 5) {
      reposRaw = (await db`
        SELECT id, full_name, description, language, stars, stars_today, url, stars_velocity, updated_at
        FROM github_repos
        ORDER BY stars DESC
        LIMIT 50
        OFFSET floor(random() * 10)::int
      `) as Array<Record<string, unknown>>;
    }

    pools.push({
      table: "github_repos",
      target: 15,
      candidates: reposRaw
        .filter((r) => !consumedFor("github_repos").has(r.id as string))
        .map((r) => {
          const stars = toNumber(r.stars);
          const cred = sourceCredibility("github", "trending", { metric: stars });
          const vel = toNumber(r.stars_velocity);
          return {
            table: "github_repos",
            id: r.id as string,
            signalType: "trending",
            category: "unknown",
            entity: {
              id: r.id as string,
              source: "github",
              fullName: (r.full_name as string) || null,
              url: (r.url as string) || null,
              name: (r.full_name as string) || null,
            },
            credibility: cred.weight,
            velocity: vel,
            engagement: stars,
            recency: recencyFactor(toNumber(r.updated_at), nowSec),
            echoChamber: {
              tag: (r.full_name as string) ?? "",
              text: `${(r.full_name as string) ?? ""} ${(r.description as string) ?? ""}`,
            },
            build: ({ corroborationCount, velocityNorm, rankScore }) => ({
              title: `${r.full_name} (${r.language || "?"})`,
              source: "github",
              url: (r.url as string) || `https://github.com/${r.full_name}`,
              description: `${(r.description as string)?.slice(0, 150) ?? ""} — ${stars} stars (+${r.stars_today} today${vel ? `, velocity ${vel.toFixed(1)}` : ""})`,
              type: "open_source" as const,
              credibility: cred.weight,
              velocity: vel,
              engagement: stars,
              corroborationCount,
              velocityNorm,
              rankScore,
            }),
          } satisfies RawCandidate;
        }),
    });

    // ── Reddit ────────────────────────────────────────────────────────────────
    const postsRaw = (await db`
      WITH ranked AS (
        SELECT id, title, selftext, subreddit, score, num_comments, permalink, url,
               top_comments_json, flair, score_velocity, updated_at,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(score_velocity, 0) DESC, updated_at DESC, (score + num_comments * 3) DESC
               ) AS eng_rank
        FROM reddit_posts
        WHERE updated_at >= ${nowSec - 7 * 24 * 3600}
      )
      (SELECT id, title, selftext, subreddit, score, num_comments, permalink, url,
              top_comments_json, flair, score_velocity, updated_at
       FROM ranked WHERE eng_rank <= ${COLLECTOR_TOP_SLICE})
      UNION
      (SELECT id, title, selftext, subreddit, score, num_comments, permalink, url,
              top_comments_json, flair, score_velocity, updated_at
       FROM ranked WHERE eng_rank > ${COLLECTOR_TOP_SLICE}
       ORDER BY updated_at DESC LIMIT ${COLLECTOR_MIDTIER_SLICE})
    `) as Array<Record<string, unknown>>;

    pools.push({
      table: "reddit_posts",
      target: 10,
      candidates: postsRaw
        .filter((p) => !consumedFor("reddit_posts").has(p.id as string))
        .map((p) => {
          const score = toNumber(p.score);
          const cred = sourceCredibility("reddit", "topical", { metric: score });
          const topComments = parseTopComments(p.top_comments_json);
          const flair = typeof p.flair === "string" && p.flair.trim() ? p.flair.trim() : undefined;
          const vel = toNumber(p.score_velocity);
          return {
            table: "reddit_posts",
            id: p.id as string,
            signalType: "topical",
            category: "unknown",
            entity: {
              id: p.id as string,
              source: "reddit",
              url: (p.url as string) || null,
              name: (p.title as string) || null,
            },
            credibility: cred.weight,
            velocity: vel,
            engagement: score,
            recency: recencyFactor(toNumber(p.updated_at), nowSec),
            echoChamber: {
              subreddit: typeof p.subreddit === "string" ? p.subreddit : null,
              text: `${(p.title as string) ?? ""} ${(p.selftext as string) ?? ""}`,
            },
            build: ({ corroborationCount, velocityNorm, rankScore }) => ({
              title: `r/${p.subreddit}: ${p.title}`,
              source: "reddit",
              url: p.permalink ? `https://reddit.com${p.permalink}` : "",
              description: `${score} pts, ${p.num_comments} comments${flair ? ` [${flair}]` : ""}${vel ? `, momentum ${vel.toFixed(1)}/scrape` : ""}`,
              type: "behavior_shift" as const,
              credibility: cred.weight,
              velocity: vel,
              engagement: score,
              corroborationCount,
              velocityNorm,
              rankScore,
              ...(flair ? { flair } : {}),
              ...(topComments.length ? { topComments } : {}),
            }),
          } satisfies RawCandidate;
        }),
    });

    // ── News ──────────────────────────────────────────────────────────────────
    const cutoff72h = nowSec - 72 * 3600;
    const articlesRaw = (await db`
      SELECT id, title, url, source_name, summary, scraped_at
      FROM news_articles WHERE scraped_at >= ${cutoff72h}
      ORDER BY scraped_at DESC LIMIT 50
    `) as Array<Record<string, unknown>>;

    pools.push({
      table: "news_articles",
      target: 10,
      candidates: articlesRaw
        .filter((a) => !consumedFor("news_articles").has(a.id as string))
        .map((a) => {
          const domain = typeof a.source_name === "string" ? a.source_name.toLowerCase() : "generic";
          const subSource = ["reuters", "bloomberg", "cointelegraph", "cryptopanic"].includes(domain)
            ? domain
            : "generic";
          const cred = sourceCredibility("news", subSource);
          return {
            table: "news_articles",
            id: a.id as string,
            signalType: subSource,
            category: "unknown",
            entity: {
              id: a.id as string,
              source: "news",
              url: (a.url as string) || null,
              name: (a.title as string) || null,
            },
            credibility: cred.weight,
            velocity: 0,
            engagement: 0,
            recency: recencyFactor(toNumber(a.scraped_at), nowSec, 3),
            build: ({ corroborationCount, velocityNorm, rankScore }) => ({
              title: a.title as string,
              source: "news",
              url: (a.url as string) || "",
              description: (a.summary as string)?.slice(0, 150) ?? "",
              type: "behavior_shift" as const,
              credibility: cred.weight,
              corroborationCount,
              velocityNorm,
              rankScore,
            }),
          } satisfies RawCandidate;
        }),
    });

    // ── X / Twitter ───────────────────────────────────────────────────────────
    const tweetsRaw = (await db`
      WITH ranked AS (
        SELECT id, author_username, author_verified, text, likes, retweets, views,
               likes_velocity, scraped_at,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(likes_velocity, 0) DESC, scraped_at DESC
               ) AS eng_rank
        FROM x_scraped_tweets
        WHERE scraped_at >= ${nowSec - 7 * 24 * 3600}
      )
      (SELECT id, author_username, author_verified, text, likes, retweets, views,
              likes_velocity, scraped_at
       FROM ranked WHERE eng_rank <= ${COLLECTOR_TOP_SLICE})
      UNION
      (SELECT id, author_username, author_verified, text, likes, retweets, views,
              likes_velocity, scraped_at
       FROM ranked WHERE eng_rank > ${COLLECTOR_TOP_SLICE}
       ORDER BY scraped_at DESC LIMIT ${COLLECTOR_MIDTIER_SLICE})
    `) as Array<Record<string, unknown>>;

    pools.push({
      table: "x_scraped_tweets",
      target: 10,
      candidates: tweetsRaw
        .filter((t) => !consumedFor("x_scraped_tweets").has(t.id as string))
        .map((t) => {
          const likes = toNumber(t.likes);
          const subSource = t.author_verified ? "verified" : "timeline";
          const cred = sourceCredibility("x", subSource, { metric: likes });
          const vel = toNumber(t.likes_velocity);
          const handle = (t.author_username as string) || "";
          return {
            table: "x_scraped_tweets",
            id: t.id as string,
            signalType: subSource,
            category: "unknown",
            entity: {
              id: t.id as string,
              source: "x",
              handle: handle || null,
              name: (t.text as string)?.slice(0, 80) || null,
            },
            credibility: cred.weight,
            velocity: vel,
            engagement: likes,
            recency: recencyFactor(toNumber(t.scraped_at), nowSec),
            echoChamber: { text: (t.text as string) ?? "" },
            build: ({ corroborationCount, velocityNorm, rankScore }) => ({
              title: `@${handle}`,
              source: "x",
              url: "",
              description: (t.text as string)?.slice(0, 200) ?? "",
              type: "behavior_shift" as const,
              credibility: cred.weight,
              velocity: vel,
              engagement: likes,
              corroborationCount,
              velocityNorm,
              rankScore,
            }),
          } satisfies RawCandidate;
        }),
    });

    // ── Cross-source corroboration over the full fresh union ────────────────
    const allCandidates = pools.flatMap((pool) => pool.candidates);
    let corroborationByRowId: ReadonlyMap<string, number> = new Map();
    try {
      const resolved = await resolveEntities(allCandidates.map((c) => c.entity));
      corroborationByRowId = resolved.corroborationByRowId;
    } catch (err) {
      log.warn("Corroboration resolution failed; continuing without it", { err });
    }

    // Seed-diversity lever 3: down-weight (not drop) AI-builder-meta "echo
    // chamber" signals so the capability pool isn't dominated by "build an AI
    // agent / LLM framework" meta. Mirrors the incumbent down-weight pattern.
    const echoCfg = smart.seedDiversity;
    let echoChamberDownweighted = 0;

    // ── Phase 1: per-source velocity normalization + scoring ────────────────
    // Velocity normalization is per-source by design (each source has its own
    // velocity range). We compute velNorm per-pool and merge into a single map
    // so that the union-level selection pass below can look up any candidate.
    const velNormByRow = new Map<string, number>();
    const scoreByRow = new Map<string, number>();

    for (const pool of pools) {
      const poolVelNorm = normalizeVelocities(
        pool.candidates.map((c) => ({ id: c.id, velocity: c.velocity })),
      );
      for (const [id, norm] of poolVelNorm) {
        velNormByRow.set(id, norm);
      }

      // Score each candidate ONCE (jitter included) so the sort key and the
      // persisted rankScore stay consistent.
      for (const c of pool.candidates) {
        // Learned per-source posterior (optional; neutral no-op when absent).
        const learnedCredibility = lookupLearnedCredibility(
          ctx?.credibilityPosteriors,
          c.table,
          c.signalType,
          c.category,
        );
        let score = computeRankScore({
          credibility: c.credibility,
          velocityNorm: poolVelNorm.get(c.id) ?? 0,
          corroborationCount: corroborationByRowId.get(c.id) ?? 1,
          recency: c.recency,
          // Layer A: inverse-popularity niche bonus from raw engagement.
          obscurity: obscurityFromEngagement(c.engagement),
          learnedCredibility,
        });
        // Layer C: a capability signal whose entity name prominently matches a
        // top-N incumbent is strong-down-ranked (not dropped) so it cannot seed
        // the head of the pool but can still corroborate further down.
        if (incumbentSet.size > 0 && mentionsIncumbent(c.entity.name ?? null, incumbentSet)) {
          score *= INCUMBENT_DOWNRANK_FACTOR;
        }
        // Seed-diversity lever 3: an AI-builder-meta candidate (meta subreddit or
        // generic agent/LLM-framework phrase) is multiplied by echoChamberFactor
        // (default 0.5) — REDUCED, not eliminated, so it drops in rank but can
        // still surface and corroborate.
        if (
          echoCfg.enabled &&
          echoCfg.echoChamberDownweight &&
          c.echoChamber &&
          isEchoChamberSignal(c.echoChamber)
        ) {
          score *= echoCfg.echoChamberFactor;
          echoChamberDownweighted++;
        }
        scoreByRow.set(c.id, score);
      }
    }

    // ── Phase 2: cross-pool stratified selection (or legacy per-pool path) ───
    // STAGE 1 — stratified intake: select across the union of all pool candidates
    // using a single cross-pool pass that caps each `${table}:${signalType}`
    // bucket at `perBucketCap`, so no single source/signalType can dominate.
    // The legacy per-pool path is preserved behind strat.enabled=false.
    const unionCandidates = pools.flatMap((p) => p.candidates);
    const totalTarget = pools.reduce((sum, p) => sum + p.target, 0);

    const chosen = strat.enabled
      ? selectStratified(unionCandidates, {
          idOf: (c) => c.id,
          bucketOf: (c) => `${c.table}:${c.signalType}`,
          scoreOf: (c) => scoreByRow.get(c.id) ?? 0,
          perBucketCap: strat.perBucketCap,
          totalCap: Math.min(strat.totalCap, totalTarget),
        }).selected
      : // Legacy per-pool path preserved for reversibility (strat.enabled=false).
        pools.flatMap(
          (pool) =>
            selectRanked(
              pool.candidates,
              new Set<string>(), // already filtered to fresh above
              (c) => c.id,
              pool.target,
              (c) => scoreByRow.get(c.id) ?? 0,
              adaptive,
            ).selected,
        );

    // Register selected ids per table (preserves the localSelected accounting).
    const byTable = new Map<string, string[]>();
    for (const c of chosen) {
      const list = byTable.get(c.table) ?? [];
      list.push(c.id);
      byTable.set(c.table, list);
    }
    for (const [table, ids] of byTable) {
      registerSelected(table, ids);
    }

    for (const c of chosen) {
      capabilities.push(
        c.build({
          corroborationCount: corroborationByRowId.get(c.id) ?? 1,
          velocityNorm: velNormByRow.get(c.id) ?? 0,
          rankScore: scoreByRow.get(c.id) ?? 0,
        }),
      );
    }

    if (echoChamberDownweighted > 0) {
      log.info("Seed-diversity lever 3: down-weighted AI-builder-meta signals", {
        downweighted: echoChamberDownweighted,
        factor: echoCfg.echoChamberFactor,
      });
    }
  } catch (err) {
    log.warn("Capability scan failed", { err });
  }

  const summaryLines: string[] = [];
  const bySource = new Map<string, Capability[]>();
  for (const c of capabilities) {
    const list = bySource.get(c.source) ?? [];
    list.push(c);
    bySource.set(c.source, list);
  }

  for (const [source, items] of bySource) {
    // Surface aggregate momentum + corroboration per source (annotated line).
    const withVel = items.filter((i) => (i.velocityNorm ?? 0) > 0);
    const avgVel = withVel.length
      ? withVel.reduce((s, i) => s + (i.velocityNorm ?? 0), 0) / withVel.length
      : 0;
    const corroborated = items.filter((i) => (i.corroborationCount ?? 1) > 1).length;
    const momentumNote = avgVel > 0 ? ` — avg momentum ${(avgVel * 100).toFixed(0)}%` : "";
    const corroNote = corroborated > 0 ? `, ${corroborated} cross-source corroborated` : "";
    summaryLines.push(`=== ${source.toUpperCase()} (${items.length} items${momentumNote}${corroNote}) ===`);
    for (const item of items) {
      const tags: string[] = [];
      if (item.topics?.length) tags.push(`topics: ${item.topics.join(", ")}`);
      if (item.makers?.length) tags.push(`makers: ${item.makers.map((m) => m.name).join(", ")}`);
      if (item.flair) tags.push(`flair: ${item.flair}`);
      if ((item.corroborationCount ?? 1) > 1) tags.push(`corroborated by ${item.corroborationCount} sources`);
      const tagLine = tags.length ? `\n    ${tags.join(" | ")}` : "";
      const commentLine = item.topComments?.length
        ? `\n    top: ${item.topComments.map((c) => `"${c.slice(0, 120)}"`).join(" ")}`
        : "";
      summaryLines.push(
        `  ${item.title}${item.url ? `\n    URL: ${item.url}` : ""}\n    ${item.description}${tagLine}${commentLine}`,
      );
    }
  }

  // Structured-facet enrichment (gated; DEFAULT OFF, graceful no-op otherwise).
  if (smart.signalFacets) {
    const facetBlock = await buildFacetContext(
      "TECH/BEHAVIOR SIGNALS — INGESTED SIGNAL FACETS",
      CAPABILITY_FACET_KINDS,
    );
    if (facetBlock) summaryLines.push(facetBlock);
  }

  log.info("Capability scan complete", {
    capabilities: capabilities.length,
    adaptive,
    corroborated: capabilities.filter((c) => (c.corroborationCount ?? 1) > 1).length,
  });

  // LLM insight extraction (graceful degradation on failure)
  const insights = await extractCapabilityInsights(capabilities, resolvedModel, resolvedProvider);

  return {
    capabilities,
    summary: summaryLines.join("\n"),
    insights,
    selectedIds: new Map(localSelected) as ReadonlyMap<string, readonly string[]>,
  };
}
