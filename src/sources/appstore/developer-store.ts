// Persistence for the developer/artist registry (`appstore_developers`,
// migration 045) — drained by `app-enrichment.ts`'s `runPortfolioPass` to
// discover sibling apps by the same developer via
// `app-lookup.ts`'s `fetchArtistPortfolio`. Follows the house `XRow` <->
// domain split used throughout the App Store source.

import { getDb } from "../../store/db";

export interface Developer {
  readonly artistId: string;
  readonly name: string;
  readonly lastPortfolioScanAt: number | null;
  readonly appCount: number;
  readonly updatedAt: number;
}

interface DeveloperRow {
  readonly artist_id: string;
  readonly name: string;
  readonly last_portfolio_scan_at: number | string | null;
  readonly app_count: number | string;
  readonly updated_at: number | string;
}

function rowToDeveloper(row: DeveloperRow): Developer {
  return {
    artistId: row.artist_id,
    name: row.name,
    lastPortfolioScanAt:
      row.last_portfolio_scan_at === null || row.last_portfolio_scan_at === undefined
        ? null
        : Number(row.last_portfolio_scan_at),
    appCount: Number(row.app_count),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Registers (or refreshes the name of) a developer discovered via lookup
 * enrichment (`app-enrichment.ts`'s `runEnrichmentPass`, from a
 * `LookupApp.artistId`/`artistName`). `last_portfolio_scan_at` is left
 * untouched on conflict — only `markPortfolioScanned` (below) advances it.
 */
export async function upsertDeveloper(
  input: { readonly artistId: string; readonly name: string },
  now: number,
): Promise<void> {
  if (!input.artistId) return;
  const db = getDb();
  await db`
    INSERT INTO appstore_developers (artist_id, name, app_count, updated_at)
    VALUES (${input.artistId}, ${input.name}, 0, ${now})
    ON CONFLICT (artist_id) DO UPDATE SET
      name = CASE WHEN ${input.name} <> '' THEN ${input.name} ELSE appstore_developers.name END,
      updated_at = ${now}
  `;
}

/**
 * Stamps `last_portfolio_scan_at` and `app_count` after a portfolio pass —
 * called regardless of whether the portfolio fetch found any NEW sibling
 * apps, so a developer with a stable/already-known portfolio doesn't get
 * re-selected by `getDevelopersDueForPortfolioScan` every pass.
 */
export async function markPortfolioScanned(
  artistId: string,
  appCount: number,
  now: number,
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE appstore_developers SET last_portfolio_scan_at = ${now}, app_count = ${appCount}, updated_at = ${now}
    WHERE artist_id = ${artistId}
  `;
}

/**
 * Developers whose portfolio has never been scanned (`last_portfolio_scan_at
 * IS NULL`, prioritized first) or is older than `minIntervalSeconds`, oldest
 * first, up to `limit`.
 */
export async function getDevelopersDueForPortfolioScan(opts: {
  readonly limit: number;
  readonly minIntervalSeconds: number;
}): Promise<readonly string[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const staleSince = now - Math.max(0, opts.minIntervalSeconds);

  const rows = await db`
    SELECT artist_id FROM appstore_developers
    WHERE last_portfolio_scan_at IS NULL OR last_portfolio_scan_at < ${staleSince}
    ORDER BY last_portfolio_scan_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ artist_id: string }>).map((r) => r.artist_id);
}

/** Fetch a single developer row — test/inspection convenience. */
export async function getDeveloper(artistId: string): Promise<Developer | null> {
  const db = getDb();
  const rows = await db`SELECT * FROM appstore_developers WHERE artist_id = ${artistId}`;
  const row = (rows as DeveloperRow[])[0];
  return row ? rowToDeveloper(row) : null;
}
