// Pure formatting/state helpers for the App Store "Opportunities" dashboard
// tab. Kept side-effect-free and framework-agnostic so they're trivially unit
// testable without rendering React. See also
// docs/superpowers/specs/2026-07-13-buildable-keyword-filters-design.md for
// the buildable-keyword filter/preset design this half of the file backs.

import { formatNumber, timeAgo } from "../../lib/format";

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

// ─── Buildability band (0..100 "can a solo dev win this?" score) ───────────
// See docs/superpowers/specs/2026-07-14-buildability-score-design.md — the
// score itself is computed server-side (`computeBuildability` in
// keyword-scoring.ts); this is purely the display-band mapping.

export interface BuildabilityBand {
  readonly label: string;
  readonly className: string;
  /** At-a-glance emoji indicator, per the design spec (🟢/🟡/⚪). */
  readonly dot: string;
}

const BUILDABILITY_STRONG_THRESHOLD = 70;
const BUILDABILITY_MODERATE_THRESHOLD = 40;

/**
 * Maps a 0..100 buildability score to a display band: 🟢 "Strong" (>=70),
 * 🟡 "Moderate" (40..69), ⚪ "Weak" (<40). Pure and total — any finite input
 * (including out-of-range) falls into one of the three bands.
 */
export function buildabilityBand(score: number): BuildabilityBand {
  if (score >= BUILDABILITY_STRONG_THRESHOLD) {
    return { label: "Strong", className: "bg-success-subtle text-success", dot: "🟢" };
  }
  if (score >= BUILDABILITY_MODERATE_THRESHOLD) {
    return { label: "Moderate", className: "bg-warning-subtle text-warning", dot: "🟡" };
  }
  return { label: "Weak", className: "bg-bg-3 text-faint", dot: "⚪" };
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

// ─── Cluster label formatting (Concepts view) ───────────────────────────────
// A cluster's `label` is the raw text of its highest-demand member keyword
// (see `keyword-clustering.ts`) — typically lowercase, e.g. "meal planner".
// Title-cased purely for display so concept cards read like app names.

/**
 * Title-cases a cluster label for display, e.g. `"meal planner"` ->
 * `"Meal Planner"`. Pure and total: empty/whitespace-only input round-trips
 * unchanged rather than throwing.
 */
export function titleCaseLabel(label: string): string {
  return label
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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

// ─── Table cell formatters (shared with the leaderboard columns) ────────────

export function formatDemand(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

export function formatCompetitiveness(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toString();
}

export function formatStore(store: "app" | "play" | "DE"): string {
  if (store === "play") return "Play";
  if (store === "DE") return "App Store (DE)";
  return "App Store";
}

export function formatTopAppReviews(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

export function formatAvgRating(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

export function formatAvgAgeDays(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

// ─── Incumbent snapshot (row-level, powers the row-expand incumbents panel) ──

/** Mirrors `TopApp` (src/sources/appstore/keyword-types.ts), display fields only. */
export interface TopApp {
  readonly id: string;
  readonly name: string;
  readonly reviews: number;
  readonly rating: number;
  readonly ageDays: number;
  readonly ratingsPerDay: number;
  readonly titleMatch: boolean;
}

// ─── Buildable-keyword filters + presets ─────────────────────────────────────
// The screen opens on the "Indie sweet spot" preset (not the full corpus) —
// sorting by raw Opportunity alone buries buildable keywords under dead/noise
// terms, so the default view applies a demand floor + junk suppression.

/** Mirrors the backend's `GapTrend` enum, for the `trend` filter only. */
export type TrendFilterValue = "heating" | "stable" | "cooling" | "new";

export const TREND_OPTIONS: ReadonlyArray<{
  readonly value: TrendFilterValue | "";
  readonly label: string;
}> = [
  { value: "", label: "Any trend" },
  { value: "heating", label: "Heating" },
  { value: "stable", label: "Stable" },
  { value: "cooling", label: "Cooling" },
  { value: "new", label: "New" },
];

export interface FilterState {
  readonly trend: TrendFilterValue | null;
  readonly minDemand: number | null;
  readonly maxCompetitiveness: number | null;
  readonly minIncumbentWeakness: number | null;
  readonly minOpportunity: number | null;
  readonly minBuildability: number | null;
  readonly hideJunk: boolean;
}

export type PresetId = "indie" | "heating" | "all";

/** A sort key/dir the component owns — kept as a loose string pair here to avoid a type-only import cycle. */
export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly filters: FilterState;
  /** Only the Indie preset pins sort/dir per the design spec — Heating/All leave the current sort alone. */
  readonly sort?: string;
  readonly dir?: "asc" | "desc";
}

export const ALL_FILTERS: FilterState = {
  trend: null,
  minDemand: null,
  maxCompetitiveness: null,
  minIncumbentWeakness: null,
  minOpportunity: null,
  minBuildability: null,
  hideJunk: false,
};

export const INDIE_FILTERS: FilterState = {
  trend: null,
  minDemand: 5,
  maxCompetitiveness: 45,
  minIncumbentWeakness: 0.4,
  minOpportunity: null,
  minBuildability: null,
  hideJunk: true,
};

export const HEATING_FILTERS: FilterState = {
  trend: "heating",
  minDemand: 3,
  maxCompetitiveness: null,
  minIncumbentWeakness: null,
  minOpportunity: null,
  minBuildability: null,
  hideJunk: true,
};

// The "Indie sweet spot" preset defaults to sorting by Buildability (the
// headline "can a solo dev win this?" score) rather than raw Opportunity —
// see docs/superpowers/specs/2026-07-14-buildability-score-design.md.
// Opportunity remains a visible, independently sortable column.
export const INDIE_PRESET: Preset = {
  id: "indie",
  label: "Indie sweet spot",
  filters: INDIE_FILTERS,
  sort: "buildability",
  dir: "desc",
};
export const HEATING_PRESET: Preset = { id: "heating", label: "Heating", filters: HEATING_FILTERS };
export const ALL_PRESET: Preset = { id: "all", label: "All", filters: ALL_FILTERS };

export const PRESETS: readonly Preset[] = [INDIE_PRESET, HEATING_PRESET, ALL_PRESET];

export function filtersEqual(a: FilterState, b: FilterState): boolean {
  return (
    a.trend === b.trend &&
    a.minDemand === b.minDemand &&
    a.maxCompetitiveness === b.maxCompetitiveness &&
    a.minIncumbentWeakness === b.minIncumbentWeakness &&
    a.minOpportunity === b.minOpportunity &&
    a.minBuildability === b.minBuildability &&
    a.hideJunk === b.hideJunk
  );
}

/** Which preset (if any) the current filter state matches — `null` means "Custom". */
export function matchPreset(filters: FilterState): PresetId | null {
  return PRESETS.find((p) => filtersEqual(p.filters, filters))?.id ?? null;
}

// ─── Numeric filter drafts (debounced text inputs) ──────────────────────────

export interface NumericDraft {
  readonly minDemand: string;
  readonly maxCompetitiveness: string;
  readonly minIncumbentWeakness: string;
  readonly minOpportunity: string;
  readonly minBuildability: string;
}

export function toDraft(filters: FilterState): NumericDraft {
  return {
    minDemand: filters.minDemand === null ? "" : String(filters.minDemand),
    maxCompetitiveness: filters.maxCompetitiveness === null ? "" : String(filters.maxCompetitiveness),
    minIncumbentWeakness:
      filters.minIncumbentWeakness === null ? "" : String(filters.minIncumbentWeakness),
    minOpportunity: filters.minOpportunity === null ? "" : String(filters.minOpportunity),
    minBuildability: filters.minBuildability === null ? "" : String(filters.minBuildability),
  };
}

/** Blank/whitespace-only or non-finite input means "unset" — never sent as NaN. */
export function parseDraftNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// ─── Keyword verdict (pure, unit-testable — no React) ───────────────────────
// Derives a one-line buildability read from the row's demand/incumbent-
// weakness bands plus the strongest incumbent, e.g. "Strong demand, weak
// incumbents — top app: 1.8K reviews @ 3.6★ → beatable." Bands echo the
// Indie-sweet-spot preset thresholds (minDemand 5/3, minIncumbentWeakness 0.4)
// so the verdict reads consistently with the filter bar.

export interface VerdictTopApp {
  readonly reviews: number;
  readonly rating: number;
}

export interface VerdictInput {
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly topApps: readonly VerdictTopApp[];
}

function demandBand(demand: number): "low" | "moderate" | "strong" {
  if (demand >= 10) return "strong";
  if (demand >= 3) return "moderate";
  return "low";
}

function weaknessBand(incumbentWeakness: number): "weak" | "moderate" | "strong" {
  if (incumbentWeakness >= 0.4) return "weak";
  if (incumbentWeakness >= 0.15) return "moderate";
  return "strong";
}

function topAppSummary(topApps: readonly VerdictTopApp[]): string | null {
  const top = [...topApps].sort((a, b) => b.reviews - a.reviews)[0];
  if (!top) return null;
  return `top app: ${formatNumber(top.reviews)} reviews @ ${top.rating.toFixed(1)}★`;
}

/** Small, pure, unit-testable helper — no React, no formatting side effects. */
export function keywordVerdict(input: VerdictInput): string {
  const dBand = demandBand(input.demand);
  const wBand = weaknessBand(input.incumbentWeakness);
  const summary = topAppSummary(input.topApps);

  if (dBand === "low") {
    return summary
      ? `Low demand; ${summary} — probably not worth building.`
      : "Low demand — probably not worth building.";
  }

  const demandLabel = dBand === "strong" ? "Strong demand" : "Moderate demand";

  if (wBand === "weak") {
    return summary
      ? `${demandLabel}, weak incumbents — ${summary} → beatable.`
      : `${demandLabel}, weak incumbents → beatable.`;
  }

  if (wBand === "moderate") {
    return summary
      ? `${demandLabel}; incumbents are middling — ${summary}, worth a closer look.`
      : `${demandLabel}; incumbents are middling — worth a closer look.`;
  }

  return summary
    ? `${demandLabel}; incumbents look strong — tough to unseat. (${summary})`
    : `${demandLabel}; incumbents look strong — tough to unseat.`;
}
