// Pure formatting helpers for the App Store "Opportunities" dashboard tab.
// Kept side-effect-free and framework-agnostic so they're trivially unit
// testable without rendering React.

import { timeAgo } from "../../lib/format";

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

// ─── Source badge (keyword provenance) ─────────────────────────────────────

/** Mirrors `KeywordSeedRow["source"]` (src/sources/appstore/keyword-store.ts). */
export type OpportunitySource = "seed" | "autocomplete" | "manual" | "pipeline";

const SOURCE_BADGES: Readonly<Record<OpportunitySource, TrendBadge>> = {
  seed: { label: "Seed", className: "bg-bg-3 text-muted" },
  autocomplete: { label: "Autocomplete", className: "bg-cyan-subtle text-cyan" },
  pipeline: { label: "Pipeline", className: "bg-purple-subtle text-purple" },
  manual: { label: "Manual", className: "bg-success-subtle text-success" },
};

const UNKNOWN_SOURCE_BADGE: TrendBadge = { label: "Unknown", className: "bg-bg-3 text-faint" };

/**
 * Maps a keyword's `source` provenance to a display label + Tailwind
 * className. `null` (not yet backfilled / unknown) and unrecognized values
 * fall back gracefully rather than throwing.
 */
export function sourceBadge(source: string | null): TrendBadge {
  if (!source) return UNKNOWN_SOURCE_BADGE;
  return (
    SOURCE_BADGES[source as OpportunitySource] ?? {
      label: source,
      className: UNKNOWN_TREND_CLASSNAME,
    }
  );
}

// ─── First-found formatting ─────────────────────────────────────────────────

/**
 * Formats an epoch-seconds "first found" timestamp as a short relative
 * string (e.g. "3d ago"), delegating to the shared {@link timeAgo}
 * formatter. `null` (unknown / not yet backfilled) renders as a dash rather
 * than "just now" or an epoch-zero date.
 */
export function formatFirstFound(epochSeconds: number | null): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return "—";
  return timeAgo(epochSeconds);
}

// ─── Search filter ──────────────────────────────────────────────────────────

/**
 * Case-insensitive substring match for the Opportunities search box. Kept
 * pure/exported (rather than inlined in the component) so the filter
 * predicate is unit-testable independent of any DOM/React rendering.
 */
export function matchesKeywordSearch(keyword: string, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return true;
  return keyword.toLowerCase().includes(trimmed);
}
