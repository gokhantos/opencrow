import { getDb } from "../../store/db";
import { JUNK_KEYWORDS } from "./keyword-junk";
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
  // "autocomplete" is retired (Apple's MZSearchHints endpoint now just echoes
  // the query — see the deleted keyword-autocomplete.ts) but kept in the
  // union since historical rows still carry it. "mined" is the current
  // corpus-discovery source: candidates extracted from scraped App Store
  // ranking data (see keyword-miner.ts).
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | "mined";
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
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | "mined" | null;
  /**
   * MAX(opportunity) over this keyword's entire scan history (all stores).
   * Backs the "peak" leaderboard sort — a keyword whose latest scan has
   * collapsed to near-zero demand can still be found by how good it once
   * scored. Falls back to the latest-scan `opportunity` in the (expected
   * never to happen in practice) case the peak CTE has no matching row.
   */
  readonly peakOpportunity: number;
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
  readonly peak_opportunity: number | string | null;
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
    peakOpportunity:
      row.peak_opportunity === null || row.peak_opportunity === undefined
        ? Number(row.opportunity)
        : Number(row.peak_opportunity),
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

/**
 * Full-column sort keys the `GET /appstore/opportunities` dashboard table can
 * sort by. Each maps to a column on `s`, the DISTINCT-ON (keyword, store)
 * latest-scan subquery aliased in `getTopOpportunities` — see
 * `SORT_COLUMNS`.
 */
export type SortKey =
  | "keyword"
  | "store"
  | "opportunity"
  | "competitiveness"
  | "demand"
  | "incumbentWeakness"
  | "trend"
  | "topAppReviews"
  | "avgRating"
  | "avgAgeDays";

/** Every valid `SortKey`, for building the Zod enum at the route boundary. */
export const SORT_KEYS = [
  "keyword",
  "store",
  "opportunity",
  "competitiveness",
  "demand",
  "incumbentWeakness",
  "trend",
  "topAppReviews",
  "avgRating",
  "avgAgeDays",
] as const satisfies readonly SortKey[];

/**
 * Whitelist mapping each `SortKey` to its literal SQL column on subquery
 * alias `s` (see `getTopOpportunities`). This is the ONLY place a sort key
 * becomes SQL text: Bun.sql tagged templates parameterize VALUES, not
 * identifiers, so an ORDER BY column can never be interpolated as a normal
 * `${}` placeholder. Caller-supplied `sort`/`dir` only ever select a branch
 * of this frozen constant via `buildOrderByClause` — they never reach SQL
 * text directly, closing off any injection surface even though `sort` is
 * already narrowed to the `SortKey` union by Zod at the route boundary.
 */
const SORT_COLUMNS: Readonly<Record<SortKey, string>> = Object.freeze({
  keyword: "s.keyword",
  store: "s.store",
  opportunity: "s.opportunity",
  competitiveness: "s.competitiveness",
  demand: "s.demand",
  incumbentWeakness: "s.incumbent_weakness",
  trend: "s.trend",
  topAppReviews: "s.top_app_reviews",
  avgRating: "s.avg_rating",
  avgAgeDays: "s.avg_age_days",
});

/**
 * Builds the ORDER BY fragment for `getTopOpportunities`: the whitelisted
 * sort column in the requested direction, then a deterministic
 * `keyword, store` tiebreaker so pagination stays stable across pages even
 * when many rows share the same sort-column value (e.g. many keywords tied
 * on `trend`).
 */
function buildOrderByClause(sort: SortKey, dir: "asc" | "desc"): string {
  const column = SORT_COLUMNS[sort];
  const direction = dir === "asc" ? "ASC" : "DESC";
  return `${column} ${direction} NULLS LAST, s.keyword ASC, s.store ASC`;
}

interface OpportunityFilters {
  readonly genreZone: string | null;
  readonly trend: GapTrend | null;
  readonly minDemand: number | null;
  readonly maxCompetitiveness: number | null;
  readonly minIncumbentWeakness: number | null;
  readonly minOpportunity: number | null;
  readonly hideJunk: boolean;
}

/**
 * Builds the shared WHERE-condition fragment for both `getTopOpportunities`'s
 * data query and `countFilteredOpportunities`'s count query, so the two can
 * never drift out of sync (a mismatch would make `total` lie about the
 * actual filtered page count). Every numeric/trend/zone filter is a
 * NULL-guarded `${}` value placeholder — omitted filters (`null`) are true
 * no-ops, never string-interpolated.
 *
 * The `hideJunk` branch drops a row when its ENTIRE (trimmed, lowercased)
 * keyword is a sole generic word from `JUNK_KEYWORDS` (bound as a `text[]`
 * array parameter via `db.array`, never interpolated), OR the trimmed
 * keyword is under 3 characters, OR the keyword is purely
 * numeric/punctuation/whitespace. A multi-word keyword survives even if one
 * token is generic (e.g. "budget planner" is kept) — only a keyword that IS
 * (whole, trimmed) a stoplist entry is junk.
 */
