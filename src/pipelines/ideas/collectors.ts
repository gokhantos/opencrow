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
import { createLogger } from "../../logger";
import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import type {
  TrendData,
  CategoryTrend,
  ClusteredPains,
  PainCluster,
  CapabilityScan,
  Capability,
  LandscapeInsight,
  ReviewInsight,
  CapabilityInsight,
} from "./types";

const log = createLogger("pipeline:collectors");

const DEFAULT_MODEL = "claude-sonnet-4-6";

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

function buildChatOptions(model: string) {
  return {
    systemPrompt: "",
    model,
    provider: "anthropic" as const,
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
${rawSummary.slice(0, 60000)}`;

  const messages: readonly ConversationMessage[] = [makeUserMessage(userContent)];

  try {
    const response = await chat(messages, { ...buildChatOptions(model), systemPrompt });
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
export async function analyzeAppLandscape(model?: string): Promise<TrendData> {
  const db = getDb();
  const resolvedModel = model ?? DEFAULT_MODEL;
  const summaryLines: string[] = [];

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

    // What existing top apps offer — random sample of app descriptions
    // This tells the AI WHAT THE MARKET PROVIDES so it can find GAPS
    const allApps = (await db`
      SELECT name, category, LEFT(description, 400) as description
      FROM appstore_apps
      WHERE description IS NOT NULL AND description != '' AND LENGTH(description) > 100
      ORDER BY updated_at DESC
      LIMIT 200
    `) as Array<Record<string, unknown>>;

    const sampledApps = sampleRandom(allApps, 40);

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
        summaryLines.push(`  ${app.name}: ${(app.description as string).replace(/\n/g, " ").slice(0, 300)}`);
      }
    }

    // Play Store apps with install data
    const playApps = (await db`
      SELECT name, category, installs, rating, LEFT(description, 300) as description
      FROM playstore_apps
      WHERE description IS NOT NULL AND description != '' AND category != ''
      ORDER BY updated_at DESC
      LIMIT 100
    `) as Array<Record<string, unknown>>;

    const sampledPlayApps = sampleRandom(playApps, 20);
    if (sampledPlayApps.length > 0) {
      summaryLines.push("\n=== PLAY STORE APPS (with install counts) ===");
      for (const app of sampledPlayApps) {
        summaryLines.push(`  ${app.name} (${app.category}, ${app.installs} installs, ${app.rating}/5): ${(app.description as string).replace(/\n/g, " ").slice(0, 200)}`);
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

    log.info("App landscape analysis complete", {
      iosCategories: categoryHealth.length,
      playCategories: playCategoryHealth.length,
      sampledApps: sampledApps.length + sampledPlayApps.length,
    });

    // LLM insight extraction (graceful degradation on failure)
    const insights = await extractLandscapeInsights(summaryLines.join("\n"), resolvedModel);

    return {
      risingApps: [],
      trendingCategories,
      summary: summaryLines.join("\n"),
      insights,
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
    const response = await chat(messages, { ...buildChatOptions(model), systemPrompt });
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
): Promise<ClusteredPains> {
  const db = getDb();
  const resolvedModel = model ?? DEFAULT_MODEL;
  const clusters: PainCluster[] = [];

  try {
    // NEGATIVE reviews — what's broken
    // POSITIVE reviews — what people love
    // Play Store negative + positive
    // All four queries are fully independent — run in parallel.
    const negativeQuery = focusCategories?.length
      ? db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating <= 2 AND a.category IN ${db(focusCategories as string[])}
          ORDER BY r.first_seen_at DESC LIMIT 400
        `
      : db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating <= 2
          ORDER BY r.first_seen_at DESC LIMIT 400
        `;

    const positiveQuery = focusCategories?.length
      ? db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating >= 4 AND LENGTH(r.content) > 30 AND a.category IN ${db(focusCategories as string[])}
          ORDER BY r.first_seen_at DESC LIMIT 200
        `
      : db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating >= 4 AND LENGTH(r.content) > 30
          ORDER BY r.first_seen_at DESC LIMIT 200
        `;

    const [negativeReviews, positiveReviews, playNegative, playPositive] = (await Promise.all([
      negativeQuery,
      positiveQuery,
      db`
        SELECT a.category, a.name as app_name, r.title, r.content, r.rating
        FROM playstore_reviews r
        JOIN playstore_apps a ON a.id = r.app_id
        WHERE r.rating <= 2 AND a.category != ''
        ORDER BY r.first_seen_at DESC LIMIT 400
      `,
      db`
        SELECT a.category, a.name as app_name, r.title, r.content, r.rating
        FROM playstore_reviews r
        JOIN playstore_apps a ON a.id = r.app_id
        WHERE r.rating >= 4 AND LENGTH(r.content) > 30 AND a.category != ''
        ORDER BY r.first_seen_at DESC LIMIT 200
      `,
    ])) as [
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
    ];

    // Group by category
    const byCat = new Map<string, { negative: Array<Record<string, unknown>>; positive: Array<Record<string, unknown>> }>();

    for (const r of [...sampleRandom(negativeReviews, 150), ...sampleRandom(playNegative, 150)]) {
      const cat = r.category as string;
      if (!cat) continue;
      const entry = byCat.get(cat) ?? { negative: [], positive: [] };
      entry.negative.push(r);
      byCat.set(cat, entry);
    }
    for (const r of [...sampleRandom(positiveReviews, 80), ...sampleRandom(playPositive, 80)]) {
      const cat = r.category as string;
      if (!cat) continue;
      const entry = byCat.get(cat) ?? { negative: [], positive: [] };
      entry.positive.push(r);
      byCat.set(cat, entry);
    }

    for (const [category, reviews] of byCat) {
      if (reviews.negative.length < 3 && reviews.positive.length < 3) continue;

      const negApps = [...new Set(reviews.negative.map((r) => r.app_name as string))];
      const negSamples = reviews.negative
        .slice(0, 6)
        .map((r) => `[${r.rating}/5] "${r.app_name}": ${(r.content as string).slice(0, 150)}`);

      const posSamples = reviews.positive
        .slice(0, 4)
        .map((r) => `[${r.rating}/5] "${r.app_name}": ${(r.content as string).slice(0, 150)}`);

      clusters.push({
        category,
        theme: category,
        complaintCount: reviews.negative.length,
        sampleComplaints: [...negSamples, "--- WHAT USERS LOVE ---", ...posSamples],
        affectedApps: negApps.slice(0, 5),
      });
    }

    clusters.sort((a, b) => b.complaintCount - a.complaintCount);
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

  log.info("Review clustering complete", { clusters: clusters.length });

  // LLM insight extraction (graceful degradation on failure)
  const insights = await extractReviewInsights(summaryLines.join("\n\n"), resolvedModel);

  return {
    clusters: clusters.slice(0, 15),
    summary: summaryLines.join("\n\n"),
    insights,
  };
}

// ── Step 3: Capability Scan ──────────────────────────────────────────────────

async function extractCapabilityInsights(
  capabilities: readonly import("./types").Capability[],
  model: string,
): Promise<CapabilityInsight | undefined> {
  const lines: string[] = [];
  for (const c of capabilities) {
    lines.push(`[${c.source.toUpperCase()}] ${c.title}\n  ${c.description}`);
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
${rawText.slice(0, 50000)}`;

  const messages: readonly ConversationMessage[] = [makeUserMessage(userContent)];

  try {
    const response = await chat(messages, { ...buildChatOptions(model), systemPrompt });
    return parseJsonFromResponse<CapabilityInsight | undefined>(response.text, undefined);
  } catch (err) {
    log.warn("Capability insight extraction failed", { err });
    return undefined;
  }
}

export async function scanCapabilities(model?: string): Promise<CapabilityScan> {
  const db = getDb();
  const resolvedModel = model ?? DEFAULT_MODEL;
  const capabilities: Capability[] = [];

  try {
    // Product Hunt: recent high-engagement launches (30-day window)
    // first_seen_at is a unix epoch integer
    const cutoff30d = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    let ph = (await db`
      SELECT name, tagline, description, url, website_url, votes_count, comments_count
      FROM ph_products
      WHERE first_seen_at >= ${cutoff30d}
      ORDER BY (votes_count + comments_count * 3) DESC
      LIMIT 15
    `) as Array<Record<string, unknown>>;

    // Fallback: all-time with random offset to ensure variation across runs
    if (ph.length < 5) {
      ph = (await db`
        SELECT name, tagline, description, url, website_url, votes_count, comments_count
        FROM ph_products
        ORDER BY (votes_count + comments_count * 3) DESC
        LIMIT 15
        OFFSET floor(random() * 10)::int
      `) as Array<Record<string, unknown>>;
    }

    for (const p of ph) {
      capabilities.push({
        title: `${p.name}: ${p.tagline}`,
        source: "producthunt",
        url: (p.url as string) || (p.website_url as string) || "",
        description: (p.description as string)?.slice(0, 200) ?? "",
        type: "new_tech",
      });
    }

    // HN: what tech community cares about in the last 7 days
    const hn = (await db`
      SELECT title, url, hn_url, points, comment_count
      FROM hn_stories
      WHERE updated_at >= NOW() - INTERVAL '7 days'
      ORDER BY updated_at DESC, (points + comment_count * 2) DESC
      LIMIT 15
    `) as Array<Record<string, unknown>>;

    for (const s of hn) {
      capabilities.push({
        title: s.title as string,
        source: "hackernews",
        url: (s.url as string) || (s.hn_url as string) || "",
        description: `${s.points} points, ${s.comment_count} comments`,
        type: "new_tech",
      });
    }

    // GitHub: actively trending repos (stars gained today)
    let repos = (await db`
      SELECT full_name, description, language, stars, stars_today, url
      FROM github_repos
      WHERE stars_today > 0
      ORDER BY stars_today DESC, stars DESC
      LIMIT 15
    `) as Array<Record<string, unknown>>;

    // Fallback: all-time with random offset if no active trending data
    if (repos.length < 5) {
      repos = (await db`
        SELECT full_name, description, language, stars, stars_today, url
        FROM github_repos
        ORDER BY stars DESC
        LIMIT 15
        OFFSET floor(random() * 10)::int
      `) as Array<Record<string, unknown>>;
    }

    for (const r of repos) {
      capabilities.push({
        title: `${r.full_name} (${r.language || "?"})`,
        source: "github",
        url: (r.url as string) || `https://github.com/${r.full_name}`,
        description: `${(r.description as string)?.slice(0, 150) ?? ""} — ${r.stars} stars (+${r.stars_today} today)`,
        type: "open_source",
      });
    }

    // Reddit: posts from the last 7 days
    const posts = (await db`
      SELECT title, selftext, subreddit, score, num_comments, permalink
      FROM reddit_posts
      WHERE updated_at >= NOW() - INTERVAL '7 days'
      ORDER BY updated_at DESC, (score + num_comments * 3) DESC
      LIMIT 10
    `) as Array<Record<string, unknown>>;

    for (const p of posts) {
      capabilities.push({
        title: `r/${p.subreddit}: ${p.title}`,
        source: "reddit",
        url: p.permalink ? `https://reddit.com${p.permalink}` : "",
        description: `${p.score} pts, ${p.num_comments} comments`,
        type: "behavior_shift",
      });
    }

    // News: 72h window (already well-filtered — keep as-is)
    const cutoff72h = Math.floor(Date.now() / 1000) - 72 * 3600;
    const articles = (await db`
      SELECT title, url, source_name, summary
      FROM news_articles WHERE scraped_at >= ${cutoff72h}
      ORDER BY scraped_at DESC LIMIT 10
    `) as Array<Record<string, unknown>>;

    for (const a of articles) {
      capabilities.push({
        title: a.title as string,
        source: "news",
        url: (a.url as string) || "",
        description: (a.summary as string)?.slice(0, 150) ?? "",
        type: "behavior_shift",
      });
    }

    // X/Twitter: last 7 days
    const tweets = (await db`
      SELECT author_username, text, likes, retweets, views
      FROM x_scraped_tweets
      WHERE scraped_at >= NOW() - INTERVAL '7 days'
      ORDER BY scraped_at DESC LIMIT 10
    `) as Array<Record<string, unknown>>;

    for (const t of tweets) {
      capabilities.push({
        title: `@${t.author_username}`,
        source: "x",
        url: "",
        description: (t.text as string)?.slice(0, 200) ?? "",
        type: "behavior_shift",
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
    summaryLines.push(`=== ${source.toUpperCase()} (${items.length} items) ===`);
    for (const item of items) {
      summaryLines.push(`  ${item.title}${item.url ? `\n    URL: ${item.url}` : ""}\n    ${item.description}`);
    }
  }

  log.info("Capability scan complete", { capabilities: capabilities.length });

  // LLM insight extraction (graceful degradation on failure)
  const insights = await extractCapabilityInsights(capabilities, resolvedModel);

  return { capabilities, summary: summaryLines.join("\n"), insights };
}
