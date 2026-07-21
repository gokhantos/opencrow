// Pure helpers for the deep-SERP "tail" — the part of a >topN iTunes fetch
// that lies beyond the scored/persisted `top_apps` window (see
// `keyword-gaps.ts`'s `scanKeywordDeep` and migration 044). Deliberately
// tiny: only `{id, rank}` per entry — no name/reviews/rating — since the
// tail exists purely to recover an app's SERP position over time
// (`serp-rank-store.ts`), never to re-derive scoring (which is frozen to the
// `top_apps` slice). No I/O, no Date.now() — exhaustively unit-testable.

import type { TopApp } from "./keyword-types";

export interface SerpTailEntry {
  readonly id: string;
  /** 0-based position in the full (un-sliced) deep SERP fetch. */
  readonly rank: number;
}

/**
 * Builds the compact tail of a deep SERP fetch: every entry at 0-based
 * position `>= topN`, as `{id, rank}` pairs. `rankedSerp` must be in the
 * fetch's own rank order (position 0 = #1 result) — the caller
 * (`scanKeywordDeep`) passes the full, unsliced array it already fetched.
 * Entries with an empty/missing id are dropped (nothing to key a rank
 * lookup on — mirrors `recordVelocityObservationsForScan`'s own `!app.id`
 * skip). Returns `[]` when `rankedSerp` has `topN` or fewer entries (a
 * shallow fetch has no tail).
 */
export function buildSerpTail(
  rankedSerp: readonly TopApp[],
  topN: number,
): readonly SerpTailEntry[] {
  const tail: SerpTailEntry[] = [];
  for (let rank = topN; rank < rankedSerp.length; rank++) {
    const app = rankedSerp[rank];
    if (!app || app.id.length === 0) continue;
    tail.push({ id: app.id, rank });
  }
  return tail;
}

/**
 * Looks up `appId`'s rank within a previously-built tail, or `undefined` if
 * it isn't present (either the app wasn't in the deep fetch at all, or it
 * ranked within the scored `top_apps` window rather than the tail — callers
 * that need a rank spanning BOTH windows check `top_apps` first — see
 * `serp-rank-store.ts`'s `getRankSeriesFromScans`).
 */
export function rankFromTail(
  tail: readonly SerpTailEntry[],
  appId: string,
): number | undefined {
  return tail.find((entry) => entry.id === appId)?.rank;
}
