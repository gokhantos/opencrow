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

export interface PlayAppRow {
  readonly id: string;
  readonly name: string;
  readonly developer: string;
  readonly category: string;
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

export async function upsertApps(rows: readonly PlayAppRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO playstore_apps (
        id, name, developer, category,
        icon_url, store_url, description, price, rating, installs, updated_at
      ) VALUES (
        ${r.id}, ${r.name}, ${r.developer}, ${r.category},
        ${r.icon_url}, ${r.store_url}, ${r.description},
        ${r.price}, ${r.rating}, ${r.installs}, ${r.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        developer = EXCLUDED.developer,
        category = EXCLUDED.category,
        icon_url = EXCLUDED.icon_url,
        store_url = EXCLUDED.store_url,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        rating = EXCLUDED.rating,
        installs = EXCLUDED.installs,
        updated_at = EXCLUDED.updated_at,
        indexed_at = CASE
          WHEN playstore_apps.description != EXCLUDED.description THEN NULL
          ELSE playstore_apps.indexed_at
        END
    `;
    upserted++;
  }

  return upserted;
}

export async function insertRankingHistory(
  rows: ReadonlyArray<{
    app_id: string;
    list_type: string;
    rank: number;
    scraped_at: number;
  }>,
): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let inserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO playstore_ranking_history (app_id, list_type, rank, scraped_at)
      VALUES (${r.app_id}, ${r.list_type}, ${r.rank}, ${r.scraped_at})
    `;
    inserted++;
  }

  return inserted;
}

export async function upsertRankings(
  rows: readonly PlayRankingRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const appRows: PlayAppRow[] = rows.map(({ rank: _rank, list_type: _lt, ...rest }) => rest);
  await upsertApps(appRows);

  const now = Math.floor(Date.now() / 1000);
  const historyRows = rows.map((r) => ({
    app_id: r.id,
    list_type: r.list_type,
    rank: r.rank,
    scraped_at: now,
  }));
  await insertRankingHistory(historyRows);

  return rows.length;
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
    const pattern = `${listType}%`;
    const rows = await db`
      SELECT a.*, r.rank, r.list_type
      FROM playstore_apps a
      JOIN (
        SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
        FROM playstore_ranking_history
        ORDER BY app_id, list_type, scraped_at DESC
      ) r ON a.id = r.app_id
      WHERE r.list_type LIKE ${pattern} AND r.list_type != 'discovered'
      ORDER BY r.rank ASC
      LIMIT ${limit}
    `;
    return rows as PlayRankingRow[];
  }

  const rows = await db`
    SELECT a.*, r.rank, r.list_type
    FROM playstore_apps a
    JOIN (
      SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
      FROM playstore_ranking_history
      ORDER BY app_id, list_type, scraped_at DESC
    ) r ON a.id = r.app_id
    WHERE r.list_type != 'discovered'
    ORDER BY r.rank ASC
    LIMIT ${limit}
  `;
  return rows as PlayRankingRow[];
}

export async function getDiscoveredApps(
  limit = 50,
): Promise<PlayRankingRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT a.*, r.rank, r.list_type
    FROM playstore_apps a
    JOIN (
      SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
      FROM playstore_ranking_history
      ORDER BY app_id, list_type, scraped_at DESC
    ) r ON a.id = r.app_id
    WHERE r.list_type = 'discovered'
    ORDER BY r.rank ASC
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
    SELECT a.*, r.rank, r.list_type
    FROM playstore_apps a
    JOIN (
      SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
      FROM playstore_ranking_history
      ORDER BY app_id, list_type, scraped_at DESC
    ) r ON a.id = r.app_id
    WHERE a.category ILIKE ${category}
    ORDER BY r.rank ASC
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

export async function getUnindexedRankings(limit = 200): Promise<PlayAppRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM playstore_apps
    WHERE indexed_at IS NULL
    LIMIT ${limit}
  `;
  return rows as PlayAppRow[];
}

export async function getAllKnownAppIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db`SELECT DISTINCT id FROM playstore_apps`;
  return new Set((rows as Array<{ id: string }>).map((r) => r.id));
}

export async function markRankingsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE playstore_apps SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}
