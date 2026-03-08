import { getDb } from "../../../store/db";
import type { TimelineScrapeJob, TimelineTweetFromPython } from "./types";

export function getTimelineScrapeJob(
  accountId: string,
): Promise<TimelineScrapeJob | null> {
  const db = getDb();
  return db`
    SELECT * FROM x_timeline_scrape_jobs WHERE account_id = ${accountId}
  `.then((rows) => (rows[0] as TimelineScrapeJob) ?? null);
}

export function upsertTimelineScrapeJob(
  accountId: string,
  maxPages: number,
  sources: string,
  intervalMinutes: number,
  status: "running" | "stopped",
  nextRunAt: number | null,
  languages: string | null = null,
): Promise<TimelineScrapeJob> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  return db`
    INSERT INTO x_timeline_scrape_jobs (
      id, account_id, max_pages, sources, interval_minutes,
      status, next_run_at, languages, created_at, updated_at
    ) VALUES (
      ${id}, ${accountId}, ${maxPages}, ${sources}, ${intervalMinutes},
      ${status}, ${nextRunAt}, ${languages}, ${now}, ${now}
    )
    ON CONFLICT (account_id) DO UPDATE SET
      max_pages = ${maxPages},
      sources = ${sources},
      interval_minutes = ${intervalMinutes},
      status = ${status},
      next_run_at = ${nextRunAt},
      languages = ${languages},
      updated_at = ${now}
    RETURNING *
  `.then((rows) => rows[0] as TimelineScrapeJob);
}

export function stopTimelineScrapeJob(accountId: string): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    UPDATE x_timeline_scrape_jobs SET
      status = 'stopped',
      next_run_at = NULL,
      updated_at = ${now}
    WHERE account_id = ${accountId}
  `.then(() => undefined);
}

export function getDueTimelineScrapeJobs(): Promise<TimelineScrapeJob[]> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    SELECT * FROM x_timeline_scrape_jobs
    WHERE status = 'running' AND next_run_at <= ${now}
  `.then((rows) => rows as TimelineScrapeJob[]);
}

export function updateTimelineJobAfterSuccess(
  accountId: string,
  scrapedCount: number,
  nextRunAt: number,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    UPDATE x_timeline_scrape_jobs SET
      total_scraped = total_scraped + ${scrapedCount},
      last_run_at = ${now},
      last_error = NULL,
      next_run_at = ${nextRunAt},
      updated_at = ${now}
    WHERE account_id = ${accountId}
  `.then(() => undefined);
}

export function updateTimelineJobAfterError(
  accountId: string,
  errorMsg: string,
  nextRunAt: number,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    UPDATE x_timeline_scrape_jobs SET
      total_errors = total_errors + 1,
      last_run_at = ${now},
      last_error = ${errorMsg},
      next_run_at = ${nextRunAt},
      updated_at = ${now}
    WHERE account_id = ${accountId}
  `.then(() => undefined);
}

export async function insertTimelineTweets(
  accountId: string,
  tweets: TimelineTweetFromPython[],
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  for (const t of tweets) {
    await db`
      INSERT INTO x_scraped_tweets (
        id, account_id, tweet_id, author_username, author_display_name,
        author_verified, author_followers, text, likes, retweets,
        replies, views, bookmarks, quotes, has_media, tweet_created_at,
        scraped_at, source
      ) VALUES (
        ${crypto.randomUUID()}, ${accountId}, ${t.tweet_id}, ${t.author_username},
        ${t.author_display_name}, ${t.author_verified}, ${t.author_followers},
        ${t.text}, ${t.likes}, ${t.retweets}, ${t.replies}, ${t.views},
        ${t.bookmarks}, ${t.quotes}, ${t.has_media}, ${t.tweet_created_at},
        ${now}, ${t.source}
      )
      ON CONFLICT (account_id, tweet_id) DO UPDATE SET
        likes = ${t.likes},
        retweets = ${t.retweets},
        replies = ${t.replies},
        views = ${t.views},
        bookmarks = ${t.bookmarks},
        quotes = ${t.quotes},
        source = ${t.source},
        scraped_at = ${now},
        prev_likes = x_scraped_tweets.likes,
        prev_retweets = x_scraped_tweets.retweets,
        prev_views = x_scraped_tweets.views,
        likes_velocity = CASE
          WHEN x_scraped_tweets.scraped_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(x_scraped_tweets.scraped_at))) > 60
          THEN (${t.likes} - x_scraped_tweets.likes)::REAL
            / (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(x_scraped_tweets.scraped_at))) / 3600.0)
          ELSE x_scraped_tweets.likes_velocity END,
        views_velocity = CASE
          WHEN x_scraped_tweets.scraped_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(x_scraped_tweets.scraped_at))) > 60
          THEN (${t.views} - x_scraped_tweets.views)::REAL
            / (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(x_scraped_tweets.scraped_at))) / 3600.0)
          ELSE x_scraped_tweets.views_velocity END,
        indexed_at = CASE
          WHEN x_scraped_tweets.text IS DISTINCT FROM ${t.text}
          THEN NULL ELSE x_scraped_tweets.indexed_at END
    `;
  }
}

export async function getUnindexedTweets(limit = 200): Promise<
  Array<{
    id: string;
    tweet_id: string;
    author_username: string;
    text: string;
    tweet_created_at: number | null;
    scraped_at: number;
    source: string;
  }>
> {
  const db = getDb();
  const rows = await db`
    SELECT id, tweet_id, author_username, text, tweet_created_at, scraped_at, source
    FROM x_scraped_tweets
    WHERE indexed_at IS NULL AND source IN ('home', 'top_posts')
    ORDER BY scraped_at DESC
    LIMIT ${limit}
  `;
  return rows as never;
}

export async function markTweetsIndexed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE x_scraped_tweets SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export function getAllTimelineTweets(
  limit: number = 50,
  offset: number = 0,
): Promise<
  Array<{
    id: string;
    tweet_id: string;
    author_username: string;
    text: string;
    tweet_created_at: number | null;
    scraped_at: number;
    source: string;
  }>
> {
  const db = getDb();

  return db`
    SELECT id, tweet_id, author_username, text, tweet_created_at, scraped_at, source
    FROM x_scraped_tweets
    WHERE source IN ('home', 'top_posts')
    ORDER BY scraped_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `.then((rows) => rows as never);
}

export function getTimelineTweets(
  accountId: string,
  source?: string,
  limit: number = 100,
): Promise<
  Array<{
    id: string;
    account_id: string;
    tweet_id: string;
    author_username: string;
    author_display_name: string;
    author_verified: boolean;
    author_followers: number;
    text: string;
    likes: number;
    retweets: number;
    replies: number;
    views: number;
    bookmarks: number;
    quotes: number;
    has_media: boolean;
    tweet_created_at: number | null;
    scraped_at: number;
    source: string;
  }>
> {
  const db = getDb();

  if (source) {
    return db`
      SELECT * FROM x_scraped_tweets
      WHERE account_id = ${accountId} AND source = ${source}
      ORDER BY scraped_at DESC
      LIMIT ${limit}
    `.then((rows) => rows as never);
  }

  return db`
    SELECT * FROM x_scraped_tweets
    WHERE account_id = ${accountId} AND source IN ('home', 'top_posts')
    ORDER BY scraped_at DESC
    LIMIT ${limit}
  `.then((rows) => rows as never);
}
