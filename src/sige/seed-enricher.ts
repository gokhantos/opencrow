/**
 * Enriches a SIGE session seed input with a rich domain briefing built from
 * all of the project's live data sources: app store reviews, social signals,
 * news, competitive landscape, GitHub trends, and more.
 *
 * All queries run in parallel.  Each source is independently fault-tolerant —
 * a failure in one never blocks the others.  If every source fails, the
 * original seed is returned unchanged so the pipeline is never blocked.
 */

import { createLogger } from "../logger";
import { getDb } from "../store/db";
import { sanitizeScrapedField, wrapUntrusted } from "./untrusted";

const log = createLogger("sige:seed-enricher");

/**
 * Per-field hard cap for scraped strings before they enter the LLM prompt.
 * Scraped fields are already truncated at the query level (e.g. substring 1..200);
 * this is a defense-in-depth ceiling applied uniformly via sanitizeScrapedField.
 */
const FIELD_MAX_LEN = 500;

/** Sanitize a single scraped string field at the standard field-length cap. */
function san(value: string): string {
  return sanitizeScrapedField(value, FIELD_MAX_LEN);
}

// ─── Row types ────────────────────────────────────────────────────────────────

interface AppStoreReviewRow {
  readonly app_name: string;
  readonly title: string;
  readonly content: string;
  readonly rating: number;
}

interface PlayStoreReviewRow {
  readonly app_name: string;
  readonly title: string;
  readonly content: string;
  readonly rating: number;
  readonly thumbs_up: number | null;
}

interface PhProductRow {
  readonly name: string;
  readonly tagline: string;
  readonly votes_count: number;
}

interface HnStoryRow {
  readonly title: string;
  readonly points: number;
  readonly comment_count: number;
}

interface RedditPostRow {
  readonly subreddit: string;
  readonly title: string;
  readonly score: number;
  readonly num_comments: number;
}

interface NewsArticleRow {
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly source_name: string;
}

interface AppStoreCategoryRow {
  readonly category: string;
  readonly app_count: number;
}

interface PlayStoreCategoryRow {
  readonly category: string;
  readonly app_count: number;
  readonly avg_rating: number;
}

interface GithubRepoRow {
  readonly name: string;
  readonly description: string;
}

interface TweetRow {
  readonly text: string;
  readonly author_username: string;
  readonly likes: number;
  readonly retweets: number;
}

// ─── Individual fetchers (each returns empty array on failure) ────────────────

async function fetchAppStoreReviews(): Promise<readonly AppStoreReviewRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT app_name, title, substring(content, 1, 200) AS content, rating
      FROM appstore_reviews
      WHERE rating <= 2
      ORDER BY first_seen_at DESC
      LIMIT 15
    `) as AppStoreReviewRow[];
    log.debug("Fetched app store reviews", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch app store reviews", { err });
    return [];
  }
}

async function fetchPlayStoreReviews(): Promise<readonly PlayStoreReviewRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT app_name, title, substring(content, 1, 200) AS content, rating, thumbs_up
      FROM playstore_reviews
      WHERE rating <= 2
      ORDER BY thumbs_up DESC NULLS LAST
      LIMIT 15
    `) as PlayStoreReviewRow[];
    log.debug("Fetched play store reviews", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch play store reviews", { err });
    return [];
  }
}

async function fetchPhProducts(): Promise<readonly PhProductRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT name, tagline, votes_count
      FROM ph_products
      ORDER BY votes_count DESC
      LIMIT 15
    `) as PhProductRow[];
    log.debug("Fetched Product Hunt products", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch Product Hunt products", { err });
    return [];
  }
}

async function fetchHnStories(): Promise<readonly HnStoryRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT title, points, comment_count
      FROM hn_stories
      ORDER BY points DESC
      LIMIT 15
    `) as HnStoryRow[];
    log.debug("Fetched HN stories", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch HN stories", { err });
    return [];
  }
}

async function fetchRedditPosts(): Promise<readonly RedditPostRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT subreddit, title, score, num_comments
      FROM reddit_posts
      ORDER BY score DESC
      LIMIT 15
    `) as RedditPostRow[];
    log.debug("Fetched Reddit posts", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch Reddit posts", { err });
    return [];
  }
}

async function fetchNewsArticles(): Promise<readonly NewsArticleRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT title, summary, category, source_name
      FROM news_articles
      ORDER BY created_at DESC
      LIMIT 15
    `) as NewsArticleRow[];
    log.debug("Fetched news articles", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch news articles", { err });
    return [];
  }
}

async function fetchAppStoreCategories(): Promise<readonly AppStoreCategoryRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT category, count(*) AS app_count
      FROM appstore_apps
      GROUP BY category
      ORDER BY app_count DESC
      LIMIT 15
    `) as AppStoreCategoryRow[];
    log.debug("Fetched App Store category landscape", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch App Store categories", { err });
    return [];
  }
}

async function fetchPlayStoreCategories(): Promise<readonly PlayStoreCategoryRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT category, count(*) AS app_count, round(avg(rating)::numeric, 2) AS avg_rating
      FROM playstore_apps
      WHERE rating IS NOT NULL
      GROUP BY category
      ORDER BY avg_rating ASC
      LIMIT 15
    `) as PlayStoreCategoryRow[];
    log.debug("Fetched Play Store category gaps", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch Play Store categories", { err });
    return [];
  }
}

