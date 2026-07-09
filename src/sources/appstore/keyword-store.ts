import { getDb } from "../../store/db";
import type { GapTrend, KeywordGapProfile, TopApp } from "./keyword-types";

export interface KeywordSeedRow {
  readonly keyword: string;
  readonly genreZone: string;
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline";
}

export interface KeywordScanRow {
  readonly id: number;
  readonly keyword: string;
  readonly store: "app" | "play";
  readonly scannedAt: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly opportunity: number;
  readonly trend: GapTrend;
  readonly topAppReviews: number;
  readonly avgRating: number;
  readonly avgAgeDays: number;
  readonly topApps: readonly TopApp[];
}

/** Raw column shape returned by `SELECT * FROM appstore_keyword_scans`. */
interface KeywordScanDbRow {
  readonly id: number | string;
  readonly keyword: string;
  readonly store: string;
  readonly scanned_at: number | string;
  readonly competitiveness: number | string;
  readonly demand: number | string;
  readonly incumbent_weakness: number | string;
  readonly opportunity: number | string;
  readonly trend: string;
  readonly top_app_reviews: number | string;
  readonly avg_rating: number | string;
  readonly avg_age_days: number | string;
  readonly top_apps: readonly TopApp[];
}

export function rowToScan(row: KeywordScanDbRow): KeywordScanRow {
  return {
    id: Number(row.id),
    keyword: row.keyword,
    store: row.store as "app" | "play",
    scannedAt: Number(row.scanned_at),
    competitiveness: Number(row.competitiveness),
    demand: Number(row.demand),
    incumbentWeakness: Number(row.incumbent_weakness),
    opportunity: Number(row.opportunity),
    trend: row.trend as GapTrend,
    topAppReviews: Number(row.top_app_reviews),
    avgRating: Number(row.avg_rating),
    avgAgeDays: Number(row.avg_age_days),
    topApps: row.top_apps,
  };
}

export async function upsertKeywords(rows: readonly KeywordSeedRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const r of rows) {
    await db`
      INSERT INTO appstore_keywords (keyword, genre_zone, source, active, created_at)
      VALUES (${r.keyword}, ${r.genreZone}, ${r.source}, TRUE, ${now})
      ON CONFLICT (keyword) DO UPDATE SET genre_zone = EXCLUDED.genre_zone
    `;
    n++;
  }
  return n;
}

export async function getStaleKeywords(
  genreZone: string,
  limit: number,
): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE AND genre_zone = ${genreZone}
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return rows.map((r: { keyword: string }) => r.keyword);
}

export async function markScanned(keywords: readonly string[], at: number): Promise<void> {
  if (keywords.length === 0) return;
  const db = getDb();
  await db`UPDATE appstore_keywords SET last_scanned_at = ${at} WHERE keyword IN ${db(keywords)}`;
}

export async function insertScan(p: KeywordGapProfile): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO appstore_keyword_scans (
      keyword, store, scanned_at, competitiveness, demand, incumbent_weakness,
      opportunity, trend, top_app_reviews, avg_rating, avg_age_days, top_apps
    ) VALUES (
      ${p.keyword}, ${p.store}, ${p.scannedAt}, ${p.competitiveness}, ${p.demand},
      ${p.incumbentWeakness}, ${p.opportunity}, ${p.trend}, ${p.topAppReviews},
      ${p.avgRating}, ${p.avgAgeDays}, ${JSON.stringify(p.topApps)}
    )
  `;
}

export async function getLatestScan(
  keyword: string,
  store: "app" | "play" = "app",
): Promise<KeywordScanRow | null> {
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT ON (keyword, store) *
    FROM appstore_keyword_scans
    WHERE keyword = ${keyword} AND store = ${store}
    ORDER BY keyword, store, scanned_at DESC
  `;
  const row = (rows as KeywordScanDbRow[])[0];
  return row ? rowToScan(row) : null;
}

export async function getTopOpportunities(opts: {
  limit: number;
  genreZone?: string;
  trend?: GapTrend;
}): Promise<readonly KeywordScanRow[]> {
  const db = getDb();
  const genreZone = opts.genreZone ?? null;
  const trend = opts.trend ?? null;

  const rows = await db`
    SELECT s.*
    FROM (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    ) s
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE (${genreZone}::text IS NULL OR k.genre_zone = ${genreZone})
      AND (${trend}::text IS NULL OR s.trend = ${trend})
    ORDER BY s.opportunity DESC
    LIMIT ${opts.limit}
  `;
  return (rows as KeywordScanDbRow[]).map(rowToScan);
}

export async function getScanHistory(
  keyword: string,
  limit: number,
): Promise<readonly KeywordScanRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM appstore_keyword_scans
    WHERE keyword = ${keyword}
    ORDER BY scanned_at DESC
    LIMIT ${limit}
  `;
  return (rows as KeywordScanDbRow[]).map(rowToScan);
}