function buildFilterClause(db: ReturnType<typeof getDb>, filters: OpportunityFilters) {
  return db`
    (${filters.genreZone}::text IS NULL OR k.genre_zone = ${filters.genreZone})
    AND (${filters.trend}::text IS NULL OR s.trend = ${filters.trend})
    AND (${filters.minDemand}::numeric IS NULL OR s.demand >= ${filters.minDemand})
    AND (
      ${filters.maxCompetitiveness}::numeric IS NULL
      OR s.competitiveness <= ${filters.maxCompetitiveness}
    )
    AND (
      ${filters.minIncumbentWeakness}::numeric IS NULL
      OR s.incumbent_weakness >= ${filters.minIncumbentWeakness}
    )
    AND (${filters.minOpportunity}::numeric IS NULL OR s.opportunity >= ${filters.minOpportunity})
    AND (
      ${filters.hideJunk} = FALSE
      OR (
        lower(btrim(s.keyword)) <> ALL(${db.array([...JUNK_KEYWORDS], "text")})
        AND char_length(btrim(s.keyword)) >= 3
        AND s.keyword !~ '^[0-9[:punct:][:space:]]+$'
      )
    )
  `;
}

/**
 * Total count of (keyword, store) pairs matching the filters, independent of
 * pagination — backs `meta.total` so the dashboard can page through the
 * whole corpus rather than just the returned slice. Counts the same
 * DISTINCT-ON (keyword, store) latest-scan set that `getTopOpportunities`
 * pages through, applying the identical `buildFilterClause` fragment, so
 * `total` always matches the filtered result-set size before `limit`/`offset`.
 */
async function countFilteredOpportunities(filters: OpportunityFilters): Promise<number> {
  const db = getDb();
  const rows = await db`
    WITH s AS (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    )
    SELECT count(*) AS count
    FROM s
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE ${buildFilterClause(db, filters)}
  `;
  const count = (rows as ReadonlyArray<{ count: number | string }>)[0]?.count;
  return count === undefined ? 0 : Number(count);
}

export interface GetTopOpportunitiesOptions {
  readonly limit: number;
  readonly offset?: number;
  /** Column to sort by. Default "opportunity". */
  readonly sort?: SortKey;
  /** Sort direction. Default "desc". */
  readonly dir?: "asc" | "desc";
  readonly genreZone?: string;
  readonly trend?: GapTrend;
  /** Only include rows whose latest-scan `demand` is >= this value. */
  readonly minDemand?: number;
  /** Only include rows whose latest-scan `competitiveness` is <= this value. */
  readonly maxCompetitiveness?: number;
  /** Only include rows whose latest-scan `incumbentWeakness` is >= this value. */
  readonly minIncumbentWeakness?: number;
  /** Only include rows whose latest-scan `opportunity` is >= this value. */
  readonly minOpportunity?: number;
  /**
   * When true, drop junk rows: sole-generic-word keywords (see
   * `JUNK_KEYWORDS`), keywords under 3 characters, and purely
   * numeric/punctuation/whitespace keywords. Default false (no suppression).
   */
  readonly hideJunk?: boolean;
}

export interface GetTopOpportunitiesResult {
  readonly rows: readonly OpportunityRow[];
  /** Count of (keyword, store) rows matching ALL supplied filters, ignoring `limit`/`offset` — for pagination. */
  readonly total: number;
}

/**
 * Server-side paginated, sortable listing of the WHOLE keyword corpus's
 * latest scan per (keyword, store) — backs `GET /appstore/opportunities`.
 * Sorting is full-column (see `SortKey`) via a whitelisted ORDER BY
 * (`buildOrderByClause`), never by interpolating caller input into SQL
 * text. `peakOpportunity` (MAX(opportunity) over each keyword's full scan
 * history, all stores) is always included on every row alongside the
 * latest-scan `opportunity`, so the UI can show both numbers regardless of
 * sort column. `total` is the filtered, pre-pagination match count.
 */
