/**
 * Persistence for `appstore_search_popularity` (migration 053) — manually
 * imported Apple Search Ads "searchPopularity" scores (1..5), and later,
 * hint-sighting-derived volume proxies (`source: 'hint'`, batch D's
 * `getHintEvidence` — NOT populated here). See the migration's doc comment
 * for why this is a manual-import surface rather than an API sweep: the ASA
 * Campaign Management API v5 has no popularity endpoint, and the custom-
 * reports probe (`apple-ads/probe.ts`) is impression-gated and empty for
 * arbitrary keywords.
 *
 * Follows the house `XRow` (snake_case, as returned by `Bun.sql`) <-> domain
 * (camelCase, readonly) split used throughout `keyword-store.ts` /
 * `app-velocity-store.ts`. `checkedAt` is normalized to epoch seconds in the
 * domain type (the module-wide convention elsewhere in `src/sources/
 * appstore/`) even though the column itself is `TIMESTAMPTZ` — Bun's SQL
 * driver returns timestamptz columns as JS `Date` instances.
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";

const log = createLogger("appstore-popularity-store");

export type PopularitySource = "asa" | "hint";

export interface SearchPopularityRecord {
  readonly keyword: string;
  readonly source: PopularitySource;
  /** 0..5 — Apple's `searchPopularity` scale (0 = no/unmeasurable volume). */
  readonly value: number;
  /** 2-letter ISO country code, e.g. "US" — the ASA `countryOrRegion` convention. */
  readonly storefront: string;
  /** Epoch seconds. */
  readonly checkedAt: number;
}

interface SearchPopularityDbRow {
  readonly keyword: string;
  readonly source: string;
  readonly value: number | string;
  readonly storefront: string;
  readonly checked_at: Date | string | number;
}

function toEpochSeconds(value: Date | string | number): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return Math.floor(value);
  return Math.floor(new Date(value).getTime() / 1000);
}

function rowToRecord(row: SearchPopularityDbRow): SearchPopularityRecord {
  return {
    keyword: row.keyword,
    source: row.source as PopularitySource,
    value: Number(row.value),
    storefront: row.storefront,
    checkedAt: toEpochSeconds(row.checked_at),
  };
}

export interface UpsertPopularityInput {
  readonly keyword: string;
  readonly source: PopularitySource;
  readonly value: number;
  readonly storefront: string;
  /** Epoch seconds. Defaults to now if omitted. */
  readonly checkedAt?: number;
}

/**
 * Upserts one popularity row per `(keyword, source, storefront)` — a re-import
 * of the same triple refreshes `value`/`checked_at` in place rather than
 * accumulating history (this table is a "latest known reading" surface, not a
 * time series). Returns the number of rows written. Never throws for a single
 * bad row within the batch — the caller (the route) is expected to have
 * already Zod-validated every row, so a per-row DB failure here indicates a
 * genuine infra problem and is logged + propagated via the aggregate count
 * falling short, not swallowed silently.
 */
export async function upsertPopularity(
  rows: readonly UpsertPopularityInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let written = 0;
  for (const r of rows) {
    const checkedAt = r.checkedAt === undefined ? new Date() : new Date(r.checkedAt * 1000);
    await db`
      INSERT INTO appstore_search_popularity (keyword, source, value, storefront, checked_at)
      VALUES (${r.keyword}, ${r.source}, ${r.value}, ${r.storefront}, ${checkedAt})
      ON CONFLICT (keyword, source, storefront)
      DO UPDATE SET value = EXCLUDED.value, checked_at = EXCLUDED.checked_at
    `;
    written++;
  }
  log.info("Upserted ASA search-popularity rows", { count: written });
  return written;
}

/**
 * Most recent recorded popularity for `keyword`, across storefronts (highest
 * `checked_at` wins), scoped to `source` (default `'asa'` — the only source
 * this module writes; `'hint'` rows compose in later via batch D). Returns
 * `null` if never recorded. Backs the `analyze_keyword_gap` tool's
 * "ASA popularity: N/5 (probed <date>)" annotation line.
 */
export async function getLatestPopularity(
  keyword: string,
  source: PopularitySource = "asa",
): Promise<SearchPopularityRecord | null> {
  const db = getDb();
  const rows = await db`
    SELECT keyword, source, value, storefront, checked_at
    FROM appstore_search_popularity
    WHERE keyword = ${keyword} AND source = ${source}
    ORDER BY checked_at DESC
    LIMIT 1
  `;
  const row = (rows as SearchPopularityDbRow[])[0];
  return row ? rowToRecord(row) : null;
}
