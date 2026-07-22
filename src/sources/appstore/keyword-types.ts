// Shared type contract for the App Store keyword-gap scanner. Consumed by the
// keyword store (persistence), the scanner (produces KeywordGapProfile), and
// any downstream reporting/dashboard code. Keep field names/types in lockstep
// with the DB schema in `src/store/migrations/037_appstore_keyword_gaps.sql`.

import type { SerpTailEntry } from "./serp-tail";

export type GapTrend = "heating" | "stable" | "cooling" | "new";

export interface TopApp {
  readonly id: string;
  readonly name: string;
  readonly reviews: number; // userRatingCount
  readonly rating: number; // averageUserRating (0..5)
  readonly ageDays: number; // days since releaseDate
  readonly ratingsPerDay: number; // lifetime reviews / max(ageDays,1) — fallback velocity
  readonly titleMatch: boolean; // keyword tokens present in trackName
  // ---- Enrichment (all optional so legacy persisted rows / external
  // TopApp factories stay valid). Populated by `toTopApp` from the iTunes
  // payload and by `scanKeyword` from cross-scan diffing. ----
  readonly lastUpdatedDays?: number; // days since currentVersionReleaseDate (update staleness)
  readonly price?: number; // numeric price (0 = free)
  readonly formattedPrice?: string; // e.g. "$4.99", "Free"
  readonly recentVelocity?: number; // ratings/day since prior scan; falls back to ratingsPerDay
  // Batch C3 ("fix fictional genre zones"): the app's REAL iTunes category
  // (`primaryGenreName` from the Search API payload — see `keyword-gaps.ts`'s
  // `toTopApp`), used to self-heal a keyword's `genre_zone` from what its
  // title-matched apps actually are, rather than the zone it inherited at
  // discovery time (a seed's zone for autocomplete candidates, or
  // `keyword-miner.ts`'s `DEFAULT_ZONE` for name-only mined ones). Optional
  // so legacy persisted rows / external TopApp factories stay valid.
  readonly genre?: string;
}

export interface KeywordGapProfile {
  readonly keyword: string;
  // "DE" — the German storefront lane (2026-07-21 scan-budget retune, see
  // keyword-gaps.ts's `runDeStorefrontSweep`): querying/mining data only,
  // deliberately excluded from the (US-calibrated) signature screener and
  // from junk-deactivation/velocity bookkeeping this iteration.
  readonly store: "app" | "play" | "DE";
  readonly competitiveness: number; // 0..100
  readonly demand: number; // lifetime ratings/day baseline + recent-velocity momentum, over matched incumbents
  readonly incumbentWeakness: number; // 0..1
  readonly opportunity: number; // 0..1  (== whitespace)
  readonly trend: GapTrend;
  readonly topAppReviews: number; // max reviews in field (raw, audit)
  readonly avgRating: number; // mean rating (raw, audit)
  readonly avgAgeDays: number; // mean age (raw, audit)
  readonly topApps: readonly TopApp[];
  readonly scannedAt: number; // epoch seconds
  /**
   * True iff zero apps in this scan's SERP title-matched the keyword — demand
   * / incumbent-weakness were computed over a giant-excluded non-matched
   * fallback (or 0/NULL if every non-matched app was a giant), never a
   * title-matched field. See `scanKeyword`'s module doc (2026-07-21 audit
   * item C fix) and migration 042.
   */
  readonly lowConfidence: boolean;
  /**
   * True iff this scan's field looks brand-navigational — the rank-1 app's
   * title matches the keyword AND that app holds a dominant share of the
   * top-N field's reviews (Batch A budget rescue, 2026-07-22 — see
   * `keyword-brand.ts`'s `isBrandNavigationalScan` and migration 050).
   * Consumed by `keyword-deactivation.ts` (a keyword whose last several
   * scans are all brand-navigational is eligible for deactivation even on
   * `source: 'autocomplete'`) and excluded from `getTopOpportunities` by
   * default — see `format-gap-profile.ts`.
   */
  readonly brandNavigational: boolean;
  /**
   * Deep-SERP-only (migration 044, serp-rank Stage 1): the compact
   * `{id, rank}` tail of a fetch deeper than `topN` — entries at position
   * `>= topN`, up to the fetched depth. `undefined` for a plain (non-deep)
   * scan; the pure builder is `serp-tail.ts`'s `buildSerpTail`. Deliberately
   * NOT read by `getScanHistory`/`getLatestScan` (see their doc comments) —
   * only `serp-rank-store.ts` reads this column, via its own explicit query.
   */
  readonly serpTail?: readonly SerpTailEntry[];
}
