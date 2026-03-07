import { getDb } from "../../store/db";

export interface HNStoryRow {
  id: string;
  rank: number;
  title: string;
  url: string;
  site_label: string;
  points: number;
  author: string;
  age: string;
  comment_count: number;
  hn_url: string;
  feed_type: string;
  first_seen_at: number;
  updated_at: number;
  description: string;
  top_comments_json: string;
}

export async function upsertStories(stories: HNStoryRow[]): Promise<number> {
  if (stories.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const s of stories) {
    await db`
      INSERT INTO hn_stories (
        id, rank, title, url, site_label, points, author, age,
        comment_count, hn_url, feed_type, first_seen_at, updated_at,
        description, top_comments_json
      ) VALUES (
        ${s.id}, ${s.rank}, ${s.title}, ${s.url}, ${s.site_label},
        ${s.points}, ${s.author}, ${s.age}, ${s.comment_count},
        ${s.hn_url}, ${s.feed_type}, ${s.first_seen_at}, ${s.updated_at},
        ${s.description}, ${s.top_comments_json}
      )
      ON CONFLICT (id) DO UPDATE SET
        rank = EXCLUDED.rank,
        title = EXCLUDED.title,
        url = EXCLUDED.url,
        site_label = EXCLUDED.site_label,
        points = EXCLUDED.points,
        author = EXCLUDED.author,
        age = EXCLUDED.age,
        comment_count = EXCLUDED.comment_count,
        hn_url = EXCLUDED.hn_url,
        updated_at = EXCLUDED.updated_at,
        description = EXCLUDED.description,
        top_comments_json = EXCLUDED.top_comments_json,
        indexed_at = CASE
          WHEN hn_stories.description IS DISTINCT FROM EXCLUDED.description
            OR hn_stories.top_comments_json IS DISTINCT FROM EXCLUDED.top_comments_json
          THEN NULL ELSE hn_stories.indexed_at END
    `;
    upserted++;
  }

  return upserted;
}

export async function getUnindexedStories(limit = 200): Promise<HNStoryRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM hn_stories
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as HNStoryRow[];
}

export async function markStoriesIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE hn_stories SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export async function getStories(
  feedType?: string,
  limit = 50,
  offset = 0,
): Promise<HNStoryRow[]> {
  const db = getDb();
  if (feedType) {
    const rows = await db`
      SELECT * FROM hn_stories
      WHERE feed_type = ${feedType}
      ORDER BY updated_at DESC, rank ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as HNStoryRow[];
  }
  const rows = await db`
    SELECT * FROM hn_stories
    ORDER BY updated_at DESC, rank ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as HNStoryRow[];
}
