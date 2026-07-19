// Persistence for the newborn-velocity screener (see `keyword-screener.ts`):
// the `appstore_signature_hits` table (migration 039) — one row per keyword
// that has EVER matched the validated "window-opening signature", upserted in
// place on every re-hit. Follows the house `XRow` (snake_case, as returned by
// `Bun.sql`) <-> domain (camelCase, readonly) split used throughout
// `keyword-store.ts`.

import { getDb } from "../../store/db";
import type { GapTrend, TopApp } from "./keyword-types";

export type SignatureHitStatus = "new" | "active" | "dismissed";

export const SIGNATURE_HIT_STATUSES: readonly SignatureHitStatus[] = Object.freeze([
  "new",
  "active",
  "dismissed",
]);

export interface SignatureHit {
  readonly keyword: string;
  readonly firstDetectedAt: number;
  readonly lastSeenAt: number;
  readonly timesSeen: number;
  readonly status: SignatureHitStatus;
  readonly competitiveness: number | null;
  readonly demand: number | null;
  readonly trend: GapTrend | null;
  readonly newcomerRpd: number | null;
  readonly establishedRpd: number | null;
  readonly velocityRatio: number | null;
  readonly fastNewcomers: number | null;
  readonly acceleratingApps: number | null;
  readonly maxReviews: number | null;
  readonly genreZone: string | null;
  readonly topAppsSnapshot: readonly TopApp[];
}

/** Raw column shape returned by `SELECT * FROM appstore_signature_hits`. */
interface SignatureHitRow {
  readonly keyword: string;
  readonly first_detected_at: number | string;
  readonly last_seen_at: number | string;
  readonly times_seen: number | string;
  readonly status: string;
  readonly competitiveness: number | string | null;
  readonly demand: number | string | null;
  readonly trend: string | null;
  readonly newcomer_rpd: number | string | null;
  readonly established_rpd: number | string | null;
  readonly velocity_ratio: number | string | null;
  readonly fast_newcomers: number | string | null;
  readonly accelerating_apps: number | string | null;
  readonly max_reviews: number | string | null;
  readonly genre_zone: string | null;
  /** Raw jsonb value — see `parseJson` below re: Bun's double-encoding quirk. */
  readonly top_apps_snapshot: unknown;
}

/**
 * Mirrors `parseJson` in `keyword-store.ts` / `src/pipelines/store.ts`: Bun's
 * SQL driver returns `jsonb` columns as raw JSON strings, not parsed values.
 * If already parsed (array/object), use as-is; if a string, parse it; on
 * failure, fall back defensively rather than throwing.
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

function numOrNull(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function rowToSignatureHit(row: SignatureHitRow): SignatureHit {
  return {
    keyword: row.keyword,
    firstDetectedAt: Number(row.first_detected_at),
    lastSeenAt: Number(row.last_seen_at),
    timesSeen: Number(row.times_seen),
    status: row.status as SignatureHitStatus,
    competitiveness: numOrNull(row.competitiveness),
    demand: numOrNull(row.demand),
    trend: row.trend as GapTrend | null,
    newcomerRpd: numOrNull(row.newcomer_rpd),
    establishedRpd: numOrNull(row.established_rpd),
    velocityRatio: numOrNull(row.velocity_ratio),
    fastNewcomers: numOrNull(row.fast_newcomers),
    acceleratingApps: numOrNull(row.accelerating_apps),
    maxReviews: numOrNull(row.max_reviews),
    genreZone: row.genre_zone,
    topAppsSnapshot: parseJson<readonly TopApp[]>(row.top_apps_snapshot, []),
  };
}

/** One keyword whose latest App Store scan is a candidate for signature evaluation. */
export interface ScreenerCandidate {
  readonly keyword: string;
  readonly competitiveness: number;
  readonly demand: number;
  readonly trend: GapTrend;
  readonly topApps: readonly TopApp[];
  readonly genreZone: string | null;
}

/**
 * Candidate keywords for the screener: the LATEST `app`-store scan per
 * keyword (`DISTINCT ON (keyword) ORDER BY scanned_at DESC`), left-joined to
 * `appstore_keywords` for `genre_zone`, pre-filtered in SQL to the two
 * cheapest gates (`competitiveness`, `trend`, `genre_zone`) so the full corpus
 * scan stays index-friendly — the remaining, per-app gates (newcomer count,
 * velocity ratio, max reviews, suppression, junk) are evaluated in TS by
 * `computeSignature` against this narrowed set, not here.
 *
 * `top_apps` is stored DOUBLE-ENCODED (see `keyword-store.ts`'s
 * `getScannedAppNames` doc comment): `(top_apps #>> '{}')::jsonb` un-escapes
 * the outer string so the column's own jsonb value is the real array before
 * Bun's driver hands it back (still as a single-encoded JSON string, per
 * Bun's own jsonb-as-text behavior) for `parseJson` to decode.
 */
