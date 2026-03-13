/**
 * Smart data collectors for the idea generation pipeline.
 *
 * Instead of blindly grabbing the latest N items, each collector uses
 * engagement-weighted ranking: velocity, points, stars, comments, upvote
 * ratios — surfacing the HIGHEST SIGNAL items, not just the newest.
 */

import { getDb } from "../../store/db";
import type { NewsArticle } from "../../sources/news/types";
import { createLogger } from "../../logger";
import type { CollectedData, CollectionResult } from "./types";

const log = createLogger("pipeline:collectors");

// ── Smart collectors (engagement-weighted) ──────────────────────────────

async function collectAppStore(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Top ranked apps across all list types
    const rankings = (await db`
      SELECT a.*, r.rank, r.list_type
      FROM appstore_apps a
      JOIN (
        SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
        FROM appstore_ranking_history
        ORDER BY app_id, list_type, scraped_at DESC
      ) r ON a.id = r.app_id
      WHERE r.list_type != 'discovered'
      ORDER BY r.rank ASC
      LIMIT 25
    `) as Array<Record<string, unknown>>;

    // Complaints clustered by app — shows patterns, not random reviews
    const complaints = (await db`
      SELECT app_name, rating, title, content, app_id,
             COUNT(*) OVER (PARTITION BY app_id) as complaint_count
      FROM appstore_reviews
      WHERE rating <= 2
      ORDER BY first_seen_at DESC
      LIMIT 80
    `) as Array<Record<string, unknown>>;

    const rankingSummary = rankings
      .map(
        (r) =>
          `#${r.rank} ${r.name} by ${r.artist} (${r.category}) - ${r.list_type}\n  URL: ${r.store_url || "n/a"}`,
      )
      .join("\n");

    const complaintSummary = complaints
      .map(
        (r) =>
          `[${r.rating}/5] "${r.app_name}" (${r.complaint_count} total complaints) - ${r.title}: ${(r.content as string).slice(0, 200)}`,
      )
      .join("\n");

    const summary = [
      `=== APP STORE RANKINGS (${rankings.length} top apps) ===`,
      rankingSummary,
      "",
      `=== APP STORE COMPLAINTS (${complaints.length} low-rated reviews, clustered by app) ===`,
      complaintSummary,
    ].join("\n");

    return {
      source: "appstore",
      itemCount: rankings.length + complaints.length,
      summary,
    };
  } catch (err) {
    log.warn("App Store collection failed", { err });
    return { source: "appstore", itemCount: 0, summary: "App Store data unavailable." };
  }
}

async function collectPlayStore(): Promise<CollectedData> {
  try {
    const db = getDb();

    const rankings = (await db`
      SELECT a.*, r.rank, r.list_type
      FROM playstore_apps a
      JOIN (
        SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
        FROM playstore_ranking_history
        ORDER BY app_id, list_type, scraped_at DESC
      ) r ON a.id = r.app_id
      WHERE r.list_type != 'discovered'
      ORDER BY r.rank ASC
      LIMIT 25
    `) as Array<Record<string, unknown>>;

    const complaints = (await db`
      SELECT app_name, rating, title, content, app_id, thumbs_up,
             COUNT(*) OVER (PARTITION BY app_id) as complaint_count
      FROM playstore_reviews
      WHERE rating <= 2
      ORDER BY thumbs_up DESC, first_seen_at DESC
      LIMIT 80
    `) as Array<Record<string, unknown>>;

    const rankingSummary = rankings
      .map(
        (r) =>
          `#${r.rank} ${r.name} by ${r.developer} (${r.category}, ${r.installs} installs, ${r.rating ?? "?"}/5) - ${r.list_type}\n  URL: ${r.store_url || "n/a"}`,
      )
      .join("\n");

    const complaintSummary = complaints
      .map(
        (r) =>
          `[${r.rating}/5, ${r.thumbs_up} thumbs up] "${r.app_name}" (${r.complaint_count} complaints) - ${r.title}: ${(r.content as string).slice(0, 200)}`,
      )
      .join("\n");

    const summary = [
      `=== PLAY STORE RANKINGS (${rankings.length} top apps) ===`,
      rankingSummary,
      "",
      `=== PLAY STORE COMPLAINTS (${complaints.length} reviews, sorted by thumbs up) ===`,
      complaintSummary,
    ].join("\n");

    return {
      source: "playstore",
      itemCount: rankings.length + complaints.length,
      summary,
    };
  } catch (err) {
    log.warn("Play Store collection failed", { err });
    return { source: "playstore", itemCount: 0, summary: "Play Store data unavailable." };
  }
}

