// Shared type contract for the App Store keyword-gap scanner. Consumed by the
// keyword store (persistence), the scanner (produces KeywordGapProfile), and
// any downstream reporting/dashboard code. Keep field names/types in lockstep
// with the DB schema in `src/store/migrations/037_appstore_keyword_gaps.sql`.

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
}

export interface KeywordGapProfile {
  readonly keyword: string;
  readonly store: "app" | "play";
  readonly competitiveness: number; // 0..100
  readonly demand: number; // mean ratingsPerDay across topApps
  readonly incumbentWeakness: number; // 0..1
  readonly opportunity: number; // 0..1  (== whitespace)
  readonly trend: GapTrend;
  readonly topAppReviews: number; // max reviews in field (raw, audit)
  readonly avgRating: number; // mean rating (raw, audit)
  readonly avgAgeDays: number; // mean age (raw, audit)
  readonly topApps: readonly TopApp[];
  readonly scannedAt: number; // epoch seconds
}