export async function getScreenerCandidates(opts: {
  readonly maxCompetitiveness: number;
  readonly requiredTrend: GapTrend;
  readonly excludedGenreZone: string;
}): Promise<readonly ScreenerCandidate[]> {
  const db = getDb();
  const rows = await db`
    WITH latest AS (
      SELECT DISTINCT ON (keyword) *
      FROM appstore_keyword_scans
      WHERE store = 'app'
      ORDER BY keyword, scanned_at DESC
    )
    SELECT
      s.keyword AS keyword,
      s.competitiveness AS competitiveness,
      s.demand AS demand,
      s.trend AS trend,
      (s.top_apps #>> '{}')::jsonb AS top_apps,
      k.genre_zone AS genre_zone
    FROM latest s
    LEFT JOIN appstore_keywords k ON k.keyword = s.keyword
    WHERE s.competitiveness <= ${opts.maxCompetitiveness}
      AND s.trend = ${opts.requiredTrend}
      AND (k.genre_zone IS NULL OR k.genre_zone <> ${opts.excludedGenreZone})
  `;
  return (
    rows as ReadonlyArray<{
      keyword: string;
      competitiveness: number | string;
      demand: number | string;
      trend: string;
      top_apps: unknown;
      genre_zone: string | null;
    }>
  ).map((r) => ({
    keyword: r.keyword,
    competitiveness: Number(r.competitiveness),
    demand: Number(r.demand),
    trend: r.trend as GapTrend,
    topApps: parseJson<readonly TopApp[]>(r.top_apps, []),
    genreZone: r.genre_zone,
  }));
}

export interface SignatureHitUpsertInput {
  readonly keyword: string;
  readonly competitiveness: number;
  readonly demand: number;
  readonly trend: GapTrend;
  readonly newcomerRpd: number | null;
  readonly establishedRpd: number | null;
  readonly velocityRatio: number | null;
  readonly fastNewcomers: number;
  readonly acceleratingApps: number;
  readonly maxReviews: number;
  readonly genreZone: string | null;
  readonly topApps: readonly TopApp[];
}

/**
 * Insert a fresh hit (`status` defaults to `'new'`) or, on conflict, refresh
 * an existing hit's metrics/`last_seen_at`/`times_seen` WITHOUT touching
 * `status` — a re-hit never revives a `dismissed` row nor re-flags an
 * `active` one back to `new`; only a brand-new keyword ever gets `'new'`.
 * Returns whether this call inserted a new row (via the standard Postgres
 * `xmax = 0` "was this row just inserted" idiom), so the caller can log a
 * count of genuinely NEW hits distinct from re-hits.
 */
export async function upsertSignatureHit(
  input: SignatureHitUpsertInput,
  now: number,
): Promise<{ readonly isNew: boolean }> {
  const db = getDb();
  const rows = await db`
    INSERT INTO appstore_signature_hits (
      keyword, first_detected_at, last_seen_at, times_seen, status,
      competitiveness, demand, trend, newcomer_rpd, established_rpd, velocity_ratio,
      fast_newcomers, accelerating_apps, max_reviews, genre_zone, top_apps_snapshot
    ) VALUES (
      ${input.keyword}, ${now}, ${now}, 1, 'new',
      ${input.competitiveness}, ${input.demand}, ${input.trend}, ${input.newcomerRpd},
      ${input.establishedRpd}, ${input.velocityRatio}, ${input.fastNewcomers},
      ${input.acceleratingApps}, ${input.maxReviews}, ${input.genreZone},
      ${JSON.stringify(input.topApps)}
    )
    ON CONFLICT (keyword) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      times_seen = appstore_signature_hits.times_seen + 1,
      competitiveness = EXCLUDED.competitiveness,
      demand = EXCLUDED.demand,
      trend = EXCLUDED.trend,
      newcomer_rpd = EXCLUDED.newcomer_rpd,
      established_rpd = EXCLUDED.established_rpd,
      velocity_ratio = EXCLUDED.velocity_ratio,
      fast_newcomers = EXCLUDED.fast_newcomers,
      accelerating_apps = EXCLUDED.accelerating_apps,
      max_reviews = EXCLUDED.max_reviews,
      genre_zone = EXCLUDED.genre_zone,
      top_apps_snapshot = EXCLUDED.top_apps_snapshot
    RETURNING (xmax = 0) AS inserted
  `;
  const row = (rows as ReadonlyArray<{ inserted: boolean }>)[0];
  return { isNew: row?.inserted === true };
}

export interface GetSignatureHitsOptions {
  readonly status?: SignatureHitStatus;
  readonly limit: number;
}

/** Listing for `GET /appstore/signature-hits` — sorted first-detected-newest-first. */
export async function getSignatureHits(
  opts: GetSignatureHitsOptions,
): Promise<readonly SignatureHit[]> {
  const db = getDb();
  const status = opts.status ?? null;
  const rows = await db`
    SELECT * FROM appstore_signature_hits
    WHERE (${status}::text IS NULL OR status = ${status})
    ORDER BY first_detected_at DESC
    LIMIT ${opts.limit}
  `;
  return (rows as SignatureHitRow[]).map(rowToSignatureHit);
}

/**
 * Sets a hit's triage status — backs the `PATCH /appstore/signature-hits/:keyword`
 * route. `'new'` is intentionally excluded: it is an insert-time default only,
 * never a caller-driven transition (a hit only ever moves forward from `new`
 * to `active`/`dismissed`, never back). Returns `null` for an unknown keyword.
 */
export async function setSignatureHitStatus(
  keyword: string,
  status: Exclude<SignatureHitStatus, "new">,
): Promise<SignatureHit | null> {
  const db = getDb();
  const rows = await db`
    UPDATE appstore_signature_hits
    SET status = ${status}
    WHERE keyword = ${keyword}
    RETURNING *
  `;
  const row = (rows as SignatureHitRow[])[0];
  return row ? rowToSignatureHit(row) : null;
}