async function collectProductHunt(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Sort by engagement (votes + comments), not just recency
    const products = (await db`
      SELECT * FROM ph_products
      ORDER BY (votes_count + comments_count * 3) DESC, updated_at DESC
      LIMIT 30
    `) as Array<Record<string, unknown>>;

    const summary = products
      .map(
        (p) =>
          `${p.name} - ${p.tagline} (${p.votes_count} votes, ${p.comments_count} comments${p.is_featured ? ", FEATURED" : ""})\n  URL: ${p.url || p.website_url || "n/a"}${p.description ? `\n  ${(p.description as string).slice(0, 150)}` : ""}`,
      )
      .join("\n");

    return {
      source: "producthunt",
      itemCount: products.length,
      summary: `=== PRODUCT HUNT TOP LAUNCHES (${products.length}, ranked by engagement) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Product Hunt collection failed", { err });
    return { source: "producthunt", itemCount: 0, summary: "Product Hunt data unavailable." };
  }
}

async function collectHackerNews(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Highest velocity stories (fastest growing) + top engagement
    const stories = (await db`
      SELECT * FROM hn_stories
      ORDER BY
        COALESCE(points_velocity, 0) DESC,
        (points + comment_count * 2) DESC,
        updated_at DESC
      LIMIT 30
    `) as Array<Record<string, unknown>>;

    const summary = stories
      .map((s) => {
        const velocity = s.points_velocity
          ? ` [velocity: ${(s.points_velocity as number) > 0 ? "+" : ""}${s.points_velocity}]`
          : "";
        const comments = (s.comment_count as number) > 0 ? ` (${s.comment_count} comments)` : "";
        return `${s.title} - ${s.points} pts${comments}${velocity}\n  URL: ${s.url || "n/a"}\n  HN: ${s.hn_url}`;
      })
      .join("\n");

    return {
      source: "hackernews",
      itemCount: stories.length,
      summary: `=== HACKER NEWS TOP STORIES (${stories.length}, ranked by velocity + engagement) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Hacker News collection failed", { err });
    return { source: "hackernews", itemCount: 0, summary: "Hacker News data unavailable." };
  }
}

