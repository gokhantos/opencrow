import { getDb } from "../../store/db";

export interface TrendRow {
  readonly id: string;
  readonly title: string;
  readonly traffic_volume: string;
  readonly description: string;
  readonly source: string;
  readonly source_url: string;
  readonly related_queries: string;
  readonly picture_url: string | null;
  readonly news_items_json: string | null;
  readonly geo: string;
  readonly category: string;
  readonly first_seen_at: number;
  readonly updated_at: number;
  readonly indexed_at: number | null;
}

export async function upsertTrends(trends: readonly TrendRow[]): Promise<number> {
  if (trends.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const t of trends) {
    await db`
      INSERT INTO google_trends (
        id, title, traffic_volume, description, source, source_url,
        related_queries, picture_url, news_items_json, geo, category, first_seen_at, updated_at
      ) VALUES (
        ${t.id}, ${t.title}, ${t.traffic_volume}, ${t.description},
        ${t.source}, ${t.source_url}, ${t.related_queries},
        ${t.picture_url ?? null}, ${t.news_items_json ?? null},
        ${t.geo}, ${t.category}, ${t.first_seen_at}, ${t.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        traffic_volume = EXCLUDED.traffic_volume,
        description = EXCLUDED.description,
        source = EXCLUDED.source,
        source_url = EXCLUDED.source_url,
        related_queries = EXCLUDED.related_queries,
        picture_url = EXCLUDED.picture_url,
        news_items_json = EXCLUDED.news_items_json,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }

  return upserted;
}

export async function getTrends(
  category?: string,
  limit = 50,
): Promise<readonly TrendRow[]> {
  const db = getDb();

  if (category) {
    const rows = await db`
      SELECT * FROM google_trends
      WHERE category = ${category}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows as TrendRow[];
  }

  const rows = await db`
    SELECT * FROM google_trends
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  return rows as TrendRow[];
}

export async function getUnindexedTrends(
  limit = 200,
): Promise<readonly TrendRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM google_trends
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as TrendRow[];
}

export async function markTrendsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE google_trends SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}
