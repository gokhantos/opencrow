// Rank-over-time reads for the deep-SERP tail (migration 044, serp-rank
// Stage 1). Derives an app's SERP position at each historical scan from
// `appstore_keyword_scans.top_apps` (the scored top-N window — position =
// array index) UNION the deep-scan-only `serp_tail` column (position >=
// topN, only present on deep fetches — see `serp-tail.ts`). Follows the same
// `XRow` (snake_case) <-> domain (camelCase, readonly) split as
// `keyword-store.ts`, with its own local `parseJson` (not imported from
// `keyword-store.ts` — that module's copy is private/unexported, and the
// semantics are identical: Bun's driver hands back an already-JSON-parsed
// value for a plain jsonb column OR a JS string for `top_apps`/`serp_tail`'s
// double-encoded write path — see migration 044's doc comment — either way
// exactly one JSON.parse recovers the real value).

import { getDb } from "../../store/db";
import { rankFromTail, type SerpTailEntry } from "./serp-tail";
import type { TopApp } from "./keyword-types";

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

/** Hard ceiling on any caller-supplied `limit`, mirroring the bounded-limit convention elsewhere (e.g. `getAppVelocitySeries`). */
const MAX_HISTORY_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 60;

interface ScanRankDbRow {
  readonly scanned_at: number | string;
  readonly top_apps: unknown;
  readonly serp_tail: unknown;
}

export interface RankPoint {
  readonly scannedAt: number;
  /**
   * 0-based SERP position, or `null` when the app appeared in neither this
   * scan's `top_apps` window nor its `serp_tail` (not deep-scanned that
   * cycle, or genuinely absent from the results).
   */
  readonly rank: number | null;
}

/**
 * One app's rank history under one keyword/store, newest-first, derived from
 * `appstore_keyword_scans` (both the scored `top_apps` window and, on deep
 * scans, `serp_tail`). Bounded by `limit` (default 60, hard ceiling 200) —
 * this reads the (potentially large) `serp_tail` column, so unlike
 * `getScanHistory`/`getLatestScan` it does NOT use the tail-excluding column
 * list; that exclusion exists specifically so THIS is the one place the tail
 * gets paid for.
 */
export async function getRankSeriesFromScans(
  keyword: string,
  store: "app" | "play" | "DE",
  appId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<readonly RankPoint[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_HISTORY_LIMIT));
  const db = getDb();
  const rows = await db`
    SELECT scanned_at, top_apps, serp_tail
    FROM appstore_keyword_scans
    WHERE keyword = ${keyword} AND store = ${store}
    ORDER BY scanned_at DESC
    LIMIT ${boundedLimit}
  `;
  return (rows as ScanRankDbRow[]).map((row) => {
    const topApps = parseJson<readonly TopApp[]>(row.top_apps, []);
    const topIndex = topApps.findIndex((a) => a.id === appId);
    let rank: number | null = topIndex >= 0 ? topIndex : null;
    if (rank === null) {
      const tail = parseJson<readonly SerpTailEntry[]>(row.serp_tail, []);
      const tailRank = rankFromTail(tail, appId);
      rank = tailRank === undefined ? null : tailRank;
    }
    return { scannedAt: Number(row.scanned_at), rank };
  });
}

export interface RankClimber {
  readonly appId: string;
  readonly name: string;
  /** Rank at the older of the two compared scans, or `null` if it wasn't visible then. */
  readonly fromRank: number | null;
  /** Rank at the newer of the two compared scans. */
  readonly toRank: number;
  /**
   * `fromRank - toRank` — positive means the app climbed TOWARD #1 (rank
   * numbers shrink going up the SERP). `null` `fromRank` (a new entrant, not
   * present in the older scan) sorts first regardless of magnitude — a brand
   * new appearance is at least as notable as any numeric climb.
   */
  readonly delta: number | null;
}

/** Builds one scan's `appId -> {rank, name}` map from its `top_apps` + `serp_tail`. */
function buildRankMap(
  row: ScanRankDbRow,
): ReadonlyMap<string, { readonly rank: number; readonly name: string }> {
  const topApps = parseJson<readonly TopApp[]>(row.top_apps, []);
  const tail = parseJson<readonly SerpTailEntry[]>(row.serp_tail, []);
  const map = new Map<string, { rank: number; name: string }>();
  topApps.forEach((app, index) => {
    if (app.id.length === 0) return;
    map.set(app.id, { rank: index, name: app.name });
  });
  for (const entry of tail) {
    if (map.has(entry.id)) continue; // top_apps entries take priority (shouldn't overlap in practice)
    map.set(entry.id, { rank: entry.rank, name: "" });
  }
  return map;
}

/**
 * Apps climbing fastest toward #1 for `keyword`/`store`, comparing the TWO
 * most recent scans (deep or shallow — a shallow scan's tail is simply
 * empty, so it only ever contributes `top_apps`-window ranks). Requires at
 * least 2 scans; returns `[]` otherwise. New entrants (present in the newer
 * scan, absent from the older one) sort first via `delta: null` semantics
 * (see `RankClimber.delta`); apps present in both are sorted by descending
 * numeric delta.
 */
export async function getRankClimbers(
  keyword: string,
  store: "app" | "play" | "DE",
  limit: number,
): Promise<readonly RankClimber[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_HISTORY_LIMIT));
  const db = getDb();
  const rows = await db`
    SELECT scanned_at, top_apps, serp_tail
    FROM appstore_keyword_scans
    WHERE keyword = ${keyword} AND store = ${store}
    ORDER BY scanned_at DESC
    LIMIT 2
  `;
  const [newer, older] = rows as ScanRankDbRow[];
  if (!newer || !older) return [];

  const newerMap = buildRankMap(newer);
  const olderMap = buildRankMap(older);

  const climbers: RankClimber[] = [];
  for (const [appId, { rank: toRank, name }] of newerMap) {
    const from = olderMap.get(appId);
    const fromRank = from?.rank ?? null;
    const delta = fromRank === null ? null : fromRank - toRank;
    climbers.push({ appId, name, fromRank, toRank, delta });
  }

  climbers.sort((a, b) => {
    if (a.delta === null && b.delta === null) return a.toRank - b.toRank;
    if (a.delta === null) return -1;
    if (b.delta === null) return 1;
    return b.delta - a.delta;
  });

  return climbers.slice(0, boundedLimit);
}
