import { getDb } from "../../store/db";
import type { GapTrend, KeywordGapProfile, TopApp } from "./keyword-types";

/**
 * Bun's SQL driver returns `jsonb` columns as raw JSON strings, not parsed
 * values. Mirrors `parseJson` in `src/pipelines/store.ts`: if already parsed
 * (array/object), use as-is; if a string, parse it; on failure, fall back
 * defensively rather than throwing.
 */
function parseJson<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

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

/**
 * `KeywordScanRow` augmented with the keyword corpus's `created_at`/`source`
 * (from `appstore_keywords`, joined by `getTopOpportunities`). Both are
 * `null` when the scan has no corresponding corpus row (shouldn't happen in
 * practice, since scans are only ever inserted for corpus keywords, but the
 * LEFT JOIN makes it possible) rather than surfaced as an unusable zero/"".
 */
export interface OpportunityRow extends KeywordScanRow {
  readonly firstFoundAt: number | null;
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | null;
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
  /** Raw jsonb value — Bun's SQL driver returns this as a JSON string, not a parsed array. */
  readonly top_apps: unknown;
}

/** Raw column shape returned by `getTopOpportunities`'s scan+corpus join. */
interface OpportunityDbRow extends KeywordScanDbRow {
  readonly keyword_created_at: number | string | null;
  readonly keyword_source: string | null;
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
    topApps: parseJson<readonly TopApp[]>(row.top_apps, []),
  };
}

export function rowToOpportunity(row: OpportunityDbRow): OpportunityRow {
  return {
    ...rowToScan(row),
    firstFoundAt:
      row.keyword_created_at === null || row.keyword_created_at === undefined
        ? null
        : Number(row.keyword_created_at),
    source: (row.keyword_source as OpportunityRow["source"]) ?? null,
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

/**
 * Stalest-first slice across the ENTIRE active corpus (no genre-zone
 * filter). Backs the timer-driven keyword-gap sweep, which scans the
 * globally stalest `keywordsPerSweep` keywords every cycle instead of
 * rotating through one zone per day.
 */
export async function getStaleKeywordsAcrossZones(limit: number): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE
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
}): Promise<readonly OpportunityRow[]> {
  const db = getDb();
  const genreZone = opts.genreZone ?? null;
  const trend = opts.trend ?? null;

  const rows = await db`
    SELECT s.*, k.created_at AS keyword_created_at, k.source AS keyword_source
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
  return (rows as OpportunityDbRow[]).map(rowToOpportunity);
}

/**
 * Returns the epoch-second timestamp of the most recent scan among keywords
 * belonging to `genreZone`, or `null` if the zone has no scans yet. Used to
 * gate the keyword-gap sweep to `scanIntervalMs` cadence instead of running
 * on every scraper tick.
 */
export async function getMostRecentScanAt(genreZone: string): Promise<number | null> {
  const db = getDb();
  const rows = await db`
    SELECT MAX(s.scanned_at) AS last
    FROM appstore_keyword_scans s
    JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE k.genre_zone = ${genreZone}
  `;
  const last = (rows as ReadonlyArray<{ last: number | string | null }>)[0]?.last;
  return last === null || last === undefined ? null : Number(last);
}

/**
 * Count of keyword scans recorded at or after `epochSeconds`. Backs the
 * `dailyKeywordBudget` rolling-24h safety ceiling: the sweep checks this
 * against `now - 86_400` before spending more lookups.
 */
export async function countScansSince(epochSeconds: number): Promise<number> {
  const db = getDb();
  const rows = await db`
    SELECT count(*) AS count FROM appstore_keyword_scans WHERE scanned_at >= ${epochSeconds}
  `;
  const count = (rows as ReadonlyArray<{ count: number | string }>)[0]?.count;
  return count === undefined ? 0 : Number(count);
}

/**
 * Latest scan per keyword, joined to its corpus row for `genre_zone`,
 * filtered to `opportunity >= minOpportunity` and ordered richest-first.
 * Used to seed autocomplete expansion from proven high-opportunity
 * "winners" — an inner join means a scan with no corresponding corpus row
 * (shouldn't happen in practice) is silently excluded rather than surfaced
 * with an unusable null zone.
 */
export async function getWinnerKeywords(
  minOpportunity: number,
  limit: number,
): Promise<readonly { keyword: string; genreZone: string }[]> {
  const db = getDb();
  const rows = await db`
    SELECT s.keyword, k.genre_zone
    FROM (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    ) s
    JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE s.opportunity >= ${minOpportunity}
    ORDER BY s.opportunity DESC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string; genre_zone: string }>).map((r) => ({
    keyword: r.keyword,
    genreZone: r.genre_zone,
  }));
}