async function collectReddit(): Promise<CollectedData> {
  try {
    const db = getDb();

    // High engagement + high upvote ratio = quality signal
    const posts = (await db`
      SELECT * FROM reddit_posts
      ORDER BY
        (score * upvote_ratio + num_comments * 3) DESC,
        updated_at DESC
      LIMIT 30
    `) as Array<Record<string, unknown>>;

    const summary = posts
      .map((p) => {
        const engagement = `${p.score} pts (${((p.upvote_ratio as number) * 100).toFixed(0)}% upvoted), ${p.num_comments} comments`;
        const selftext = p.selftext ? `\n  ${(p.selftext as string).slice(0, 200)}` : "";
        const url = p.permalink
          ? `https://reddit.com${p.permalink}`
          : (p.url as string) || "n/a";
        return `r/${p.subreddit}: ${p.title} (${engagement})\n  URL: ${url}${selftext}`;
      })
      .join("\n");

    return {
      source: "reddit",
      itemCount: posts.length,
      summary: `=== REDDIT TOP POSTS (${posts.length}, ranked by engagement quality) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Reddit collection failed", { err });
    return { source: "reddit", itemCount: 0, summary: "Reddit data unavailable." };
  }
}

async function collectGitHub(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Fastest growing repos by star velocity, not just total stars
    const repos = (await db`
      SELECT * FROM github_repos
      ORDER BY
        COALESCE(stars_velocity, stars_today) DESC,
        stars_today DESC,
        stars DESC
      LIMIT 30
    `) as Array<Record<string, unknown>>;

    const summary = repos
      .map((r) => {
        const velocity = r.stars_velocity
          ? ` [velocity: +${r.stars_velocity}]`
          : "";
        return `${r.full_name} - ${(r.description as string)?.slice(0, 150) ?? ""}\n  ${r.language || "?"} | ${r.stars} stars (+${r.stars_today} today) | ${r.forks} forks${velocity}\n  URL: ${r.url || `https://github.com/${r.full_name}`}`;
      })
      .join("\n");

    return {
      source: "github",
      itemCount: repos.length,
      summary: `=== GITHUB TRENDING REPOS (${repos.length}, ranked by star velocity) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("GitHub collection failed", { err });
    return { source: "github", itemCount: 0, summary: "GitHub data unavailable." };
  }
}

async function collectNews(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Recent articles from last 72h, across all news sources
    const cutoff = Math.floor(Date.now() / 1000) - 72 * 3600;
    const articles = (await db`
      SELECT * FROM news_articles
      WHERE scraped_at >= ${cutoff}
      ORDER BY scraped_at DESC
      LIMIT 30
    `) as readonly NewsArticle[];

    const summary = articles
      .map(
        (a) =>
          `[${a.source_name}] ${a.title}\n  URL: ${a.url || "n/a"}\n  ${a.summary?.slice(0, 200) ?? ""}`,
      )
      .join("\n");

    return {
      source: "news",
      itemCount: articles.length,
      summary: `=== NEWS ARTICLES (${articles.length} from last 72h) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("News collection failed", { err });
    return { source: "news", itemCount: 0, summary: "News data unavailable." };
  }
}

async function collectXTimeline(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Highest engagement tweets, not just latest
    const tweets = (await db`
      SELECT author_username, text, like_count, retweet_count, reply_count, created_at
      FROM x_scraped_tweets
      ORDER BY (like_count + retweet_count * 3 + reply_count * 2) DESC, created_at DESC
      LIMIT 30
    `) as Array<Record<string, unknown>>;

    if (tweets.length === 0) {
      return { source: "x", itemCount: 0, summary: "X/Twitter data unavailable." };
    }

    const summary = tweets
      .map(
        (t) =>
          `@${t.author_username}: ${(t.text as string)?.slice(0, 250)} (${t.like_count} likes, ${t.retweet_count} RTs, ${t.reply_count} replies)`,
      )
      .join("\n");

    return {
      source: "x",
      itemCount: tweets.length,
      summary: `=== X/TWITTER (${tweets.length}, ranked by engagement) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("X/Twitter collection failed", { err });
    return { source: "x", itemCount: 0, summary: "X/Twitter data unavailable." };
  }
}

// ── Cross-source trending themes (semantic search) ──────────────────────

async function collectCrossSourceSignals(): Promise<CollectedData> {
  try {
    const db = getDb();

    // Find themes that appear across MULTIPLE sources in the last 7 days
    // This is the highest-signal data: convergent trends
    const cutoff7d = Math.floor(Date.now() / 1000) - 7 * 86400;

    const signals = (await db`
      SELECT signal_type, title, detail, source, strength, themes, source_url
      FROM research_signals
      WHERE consumed = false AND created_at >= ${cutoff7d} AND strength >= 3
      ORDER BY strength DESC, created_at DESC
      LIMIT 20
    `) as Array<Record<string, unknown>>;

    if (signals.length === 0) {
      return { source: "signals", itemCount: 0, summary: "" };
    }

    const summary = signals
      .map(
        (s) =>
          `[strength: ${s.strength}/5] ${s.title} (${s.source})\n  ${(s.detail as string)?.slice(0, 200)}${s.source_url ? `\n  URL: ${s.source_url}` : ""}${s.themes ? `\n  Themes: ${s.themes}` : ""}`,
      )
      .join("\n");

    return {
      source: "signals",
      itemCount: signals.length,
      summary: `=== RESEARCH SIGNALS (${signals.length} high-strength, unconsumed) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Cross-source signals collection failed", { err });
    return { source: "signals", itemCount: 0, summary: "" };
  }
}

// ── Collector registry ──────────────────────────────────────────────────

const COLLECTORS: Record<string, () => Promise<CollectedData>> = {
  appstore: collectAppStore,
  playstore: collectPlayStore,
  producthunt: collectProductHunt,
  hackernews: collectHackerNews,
  reddit: collectReddit,
  github: collectGitHub,
  news: collectNews,
  x: collectXTimeline,
};

/**
 * Collect data from all specified sources in parallel.
 * Uses engagement-weighted queries to surface highest-signal items.
 * Also collects cross-source research signals for trend convergence.
 */
export async function collectAll(
  sourcesToInclude: readonly string[],
): Promise<CollectionResult> {
  const collectors = sourcesToInclude
    .filter((s) => COLLECTORS[s])
    .map((s) => COLLECTORS[s]!());

  // Always include cross-source signals as bonus intelligence
  collectors.push(collectCrossSourceSignals());

  const results = await Promise.allSettled(collectors);

  const sources: CollectedData[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.itemCount > 0) {
      sources.push(result.value);
    }
  }

  const aggregatedContext = sources
    .map((s) => s.summary)
    .join("\n\n---\n\n");

  const totalItems = sources.reduce((sum, s) => sum + s.itemCount, 0);

  log.info("Data collection complete", {
    requested: sourcesToInclude.length,
    collected: sources.length,
    totalItems,
  });

  return { sources, aggregatedContext, totalItems };
}
