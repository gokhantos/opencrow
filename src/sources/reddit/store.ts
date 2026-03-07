import { getDb } from "../../store/db";

export interface RedditPostRow {
  id: string;
  subreddit: string;
  title: string;
  url: string;
  selftext: string;
  author: string;
  score: number;
  num_comments: number;
  permalink: string;
  post_type: string;
  feed_source: string;
  domain: string;
  upvote_ratio: number;
  created_utc: number;
  first_seen_at: number;
  updated_at: number;
  top_comments_json: string | null;
  flair: string | null;
  thumbnail_url: string | null;
  prev_score?: number | null;
  prev_num_comments?: number | null;
  score_velocity?: number | null;
  comments_velocity?: number | null;
}

export interface RedditAccountRow {
  id: string;
  label: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  cookies_json: string;
  status: string;
  verified_at: number | null;
  error_message: string | null;
  last_scraped_at: number | null;
  last_scrape_count: number | null;
  created_at: number;
  updated_at: number;
}

export async function upsertPosts(posts: RedditPostRow[]): Promise<number> {
  if (posts.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const p of posts) {
    await db`
      INSERT INTO reddit_posts (
        id, subreddit, title, url, selftext, author, score, num_comments,
        permalink, post_type, feed_source, domain, upvote_ratio,
        created_utc, first_seen_at, updated_at,
        top_comments_json, flair, thumbnail_url
      ) VALUES (
        ${p.id}, ${p.subreddit}, ${p.title}, ${p.url}, ${p.selftext},
        ${p.author}, ${p.score}, ${p.num_comments}, ${p.permalink},
        ${p.post_type}, ${p.feed_source}, ${p.domain}, ${p.upvote_ratio},
        ${p.created_utc}, ${p.first_seen_at}, ${p.updated_at},
        ${p.top_comments_json ?? null}, ${p.flair ?? null}, ${p.thumbnail_url ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        score = EXCLUDED.score,
        num_comments = EXCLUDED.num_comments,
        upvote_ratio = EXCLUDED.upvote_ratio,
        updated_at = EXCLUDED.updated_at,
        top_comments_json = COALESCE(EXCLUDED.top_comments_json, reddit_posts.top_comments_json),
        flair = COALESCE(EXCLUDED.flair, reddit_posts.flair),
        thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, reddit_posts.thumbnail_url),
        prev_score = reddit_posts.score,
        prev_num_comments = reddit_posts.num_comments,
        score_velocity = CASE
          WHEN reddit_posts.updated_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(reddit_posts.updated_at))) > 60
          THEN (EXCLUDED.score - reddit_posts.score)::REAL
            / (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(reddit_posts.updated_at))) / 3600.0)
          ELSE reddit_posts.score_velocity END,
        comments_velocity = CASE
          WHEN reddit_posts.updated_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(reddit_posts.updated_at))) > 60
          THEN (EXCLUDED.num_comments - reddit_posts.num_comments)::REAL
            / (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(reddit_posts.updated_at))) / 3600.0)
          ELSE reddit_posts.comments_velocity END,
        indexed_at = CASE
          WHEN reddit_posts.top_comments_json IS DISTINCT FROM
            COALESCE(EXCLUDED.top_comments_json, reddit_posts.top_comments_json)
          THEN NULL ELSE reddit_posts.indexed_at END
    `;
    upserted++;
  }

  return upserted;
}

export async function getPosts(
  subreddit?: string,
  limit = 50,
  offset = 0,
): Promise<RedditPostRow[]> {
  const db = getDb();
  if (subreddit) {
    const rows = await db`
      SELECT * FROM reddit_posts
      WHERE subreddit = ${subreddit}
      ORDER BY updated_at DESC, score DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as RedditPostRow[];
  }
  const rows = await db`
    SELECT * FROM reddit_posts
    ORDER BY updated_at DESC, score DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as RedditPostRow[];
}

export async function getActiveAccounts(): Promise<RedditAccountRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM reddit_accounts
    WHERE status = 'active'
    ORDER BY created_at ASC
  `;
  return rows as RedditAccountRow[];
}

export async function getUnindexedPosts(limit = 200): Promise<RedditPostRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM reddit_posts
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as RedditPostRow[];
}

export async function markPostsIndexed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE reddit_posts SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export async function updateLastScrape(
  accountId: string,
  count: number,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE reddit_accounts SET
      last_scraped_at = ${now},
      last_scrape_count = ${count},
      updated_at = ${now}
    WHERE id = ${accountId}
  `;
}