async function fetchGithubRepos(): Promise<readonly GithubRepoRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT name, description
      FROM github_repos
      ORDER BY updated_at DESC
      LIMIT 10
    `) as GithubRepoRow[];
    log.debug("Fetched GitHub repos", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch GitHub repos", { err });
    return [];
  }
}

async function fetchTweets(): Promise<readonly TweetRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT text, author_username, likes, retweets
      FROM x_scraped_tweets
      ORDER BY likes DESC
      LIMIT 15
    `) as TweetRow[];
    log.debug("Fetched tweets", { count: rows.length });
    return rows;
  } catch (err) {
    log.warn("Failed to fetch tweets", { err });
    return [];
  }
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildAppStoreSection(rows: readonly AppStoreReviewRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map((r) => `- [${san(r.app_name)}] "${san(r.title)}" (★${r.rating}): ${san(r.content)}`)
    .join("\n");
  return `## App Store User Pain Points (Low Ratings)\n${lines}`;
}

function buildPlayStoreSection(rows: readonly PlayStoreReviewRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map((r) => {
      const upvotes = r.thumbs_up != null ? `, ${r.thumbs_up} upvotes` : "";
      return `- [${san(r.app_name)}] "${san(r.title)}" (★${r.rating}${upvotes}): ${san(r.content)}`;
    })
    .join("\n");
  return `## Play Store User Pain Points (Most Upvoted Complaints)\n${lines}`;
}

function buildPhSection(rows: readonly PhProductRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map((r) => `- **${san(r.name)}** (${r.votes_count} votes): ${san(r.tagline)}`)
    .join("\n");
  return `## Product Hunt Trending Products\n${lines}`;
}

function buildHnSection(rows: readonly HnStoryRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map((r) => `- ${san(r.title)} (${r.points} pts, ${r.comment_count} comments)`)
    .join("\n");
  return `## Hacker News Top Stories\n${lines}`;
}

function buildRedditSection(rows: readonly RedditPostRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map(
      (r) =>
        `- [r/${san(r.subreddit)}] ${san(r.title)} (${r.score} upvotes, ${r.num_comments} comments)`,
    )
    .join("\n");
  return `## Reddit Top Discussions\n${lines}`;
}

function buildNewsSection(rows: readonly NewsArticleRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map((r) => `- [${san(r.category)}] ${san(r.title)} — ${san(r.summary)}`)
    .join("\n");
  return `## Recent News & Market Signals\n${lines}`;
}

function buildAppStoreCategorySection(rows: readonly AppStoreCategoryRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- ${san(r.category)}: ${r.app_count} apps`).join("\n");
  return `## App Store Category Landscape\n${lines}`;
}

function buildPlayStoreCategorySection(rows: readonly PlayStoreCategoryRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map((r) => `- ${san(r.category)}: ${r.app_count} apps, avg rating ${r.avg_rating}★`)
    .join("\n");
  return `## Play Store Category Gaps (Lowest Rated)\n${lines}`;
}

function buildGithubSection(rows: readonly GithubRepoRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- **${san(r.name)}**: ${san(r.description)}`).join("\n");
  return `## GitHub Trending Repos\n${lines}`;
}

function buildTweetSection(rows: readonly TweetRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map(
      (r) =>
        `- @${san(r.author_username)} (${r.likes} likes, ${r.retweets} RTs): ${san(r.text.slice(0, 200))}`,
    )
    .join("\n");
  return `## Social Signals (X/Twitter)\n${lines}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Returns an enriched version of `seedInput` that includes a structured domain
 * briefing drawn from all project data sources.  Never throws — returns the
 * original seed on total failure.
 */
export async function enrichSeedWithProjectData(seedInput: string): Promise<string> {
  try {
    const [
      appStoreReviews,
      playStoreReviews,
      phProducts,
      hnStories,
      redditPosts,
      newsArticles,
      appStoreCategories,
      playStoreCategories,
      githubRepos,
      tweets,
    ] = await Promise.all([
      fetchAppStoreReviews(),
      fetchPlayStoreReviews(),
      fetchPhProducts(),
      fetchHnStories(),
      fetchRedditPosts(),
      fetchNewsArticles(),
      fetchAppStoreCategories(),
      fetchPlayStoreCategories(),
      fetchGithubRepos(),
      fetchTweets(),
    ]);

    log.info("Seed enrichment data fetched", {
      appStoreReviews: appStoreReviews.length,
      playStoreReviews: playStoreReviews.length,
      phProducts: phProducts.length,
      hnStories: hnStories.length,
      redditPosts: redditPosts.length,
      newsArticles: newsArticles.length,
      appStoreCategories: appStoreCategories.length,
      playStoreCategories: playStoreCategories.length,
      githubRepos: githubRepos.length,
      tweets: tweets.length,
    });

    // The operator-supplied seed is the only trusted instruction surface; it is
    // kept OUTSIDE the untrusted fence. Every scraped section (reviews, posts,
    // tweets, repos, …) is third-party data and is wrapped in an UNTRUSTED_DATA
    // fence so downstream prompts treat it as data, never as instructions.
    const userQuerySection = `## User Query\n${seedInput}`;

    const scrapedSections = [
      buildAppStoreSection(appStoreReviews),
      buildPlayStoreSection(playStoreReviews),
      buildPhSection(phProducts),
      buildHnSection(hnStories),
      buildRedditSection(redditPosts),
      buildNewsSection(newsArticles),
      buildAppStoreCategorySection(appStoreCategories),
      buildPlayStoreCategorySection(playStoreCategories),
      buildGithubSection(githubRepos),
      buildTweetSection(tweets),
    ].filter((s) => s.length > 0);

    if (scrapedSections.length === 0) {
      return userQuerySection;
    }

    const wrappedCorpus = wrapUntrusted("scraped-corpus", scrapedSections.join("\n\n"));

    return [userQuerySection, wrappedCorpus].join("\n\n");
  } catch (err) {
    log.warn("Seed enrichment failed, falling back to original seed", { err });
    return seedInput;
  }
}
