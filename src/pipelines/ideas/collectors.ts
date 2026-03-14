/**
 * Trend-intersection data collectors.
 *
 * Three focused collectors that use our FULL app store data:
 * 1. analyzeAppLandscape() — what apps exist, what they do, where satisfaction is lowest
 * 2. clusterPainPoints() — what's broken + what people love (both negative AND positive reviews)
 * 3. scanCapabilities() — what new tech/shifts enable solutions (PH/HN/GitHub/Reddit/News/X)
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import type {
  TrendData,
  CategoryTrend,
  ClusteredPains,
  PainCluster,
  CapabilityScan,
  Capability,
} from "./types";

const log = createLogger("pipeline:collectors");

/** Shuffle array and return first N. */
function sampleRandom<T>(items: readonly T[], n: number): readonly T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}

// ── Step 1: App Landscape Analysis ──────────────────────────────────────

/**
 * Analyze the FULL app landscape:
 * - Category satisfaction scores (avg rating from reviews)
 * - What existing apps offer (descriptions = feature landscape)
 * - Which categories are underserved (low satisfaction + many apps = opportunity)
 */
export async function analyzeAppLandscape(): Promise<TrendData> {
  const db = getDb();
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

    return {
      risingApps: [],
      trendingCategories,
      summary: summaryLines.join("\n"),
    };
  } catch (err) {
    log.warn("App landscape analysis failed", { err });
    return { risingApps: [], trendingCategories: [], summary: "App landscape data unavailable." };
  }
}

// ── Step 2: Pain Point Clustering (negative AND positive reviews) ────────

/**
 * Cluster reviews by category — both COMPLAINTS (what's broken)
 * and PRAISES (what people love and want more of).
 */
export async function clusterReviews(
  focusCategories?: readonly string[],
): Promise<ClusteredPains> {
  const db = getDb();
  const clusters: PainCluster[] = [];

  try {
    // NEGATIVE reviews — what's broken
    const negativeReviews = focusCategories?.length
      ? (await db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating <= 2 AND a.category = ANY(${focusCategories as string[]})
          ORDER BY r.first_seen_at DESC LIMIT 400
        `) as Array<Record<string, unknown>>
      : (await db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating <= 2
          ORDER BY r.first_seen_at DESC LIMIT 400
        `) as Array<Record<string, unknown>>;

    // POSITIVE reviews — what people love
    const positiveReviews = focusCategories?.length
      ? (await db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating >= 4 AND LENGTH(r.content) > 30 AND a.category = ANY(${focusCategories as string[]})
          ORDER BY r.first_seen_at DESC LIMIT 200
        `) as Array<Record<string, unknown>>
      : (await db`
          SELECT a.category, a.name as app_name, r.title, r.content, r.rating
          FROM appstore_reviews r
          JOIN appstore_apps a ON a.id = r.app_id
          WHERE r.rating >= 4 AND LENGTH(r.content) > 30
          ORDER BY r.first_seen_at DESC LIMIT 200
        `) as Array<Record<string, unknown>>;

    // Play Store negative + positive
    const playNegative = (await db`
      SELECT a.category, a.name as app_name, r.title, r.content, r.rating
      FROM playstore_reviews r
      JOIN playstore_apps a ON a.id = r.app_id
      WHERE r.rating <= 2 AND a.category != ''
      ORDER BY r.first_seen_at DESC LIMIT 400
    `) as Array<Record<string, unknown>>;

    const playPositive = (await db`
      SELECT a.category, a.name as app_name, r.title, r.content, r.rating
      FROM playstore_reviews r
      JOIN playstore_apps a ON a.id = r.app_id
      WHERE r.rating >= 4 AND LENGTH(r.content) > 30 AND a.category != ''
      ORDER BY r.first_seen_at DESC LIMIT 200
    `) as Array<Record<string, unknown>>;

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

  return {
    clusters: clusters.slice(0, 15),
    summary: summaryLines.join("\n\n"),
  };
}

// ── Step 3: Capability Scan ─────────────────────────────────────────────

export async function scanCapabilities(): Promise<CapabilityScan> {
  const db = getDb();
  const capabilities: Capability[] = [];

  try {
    // Product Hunt: high engagement launches
    const ph = (await db`
      SELECT name, tagline, description, url, website_url, votes_count, comments_count
      FROM ph_products
      ORDER BY (votes_count + comments_count * 3) DESC
      LIMIT 15
    `) as Array<Record<string, unknown>>;

    for (const p of ph) {
      capabilities.push({
        title: `${p.name}: ${p.tagline}`,
        source: "producthunt",
        url: (p.url as string) || (p.website_url as string) || "",
        description: (p.description as string)?.slice(0, 200) ?? "",
        type: "new_tech",
      });
    }

    // HN: what tech community cares about
    const hn = (await db`
      SELECT title, url, hn_url, points, comment_count
      FROM hn_stories
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

    // GitHub: trending repos = building blocks
    const repos = (await db`
      SELECT full_name, description, language, stars, stars_today, url
      FROM github_repos
      ORDER BY stars_today DESC, stars DESC
      LIMIT 15
    `) as Array<Record<string, unknown>>;

    for (const r of repos) {
      capabilities.push({
        title: `${r.full_name} (${r.language || "?"})`,
        source: "github",
        url: (r.url as string) || `https://github.com/${r.full_name}`,
        description: `${(r.description as string)?.slice(0, 150) ?? ""} — ${r.stars} stars (+${r.stars_today} today)`,
        type: "open_source",
      });
    }

    // Reddit
    const posts = (await db`
      SELECT title, selftext, subreddit, score, num_comments, permalink
      FROM reddit_posts
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

    // News
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

    // X/Twitter
    const tweets = (await db`
      SELECT author_username, text, likes, retweets, views
      FROM x_scraped_tweets
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

  return { capabilities, summary: summaryLines.join("\n") };
}