/**
 * A diverse, zone-spread sample of the active corpus: the stalest
 * (least-recently-scanned — NULLS FIRST so never-scanned keywords sort
 * first) keyword per genre zone, then each zone's second-stalest, and so
 * on — interleaved round-robin across zones rather than exhausting one
 * zone before moving to the next. Paired with `getWinnerKeywords` in
 * `getExpansionSeeds` so autocomplete corpus expansion isn't purely
 * winner-driven: a keyword that has never posted a high-opportunity scan
 * (or hasn't been scanned at all) still gets a turn to seed expansion,
 * which keeps under-covered zones from starving (anti rich-get-richer
 * monoculture).
 */
export async function getDiverseZoneSample(
  limit: number,
): Promise<readonly { keyword: string; genreZone: string }[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = await db`
    WITH ranked AS (
      SELECT
        keyword,
        genre_zone,
        ROW_NUMBER() OVER (
          PARTITION BY genre_zone
          ORDER BY last_scanned_at ASC NULLS FIRST, keyword ASC
        ) AS rn
      FROM appstore_keywords
      WHERE active = TRUE
    )
    SELECT keyword, genre_zone
    FROM ranked
    ORDER BY rn ASC, genre_zone ASC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string; genre_zone: string }>).map((r) => ({
    keyword: r.keyword,
    genreZone: r.genre_zone,
  }));
}

/**
 * Broadened seed set for autocomplete corpus expansion: up to
 * `winnerLimit` current high-opportunity "winners" (`getWinnerKeywords`)
 * PLUS up to `diverseLimit` round-robin picks spread across genre zones
 * (`getDiverseZoneSample`). Winners take priority on overlap — a diverse
 * pick that duplicates an already-selected winner keyword is dropped
 * rather than double-counted — so the combined, deduped list never exceeds
 * `winnerLimit + diverseLimit` entries. Both limits are caller-supplied so
 * behavior stays deterministic and testable against a fixed DB state.
 */
export async function getExpansionSeeds(opts: {
  readonly minOpportunity: number;
  readonly winnerLimit: number;
  readonly diverseLimit: number;
}): Promise<readonly { keyword: string; genreZone: string }[]> {
  const [winners, diverse] = await Promise.all([
    getWinnerKeywords(opts.minOpportunity, opts.winnerLimit),
    getDiverseZoneSample(opts.diverseLimit),
  ]);

  const seen = new Set(winners.map((w) => w.keyword));
  const combined = [...winners];
  for (const pick of diverse) {
    if (seen.has(pick.keyword)) continue;
    seen.add(pick.keyword);
    combined.push(pick);
  }
  return combined;
}

/**
 * Returns the subset of `keywords` that already exist in the corpus.
 * Used by autocomplete expansion to avoid double-counting an
 * `upsertKeywords` call against an already-present keyword as "new".
 */
export async function keywordsExist(keywords: readonly string[]): Promise<ReadonlySet<string>> {
  if (keywords.length === 0) return new Set();
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords WHERE keyword IN ${db(keywords)}
  `;
  return new Set((rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword));
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

/** First-found timestamp + source for one keyword, from `appstore_keywords`. */
export interface KeywordMeta {
  readonly firstFoundAt: number;
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline";
}

/**
 * Corpus metadata (`created_at`, `source`) for a single keyword — backs the
 * `GET /appstore/opportunities/:keyword` history endpoint's `meta`, so the
 * dashboard can mark a keyword's "first found" date and origin alongside its
 * scan-history chart. Returns `null` if the keyword has no corpus row (e.g.
 * it was never seeded/discovered, only ever scanned directly).
 */
export async function getKeywordMeta(keyword: string): Promise<KeywordMeta | null> {
  const db = getDb();
  const rows = await db`
    SELECT created_at, source FROM appstore_keywords WHERE keyword = ${keyword}
  `;
  const row = (rows as ReadonlyArray<{ created_at: number | string; source: string }>)[0];
  if (!row) return null;
  return {
    firstFoundAt: Number(row.created_at),
    source: row.source as KeywordMeta["source"],
  };
}
