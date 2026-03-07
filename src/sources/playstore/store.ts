import { getDb } from "../../store/db";

export interface PlayRankingRow {
  readonly id: string;
  readonly name: string;
  readonly developer: string;
  readonly category: string;
  readonly rank: number;
  readonly list_type: string;
  readonly icon_url: string;
  readonly store_url: string;
  readonly description: string;
  readonly price: string;
  readonly rating: number | null;
  readonly installs: string;
  readonly updated_at: number;
  readonly indexed_at: number | null;
}

export interface PlayReviewRow {
  readonly id: string;
  readonly app_id: string;
  readonly app_name: string;
  readonly author: string;
  readonly rating: number;
  readonly title: string;
  readonly content: string;
  readonly thumbs_up: number;
  readonly version: string;
  readonly first_seen_at: number;
  readonly indexed_at: number | null;
}

export async function upsertRankings(
  rows: readonly PlayRankingRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO playstore_rankings (
        id, name, developer, category, rank, list_type,
        icon_url, store_url, description, price, rating, installs, updated_at
      ) VALUES (
        ${r.id}, ${r.name}, ${r.developer}, ${r.category}, ${r.rank},
        ${r.list_type}, ${r.icon_url}, ${r.store_url}, ${r.description},
        ${r.price}, ${r.rating}, ${r.installs}, ${r.updated_at}
      )
      ON CONFLICT (id, list_type) DO UPDATE SET
        name = EXCLUDED.name,
        developer = EXCLUDED.developer,
        category = EXCLUDED.category,
        rank = EXCLUDED.rank,
        icon_url = EXCLUDED.icon_url,
        store_url = EXCLUDED.store_url,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        rating = EXCLUDED.rating,
        installs = EXCLUDED.installs,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }

  return upserted;
}

export async function upsertReviews(
  rows: readonly PlayReviewRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO playstore_reviews (
        id, app_id, app_name, author, rating, title,
        content, thumbs_up, version, first_seen_at
      ) VALUES (
        ${r.id}, ${r.app_id}, ${r.app_name}, ${r.author}, ${r.rating},
        ${r.title}, ${r.content}, ${r.thumbs_up}, ${r.version}, ${r.first_seen_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        rating = EXCLUDED.rating,
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        thumbs_up = EXCLUDED.thumbs_up,
        version = EXCLUDED.version
    `;
    upserted++;
  }

  return upserted;
}

export async function getRankings(
  listType?: string,
  limit = 50,
): Promise<PlayRankingRow[]> {
  const db = getDb();

  if (listType) {
    const rows = await db`
      SELECT * FROM playstore_rankings
      WHERE list_type = ${listType}
      ORDER BY rank ASC, updated_at DESC
      LIMIT ${limit}
    `;
    return rows as PlayRankingRow[];
  }

  const rows = await db`
    SELECT * FROM playstore_rankings
    ORDER BY list_type, rank ASC, updated_at DESC
    LIMIT ${limit}
  `;
  return rows as PlayRankingRow[];
}

export async function getRankingsByCategory(
  category: string,
  limit = 50,
): Promise<PlayRankingRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM playstore_rankings
    WHERE category ILIKE ${category}
    ORDER BY rank ASC, updated_at DESC
    LIMIT ${limit}
  `;
  return rows as PlayRankingRow[];
}

export async function getLowRatedReviews(
  limit = 50,
): Promise<PlayReviewRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM playstore_reviews
    WHERE rating <= 2
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as PlayReviewRow[];
}

export async function getUnindexedReviews(
  limit = 200,
): Promise<PlayReviewRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM playstore_reviews
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as PlayReviewRow[];
}

export async function markReviewsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE playstore_reviews SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export async function getUnindexedRankings(
  limit = 200,
): Promise<PlayRankingRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM playstore_rankings
    WHERE indexed_at IS NULL AND description != ''
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  return rows as PlayRankingRow[];
}

export async function markRankingsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE playstore_rankings SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}
