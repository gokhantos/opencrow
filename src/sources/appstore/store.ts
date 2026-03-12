import { getDb } from "../../store/db";

export interface AppRankingRow {
  readonly id: string;
  readonly name: string;
  readonly artist: string;
  readonly category: string;
  readonly rank: number;
  readonly list_type: string;
  readonly icon_url: string;
  readonly store_url: string;
  readonly description: string;
  readonly price: string;
  readonly bundle_id: string;
  readonly release_date: string;
  readonly updated_at: number;
  readonly indexed_at: number | null;
}

export interface AppRow {
  readonly id: string;
  readonly name: string;
  readonly artist: string;
  readonly category: string;
  readonly icon_url: string;
  readonly store_url: string;
  readonly description: string;
  readonly price: string;
  readonly bundle_id: string;
  readonly release_date: string;
  readonly updated_at: number;
  readonly indexed_at: number | null;
}

export interface AppReviewRow {
  id: string;
  app_id: string;
  app_name: string;
  author: string;
  rating: number;
  title: string;
  content: string;
  version: string;
  first_seen_at: number;
  indexed_at: number | null;
}

export async function upsertApps(rows: readonly AppRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO appstore_apps (
        id, name, artist, category,
        icon_url, store_url, description, price, bundle_id, release_date, updated_at
      ) VALUES (
        ${r.id}, ${r.name}, ${r.artist}, ${r.category},
        ${r.icon_url}, ${r.store_url}, ${r.description},
        ${r.price}, ${r.bundle_id}, ${r.release_date}, ${r.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        artist = EXCLUDED.artist,
        category = EXCLUDED.category,
        icon_url = EXCLUDED.icon_url,
        store_url = EXCLUDED.store_url,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        bundle_id = EXCLUDED.bundle_id,
        release_date = EXCLUDED.release_date,
        updated_at = EXCLUDED.updated_at,
        indexed_at = CASE
          WHEN appstore_apps.description != EXCLUDED.description THEN NULL
          ELSE appstore_apps.indexed_at
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
      INSERT INTO appstore_ranking_history (app_id, list_type, rank, scraped_at)
      VALUES (${r.app_id}, ${r.list_type}, ${r.rank}, ${r.scraped_at})
    `;
    inserted++;
  }

  return inserted;
}

export async function upsertRankings(
  rows: readonly AppRankingRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const appRows: AppRow[] = rows.map(({ rank: _rank, list_type: _lt, ...rest }) => rest);
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
  rows: readonly AppReviewRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO appstore_reviews (
        id, app_id, app_name, author, rating, title,
        content, version, first_seen_at
      ) VALUES (
        ${r.id}, ${r.app_id}, ${r.app_name}, ${r.author}, ${r.rating},
        ${r.title}, ${r.content}, ${r.version}, ${r.first_seen_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        rating = EXCLUDED.rating,
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        version = EXCLUDED.version
    `;
    upserted++;
  }

  return upserted;
}

export async function getRankings(
  listType?: string,
  limit = 50,
): Promise<AppRankingRow[]> {
  const db = getDb();

  if (listType) {
    const pattern = `${listType}%`;
    const rows = await db`
      SELECT a.*, r.rank, r.list_type
      FROM appstore_apps a
      JOIN (
        SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
        FROM appstore_ranking_history
        ORDER BY app_id, list_type, scraped_at DESC
      ) r ON a.id = r.app_id
      WHERE r.list_type LIKE ${pattern} AND r.list_type != 'discovered'
      ORDER BY r.rank ASC
      LIMIT ${limit}
    `;
    return rows as AppRankingRow[];
  }

  const rows = await db`
    SELECT a.*, r.rank, r.list_type
    FROM appstore_apps a
    JOIN (
      SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
      FROM appstore_ranking_history
      ORDER BY app_id, list_type, scraped_at DESC
    ) r ON a.id = r.app_id
    WHERE r.list_type != 'discovered'
    ORDER BY r.rank ASC
    LIMIT ${limit}
  `;
  return rows as AppRankingRow[];
}

export async function getDiscoveredApps(
  limit = 50,
): Promise<AppRankingRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT a.*, r.rank, r.list_type
    FROM appstore_apps a
    JOIN (
      SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
      FROM appstore_ranking_history
      ORDER BY app_id, list_type, scraped_at DESC
    ) r ON a.id = r.app_id
    WHERE r.list_type = 'discovered'
    ORDER BY r.rank ASC
    LIMIT ${limit}
  `;
  return rows as AppRankingRow[];
}

export async function getRankingsByCategory(
  category: string,
  limit = 50,
): Promise<AppRankingRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT a.*, r.rank, r.list_type
    FROM appstore_apps a
    JOIN (
      SELECT DISTINCT ON (app_id, list_type) app_id, list_type, rank
      FROM appstore_ranking_history
      ORDER BY app_id, list_type, scraped_at DESC
    ) r ON a.id = r.app_id
    WHERE a.category ILIKE ${category}
    ORDER BY r.rank ASC
    LIMIT ${limit}
  `;
  return rows as AppRankingRow[];
}

export async function getLowRatedReviews(
  limit = 50,
): Promise<AppReviewRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM appstore_reviews
    WHERE rating <= 2
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as AppReviewRow[];
}

export async function getUnindexedReviews(
  limit = 200,
): Promise<AppReviewRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM appstore_reviews
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as AppReviewRow[];
}

export async function markReviewsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE appstore_reviews SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export async function getUnindexedRankings(limit = 200): Promise<AppRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM appstore_apps
    WHERE indexed_at IS NULL
    LIMIT ${limit}
  `;
  return rows as AppRow[];
}

export async function getAllKnownAppIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db`SELECT DISTINCT id FROM appstore_apps`;
  return new Set((rows as Array<{ id: string }>).map((r) => r.id));
}

export async function getDiscoveredAppIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT app_id FROM appstore_ranking_history WHERE list_type = 'discovered'
  `;
  return new Set((rows as Array<{ app_id: string }>).map((r) => r.app_id));
}

export async function markRankingsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE appstore_apps SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}
