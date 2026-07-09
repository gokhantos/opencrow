// Pure formatting helpers for the App Store "Opportunities" dashboard tab.
// Kept side-effect-free and framework-agnostic so they're trivially unit
// testable without rendering React.

/**
 * Formats a 0..1 opportunity/incumbent-weakness ratio as a whole-number
 * percentage string, e.g. `0.53 -> "53%"`. Non-finite input renders as a
 * dash; out-of-range input is clamped to `[0, 1]` before rounding.
 */
export function formatOpportunity(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const clamped = Math.max(0, Math.min(1, value));
  return `${Math.round(clamped * 100)}%`;
}

export interface TrendBadge {
  readonly label: string;
  readonly className: string;
}

const TREND_BADGES: Readonly<Record<string, TrendBadge>> = {
  heating: { label: "Heating", className: "bg-danger/15 text-danger" },
  cooling: { label: "Cooling", className: "bg-accent/15 text-accent" },
  stable: { label: "Stable", className: "bg-bg-3 text-muted" },
  new: { label: "New", className: "bg-green-500/15 text-green-400" },
};

const UNKNOWN_TREND_CLASSNAME = "bg-bg-3 text-faint";

/**
 * Maps a `GapTrend` value to a display label + Tailwind className for the
 * trend badge. Unknown/unexpected values fall back to the raw string as the
 * label rather than throwing, since this renders data straight from the API.
 */
export function trendBadge(trend: string): TrendBadge {
  return TREND_BADGES[trend] ?? { label: trend, className: UNKNOWN_TREND_CLASSNAME };
}
