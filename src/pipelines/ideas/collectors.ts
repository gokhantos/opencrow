/**
 * Smart data collectors for the idea generation pipeline.
 * Each collector fetches data from a specific source and formats it
 * into a compact text summary for AI analysis.
 */

import {
  getRankings as getAppStoreRankings,
  getLowRatedReviews as getAppStoreComplaints,
} from "../../sources/appstore/store";
import {
  getRankings as getPlayStoreRankings,
  getLowRatedReviews as getPlayStoreComplaints,
} from "../../sources/playstore/store";
import { getProducts } from "../../sources/producthunt/store";
import { getStories } from "../../sources/hackernews/store";
import { getPosts } from "../../sources/reddit/store";
import { getRepos } from "../../sources/github/store";
import { getRecentArticles } from "../../sources/news/store";
import type { NewsArticle } from "../../sources/news/types";
import { createLogger } from "../../logger";
import type { CollectedData, CollectionResult } from "./types";

const log = createLogger("pipeline:collectors");

// ── Individual collectors ───────────────────────────────────────────────

async function collectAppStore(): Promise<CollectedData> {
  try {
    const [rankings, complaints] = await Promise.all([
      getAppStoreRankings(undefined, 30),
      getAppStoreComplaints(80),
    ]);

    const rankingSummary = rankings
      .slice(0, 20)
      .map(
        (r) =>
          `#${r.rank} ${r.name} by ${r.artist} (${r.category}) - ${r.list_type}`,
      )
      .join("\n");

    const complaintSummary = complaints
      .map(
        (r) =>
          `[${r.rating}/5] "${r.app_name}" - ${r.title}: ${r.content.slice(0, 200)}`,
      )
      .join("\n");

    const summary = [
      `=== APP STORE RANKINGS (${rankings.length} apps) ===`,
      rankingSummary,
      "",
      `=== APP STORE COMPLAINTS (${complaints.length} low-rated reviews) ===`,
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
    const [rankings, complaints] = await Promise.all([
      getPlayStoreRankings(undefined, 30),
      getPlayStoreComplaints(80),
    ]);

    const rankingSummary = rankings
      .slice(0, 20)
      .map(
        (r) =>
          `#${r.rank} ${r.name} by ${r.developer} (${r.category}, ${r.installs} installs, ${r.rating ?? "?"}/5) - ${r.list_type}`,
      )
      .join("\n");

    const complaintSummary = complaints
      .map(
        (r) =>
          `[${r.rating}/5] "${r.app_name}" - ${r.title}: ${r.content.slice(0, 200)}`,
      )
      .join("\n");

    const summary = [
      `=== PLAY STORE RANKINGS (${rankings.length} apps) ===`,
      rankingSummary,
      "",
      `=== PLAY STORE COMPLAINTS (${complaints.length} low-rated reviews) ===`,
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
    const products = await getProducts(30);

    const summary = products
      .map(
        (p) =>
          `${p.name} - ${p.tagline} (${p.votes_count} votes, ${p.comments_count} comments${p.is_featured ? ", FEATURED" : ""})${p.description ? `\n  ${p.description.slice(0, 150)}` : ""}`,
      )
      .join("\n");

    return {
      source: "producthunt",
      itemCount: products.length,
      summary: `=== PRODUCT HUNT LAUNCHES (${products.length} recent) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Product Hunt collection failed", { err });
    return { source: "producthunt", itemCount: 0, summary: "Product Hunt data unavailable." };
  }
}

async function collectHackerNews(): Promise<CollectedData> {
  try {
    const stories = await getStories(undefined, 30);

    const summary = stories
      .map((s) => {
        const velocity = s.points_velocity
          ? ` [velocity: ${s.points_velocity > 0 ? "+" : ""}${s.points_velocity}]`
          : "";
        const comments = s.comment_count > 0 ? ` (${s.comment_count} comments)` : "";
        return `${s.title} - ${s.points} pts${comments}${velocity}\n  ${s.url || s.hn_url}`;
      })
      .join("\n");

    return {
      source: "hackernews",
      itemCount: stories.length,
      summary: `=== HACKER NEWS TOP STORIES (${stories.length}) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Hacker News collection failed", { err });
    return { source: "hackernews", itemCount: 0, summary: "Hacker News data unavailable." };
  }
}

async function collectReddit(): Promise<CollectedData> {
  try {
    const posts = await getPosts(undefined, 30);

    const summary = posts
      .map((p) => {
        const engagement = `${p.score} pts, ${p.num_comments} comments`;
        const selftext = p.selftext ? `\n  ${p.selftext.slice(0, 200)}` : "";
        return `r/${p.subreddit}: ${p.title} (${engagement})${selftext}`;
      })
      .join("\n");

    return {
      source: "reddit",
      itemCount: posts.length,
      summary: `=== REDDIT TOP POSTS (${posts.length}) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("Reddit collection failed", { err });
    return { source: "reddit", itemCount: 0, summary: "Reddit data unavailable." };
  }
}

async function collectGitHub(): Promise<CollectedData> {
  try {
    const repos = await getRepos(undefined, undefined, 30);

    const summary = repos
      .map((r) => {
        const velocity = r.stars_velocity
          ? ` [velocity: +${r.stars_velocity}]`
          : "";
        return `${r.full_name} - ${r.description?.slice(0, 150) ?? ""}\n  ${r.language || "?"} | ${r.stars} stars (+${r.stars_today} today) | ${r.forks} forks${velocity}`;
      })
      .join("\n");

    return {
      source: "github",
      itemCount: repos.length,
      summary: `=== GITHUB TRENDING REPOS (${repos.length}) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("GitHub collection failed", { err });
    return { source: "github", itemCount: 0, summary: "GitHub data unavailable." };
  }
}

async function collectNews(): Promise<CollectedData> {
  try {
    const articles = await getRecentArticles({ hours: 72, limit: 30 });

    const summary = (articles as readonly NewsArticle[])
      .map(
        (a) =>
          `[${a.source_name}] ${a.title}\n  ${a.summary?.slice(0, 200) ?? ""}`,
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
    const { getDb } = await import("../../store/db");
    const db = getDb();
    const tweets = (await db`
      SELECT author_username, text, like_count, retweet_count, reply_count, created_at
      FROM x_scraped_tweets
      ORDER BY created_at DESC
      LIMIT 30
    `) as Array<Record<string, unknown>>;

    if (tweets.length === 0) {
      return { source: "x", itemCount: 0, summary: "X/Twitter data unavailable." };
    }

    const summary = tweets
      .map(
        (t) =>
          `@${t.author_username}: ${(t.text as string)?.slice(0, 250)} (${t.like_count} likes, ${t.retweet_count} RTs)`,
      )
      .join("\n");

    return {
      source: "x",
      itemCount: tweets.length,
      summary: `=== X/TWITTER TIMELINE (${tweets.length} recent) ===\n${summary}`,
    };
  } catch (err) {
    log.warn("X/Twitter collection failed", { err });
    return { source: "x", itemCount: 0, summary: "X/Twitter data unavailable." };
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
 * Returns a combined context string suitable for AI analysis.
 */
export async function collectAll(
  sourcesToInclude: readonly string[],
): Promise<CollectionResult> {
  const collectors = sourcesToInclude
    .filter((s) => COLLECTORS[s])
    .map((s) => COLLECTORS[s]!());

  const results = await Promise.allSettled(collectors);

  const sources: CollectedData[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      sources.push(result.value);
    }
  }

  const activeSources = sources.filter((s) => s.itemCount > 0);
  const aggregatedContext = activeSources
    .map((s) => s.summary)
    .join("\n\n---\n\n");

  const totalItems = sources.reduce((sum, s) => sum + s.itemCount, 0);

  log.info("Data collection complete", {
    requested: sourcesToInclude.length,
    collected: activeSources.length,
    totalItems,
  });

  return { sources, aggregatedContext, totalItems };
}
