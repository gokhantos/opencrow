// Pure logic for the newborn-velocity time-series (migration 040,
// app-velocity-store.ts): which apps qualify for tracking, when a fresh
// observation is due, and how "acceleration" is computed from a small,
// time-ordered sample of an app's observations. No I/O, no Date.now(),
// no Math.random() — every input is a plain value the caller already read
// from the DB, so this is exhaustively unit-testable with injected
// timestamps. Split from `app-velocity-store.ts` the same way
// `keyword-scoring.ts` is split from `keyword-store.ts`.

/**
 * An app younger than this (days) is a "newborn" worth tracking — mirrors
 * `keyword-screener.ts`'s `NEWCOMER_AGE_DAYS_MAX` (also 540, ~18 months).
 * Kept as an independent constant rather than an import: the screener's
 * newborn-velocity SIGNATURE and this time-series TRACKING gate are
 * conceptually related but operationally separate (one reads
 * `appstore_keyword_scans`, the other writes `appstore_app_velocity`) — a
 * future change to one age bound should not silently change the other.
 */
export const NEWBORN_AGE_DAYS_MAX = 540;

/**
 * Minimum gap between recorded observations for the same app, in
 * milliseconds. Bounds `appstore_app_velocity` write volume to at most
 * 4 rows/app/day regardless of how many different keyword scans surface the
 * same trending app in a given window.
 */
export const VELOCITY_BUCKET_MS = 6 * 60 * 60 * 1000;

/**
 * An app qualifies for velocity tracking iff it is younger than
 * `NEWBORN_AGE_DAYS_MAX`.
 */
export function isNewborn(ageDays: number): boolean {
  return ageDays < NEWBORN_AGE_DAYS_MAX;
}

/**
 * True iff a fresh observation should be recorded for an app whose last
 * recorded observation was at `lastObservedAtSeconds` (epoch seconds, or
 * `null` if the app has never been observed). `nowSeconds` is the current
 * scan's timestamp, injected rather than read from `Date.now()` so this is
 * deterministic and testable.
 */
export function isObservationDue(
  lastObservedAtSeconds: number | null,
  nowSeconds: number,
): boolean {
  if (lastObservedAtSeconds === null) return true;
  return (nowSeconds - lastObservedAtSeconds) * 1000 >= VELOCITY_BUCKET_MS;
}

/**
 * Minimum gap (hours) between the two most-recent observations before their
 * diff is trusted as a "recent velocity" reading — mirrors
 * `keyword-gaps.ts`'s `MIN_VELOCITY_WINDOW_DAYS` (0.5 days = 12h): under the
 * ~6h observation bucket, two adjacent observations could be as little as
 * one bucket apart, which is too fresh to diff meaningfully.
 */
export const MIN_RECENT_WINDOW_HOURS = 12;

export interface VelocityPoint {
  readonly observedAt: number; // epoch seconds
  readonly reviews: number;
}

export interface AccelerationResult {
  /** reviews/day between the two most-recent points, `null` if the gap is under `MIN_RECENT_WINDOW_HOURS` or there are fewer than 2 points. */
  readonly recentVelocity: number | null;
  /** reviews/day between the earliest and latest points, `null` if the span is zero/negative or there are fewer than 2 points. */
  readonly overallVelocity: number | null;
  /** `recentVelocity / overallVelocity`, `null` when either side is unavailable or `overallVelocity` is non-positive (never `Infinity`). */
  readonly acceleration: number | null;
}

const NO_ACCELERATION: AccelerationResult = {
  recentVelocity: null,
  overallVelocity: null,
  acceleration: null,
};

/**
 * Computes velocity + acceleration from a small, time-ordered sample of an
 * app's observations. `points` must be sorted NEWEST-FIRST (descending
 * `observedAt`); only the first two (for "recent velocity") and the last
 * (for "overall span") are read, so the caller may pass either a full series
 * or a reduced 3-point sample `[latest, secondLatest, earliest]` — both
 * shapes work identically, which is what lets `getTopAcceleratingNewborns`
 * fetch just 3 columns per app instead of a full history. Pure: no I/O.
 *
 * "Acceleration" is `recentVelocity / overallVelocity` — how much faster the
 * app is gaining reviews RIGHT NOW than it has, on average, over its whole
 * observed span. A ratio > 1 means it is speeding up.
 */
export function computeAcceleration(points: readonly VelocityPoint[]): AccelerationResult {
  if (points.length < 2) return NO_ACCELERATION;

  const latest = points[0];
  const secondLatest = points[1];
  const earliest = points[points.length - 1];
  if (!latest || !secondLatest || !earliest) return NO_ACCELERATION;

  const recentGapHours = (latest.observedAt - secondLatest.observedAt) / 3600;
  const recentVelocity =
    recentGapHours >= MIN_RECENT_WINDOW_HOURS
      ? Math.max(0, latest.reviews - secondLatest.reviews) / (recentGapHours / 24)
      : null;

  const overallSpanHours = (latest.observedAt - earliest.observedAt) / 3600;
  const overallVelocity =
    overallSpanHours > 0
      ? Math.max(0, latest.reviews - earliest.reviews) / (overallSpanHours / 24)
      : null;

  const acceleration =
    recentVelocity !== null && overallVelocity !== null && overallVelocity > 0
      ? recentVelocity / overallVelocity
      : null;

  return { recentVelocity, overallVelocity, acceleration };
}