export async function getTopOpportunities(
  opts: GetTopOpportunitiesOptions,
): Promise<GetTopOpportunitiesResult> {
  const db = getDb();
  const filters: OpportunityFilters = {
    genreZone: opts.genreZone ?? null,
    trend: opts.trend ?? null,
    minDemand: opts.minDemand ?? null,
    maxCompetitiveness: opts.maxCompetitiveness ?? null,
    minIncumbentWeakness: opts.minIncumbentWeakness ?? null,
    minOpportunity: opts.minOpportunity ?? null,
    hideJunk: opts.hideJunk ?? false,
  };
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? "opportunity";
  const dir = opts.dir ?? "desc";
  const orderByClause = buildOrderByClause(sort, dir);

  const dataQuery = db`
    WITH s AS (
      SELECT DISTINCT ON (keyword, store) *
      FROM appstore_keyword_scans
      ORDER BY keyword, store, scanned_at DESC
    ),
    peak AS (
      SELECT keyword, MAX(opportunity) AS peak_opportunity
      FROM appstore_keyword_scans
      GROUP BY keyword
    )
    SELECT
      s.*,
      peak.peak_opportunity AS peak_opportunity,
      k.created_at AS keyword_created_at,
      k.source AS keyword_source
    FROM s
    LEFT JOIN peak ON peak.keyword = s.keyword
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE ${buildFilterClause(db, filters)}
    ORDER BY ${db.unsafe(orderByClause)}
    LIMIT ${opts.limit} OFFSET ${offset}
  `;

  const [rows, total] = await Promise.all([dataQuery, countFilteredOpportunities(filters)]);

  return {
    rows: (rows as OpportunityDbRow[]).map(rowToOpportunity),
    total,
  };
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

/**
 * Default cap on how many of the most-recent `appstore_keyword_scans` rows
 * are inspected for embedded app names (see `getScannedAppNames`). Bounds
 * query cost against a table that grows every scan cycle — recent rows
 * alone already cover the vast majority of distinct app names ever seen (in
 * practice ~12k distinct names live within the ~2k most-recent rows), so
 * this stays small relative to the table's overall size while staying
 * fresh.
 */
const DEFAULT_SCANNED_ROWS_LIMIT = 3000;

/**
 * Distinct app names embedded in the `top_apps` JSONB column of the most
 * recent `appstore_keyword_scans` rows — a broad, continuously-growing pool
 * of real App Store app names that goes well beyond the finite top-chart
 * apps in `appstore_apps`/`getRankings` (every keyword scan records its own
 * top results, and the scanner runs continuously). Paired with `getRankings`
 * in `keyword-miner.ts`'s `mineKeywords`, which mines candidate keywords
 * from both pools.
 *
 * `top_apps` is stored DOUBLE-ENCODED: Bun's SQL driver returns the jsonb
 * column as a JS string, and that string is itself a JSON-encoded array
 * (written via `JSON.stringify(p.topApps)` in `insertScan`) — so the
 * column's own `jsonb_typeof` is `'string'`, not `'array'`.
 * `(top_apps #>> '{}')::jsonb` un-escapes the outer string to recover the
 * real array before `jsonb_array_elements` can walk it.
 *
 * Defensive by construction rather than by catching a thrown cast error —
 * Postgres has no per-row try/catch in plain SQL, so a single bad cast
 * would abort the whole query and every caller with it. The WHERE clause
 * restricts to rows that are non-null, not the JSON literal `'null'`, AND
 * whose text representation starts with `"[` (the shape of a
 * JSON-encoded-string wrapping an array, checked with `LIKE` rather than a
 * `~` regex — `[` needs no escaping there, sidestepping any
 * JS-string-literal-vs-POSIX-regex escaping mismatch) BEFORE the cast ever
 * runs, so a malformed row is silently skipped instead of blowing up the
 * query.
 *
 * Bounded twice: `scanRowsLimit` caps how many recent scan rows are even
 * considered (freshness + cost bound on a table that grows without end),
 * and `limit` caps the distinct names returned. The final `GROUP BY name
 * ORDER BY max(scanned_at) DESC` (rather than a plain `SELECT DISTINCT ...
 * LIMIT`) matters: a bare `DISTINCT` has no ordering guarantee of its own,
 * so a `LIMIT` stacked directly on it could arbitrarily keep or drop any
 * given distinct name — grouping and explicitly ordering by each name's own
 * freshest occurrence makes "freshest names survive the limit first" an
 * actual guarantee instead of an implementation-detail coincidence.
 */
export async function getScannedAppNames(
  limit: number,
  scanRowsLimit: number = DEFAULT_SCANNED_ROWS_LIMIT,
): Promise<readonly string[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = await db`
    WITH recent AS (
      SELECT scanned_at, top_apps
      FROM appstore_keyword_scans
      WHERE top_apps IS NOT NULL
        AND top_apps::text <> 'null'
        AND top_apps::text LIKE '"[%'
      ORDER BY scanned_at DESC
      LIMIT ${scanRowsLimit}
    ),
    names AS (
      SELECT app ->> 'name' AS name, recent.scanned_at AS scanned_at
      FROM recent, LATERAL jsonb_array_elements((recent.top_apps #>> '{}')::jsonb) AS app
      WHERE app ->> 'name' IS NOT NULL AND app ->> 'name' <> ''
    )
    SELECT name
    FROM names
    GROUP BY name
    ORDER BY max(scanned_at) DESC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ name: string }>).map((r) => r.name);
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
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline" | "mined";
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
