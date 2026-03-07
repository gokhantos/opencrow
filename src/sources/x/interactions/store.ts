import { getDb } from "../../../store/db";
import type {
  AutolikeJob,
  ScrapedTweet,
  LikedTweet,
  ScrapedTweetFromPython,
  LikedTweetFromPython,
} from "./types";

export function getAutolikeJob(accountId: string): Promise<AutolikeJob | null> {
  const db = getDb();
  return db`
    SELECT * FROM x_autolike_jobs WHERE account_id = ${accountId}
  `.then((rows) => (rows[0] as AutolikeJob) ?? null);
}

export function upsertAutolikeJob(
  accountId: string,
  intervalMinutes: number,
  maxLikesPerRun: number,
  status: "running" | "stopped",
  nextRunAt: number | null,
  languages: string | null = null,
): Promise<AutolikeJob> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  return db`
    INSERT INTO x_autolike_jobs (id, account_id, interval_minutes, max_likes_per_run, languages, status, next_run_at, created_at, updated_at)
    VALUES (${id}, ${accountId}, ${intervalMinutes}, ${maxLikesPerRun}, ${languages}, ${status}, ${nextRunAt}, ${now}, ${now})
    ON CONFLICT (account_id) DO UPDATE SET
      interval_minutes = ${intervalMinutes},
      max_likes_per_run = ${maxLikesPerRun},
      languages = ${languages},
      status = ${status},
      next_run_at = ${nextRunAt},
      updated_at = ${now}
    RETURNING *
  `.then((rows) => rows[0] as AutolikeJob);
}

export function updateJobAfterSuccess(
  accountId: string,
  scrapedCount: number,
  likedCount: number,
  nextRunAt: number,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    UPDATE x_autolike_jobs SET
      total_scraped = total_scraped + ${scrapedCount},
      total_liked = total_liked + ${likedCount},
      last_run_at = ${now},
      last_error = NULL,
      next_run_at = ${nextRunAt},
      updated_at = ${now}
    WHERE account_id = ${accountId}
  `.then(() => undefined);
}

export function updateJobAfterError(
  accountId: string,
  errorMsg: string,
  nextRunAt: number,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    UPDATE x_autolike_jobs SET
      total_errors = total_errors + 1,
      last_run_at = ${now},
      last_error = ${errorMsg},
      next_run_at = ${nextRunAt},
      updated_at = ${now}
    WHERE account_id = ${accountId}
  `.then(() => undefined);
}

export function stopAutolikeJob(accountId: string): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    UPDATE x_autolike_jobs SET
      status = 'stopped',
      next_run_at = NULL,
      updated_at = ${now}
    WHERE account_id = ${accountId}
  `.then(() => undefined);
}

export function getDueAutolikeJobs(): Promise<AutolikeJob[]> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  return db`
    SELECT * FROM x_autolike_jobs
    WHERE status = 'running' AND next_run_at <= ${now}
  `.then((rows) => rows as AutolikeJob[]);
}

export async function insertScrapedTweets(
  accountId: string,
  tweets: ScrapedTweetFromPython[],
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  for (const t of tweets) {
    await db`
      INSERT INTO x_scraped_tweets (
        id, account_id, tweet_id, author_username, author_display_name,
        author_verified, author_followers, text, likes, retweets,
        replies, views, bookmarks, quotes, has_media, tweet_created_at, scraped_at
      ) VALUES (
        ${crypto.randomUUID()}, ${accountId}, ${t.tweet_id}, ${t.author_username},
        ${t.author_display_name}, ${t.author_verified}, ${t.author_followers},
        ${t.text}, ${t.likes}, ${t.retweets}, ${t.replies}, ${t.views},
        ${t.bookmarks}, ${t.quotes}, ${t.has_media}, ${t.tweet_created_at}, ${now}
      )
      ON CONFLICT (account_id, tweet_id) DO UPDATE SET
        likes = ${t.likes},
        retweets = ${t.retweets},
        replies = ${t.replies},
        views = ${t.views},
        bookmarks = ${t.bookmarks},
        quotes = ${t.quotes},
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

export async function insertLikedTweets(
  accountId: string,
  tweets: LikedTweetFromPython[],
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  for (const t of tweets) {
    await db`
      INSERT INTO x_liked_tweets (
        id, account_id, tweet_id, author_username, text,
        likes, retweets, views, liked_at
      ) VALUES (
        ${crypto.randomUUID()}, ${accountId}, ${t.tweet_id},
        ${t.author_username}, ${t.text}, ${t.likes},
        ${t.retweets}, ${t.views}, ${now}
      )
      ON CONFLICT (account_id, tweet_id) DO NOTHING
    `;
  }
}

export function getLikedTweetIds(accountId: string): Promise<string[]> {
  const db = getDb();

  return db`
    SELECT tweet_id FROM x_liked_tweets WHERE account_id = ${accountId}
  `.then((rows) => rows.map((r: any) => (r as { tweet_id: string }).tweet_id));
}

export function getScrapedTweets(
  accountId: string,
  limit: number = 100,
): Promise<ScrapedTweet[]> {
  const db = getDb();

  return db`
    SELECT * FROM x_scraped_tweets
    WHERE account_id = ${accountId}
    ORDER BY scraped_at DESC
    LIMIT ${limit}
  `.then((rows) => rows as ScrapedTweet[]);
}

export function getLikedTweets(
  accountId: string,
  limit: number = 100,
): Promise<LikedTweet[]> {
  const db = getDb();

  return db`
    SELECT * FROM x_liked_tweets
    WHERE account_id = ${accountId}
    ORDER BY liked_at DESC
    LIMIT ${limit}
  `.then((rows) => rows as LikedTweet[]);
}

export function getAccountCredentials(
  accountId: string,
): Promise<{ auth_token: string; ct0: string } | null> {
  const db = getDb();

  return db`
    SELECT auth_token, ct0 FROM x_accounts
    WHERE id = ${accountId} AND status = 'active'
  `.then((rows) =>
    rows[0] ? (rows[0] as { auth_token: string; ct0: string }) : null,
  );
}
