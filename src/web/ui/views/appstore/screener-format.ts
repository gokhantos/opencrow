// Pure formatting/state helpers for the App Store "Screener" dashboard tab
// (newborn-velocity signature hits — see keyword-screener.ts). Kept
// side-effect-free and framework-agnostic, mirroring opportunities-format.ts,
// so this is trivially unit-testable without rendering React.

// ─── Domain mirror (SignatureHit as serialized to JSON) ─────────────────────
// Mirrors `SignatureHit` (src/sources/appstore/signature-hits-store.ts).

export type SignatureHitStatus = "new" | "active" | "dismissed";

/** Mirrors `TopApp` (src/sources/appstore/keyword-types.ts), display fields only. */
export interface TopAppSnapshot {
  readonly id: string;
  readonly name: string;
  readonly reviews: number;
  readonly rating: number;
  readonly ageDays: number;
}

export interface SignatureHit {
  readonly keyword: string;
  readonly firstDetectedAt: number;
  readonly lastSeenAt: number;
  readonly timesSeen: number;
  readonly status: SignatureHitStatus;
  readonly competitiveness: number | null;
  readonly demand: number | null;
  readonly trend: string | null;
  readonly newcomerRpd: number | null;
  readonly establishedRpd: number | null;
  readonly velocityRatio: number | null;
  readonly fastNewcomers: number | null;
  readonly acceleratingApps: number | null;
  readonly maxReviews: number | null;
  readonly genreZone: string | null;
  readonly topAppsSnapshot: readonly TopAppSnapshot[];
}

// ─── One-line signature explainer (section header) ──────────────────────────
// Mirrors the validated gate thresholds in `keyword-screener.ts`
// (COMPETITIVENESS_MAX, REQUIRED_TREND, MIN_FAST_NEWCOMERS, VELOCITY_RATIO_MIN)
// — kept as a literal string rather than importing those constants because
// this file must stay framework/bundle-agnostic of the backend module graph.

export const SIGNATURE_SUMMARY =
  "Flags keywords crossing the validated window-opening signature: competitiveness ≤35, heating trend, ≥2 fast newcomers, ≥1.5× newcomer-vs-established velocity — the peptide-tracker / block-shorts signature.";

// ─── Status filter ───────────────────────────────────────────────────────────
// "open" is a synthetic, client-only filter (new + active) that is not one of
// the three server-persisted `status` values (see SIGNATURE_HIT_STATUSES in
// signature-hits-store.ts) — the screener opens on it by default per the
// "defaulting to non-dismissed" design requirement.

export type StatusFilter = "open" | SignatureHitStatus | "all";

export const STATUS_FILTER_TABS: ReadonlyArray<{
  readonly id: StatusFilter;
  readonly label: string;
}> = [
  { id: "open", label: "Open" },
  { id: "new", label: "New" },
  { id: "active", label: "Active" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
];

export const DEFAULT_STATUS_FILTER: StatusFilter = "open";

/**
 * Whether a hit's persisted status matches the selected filter tab. `"open"`
 * (the default) matches anything but `dismissed`; `"all"` matches everything.
 */
export function matchesStatusFilter(status: SignatureHitStatus, filter: StatusFilter): boolean {
  switch (filter) {
    case "open":
      return status !== "dismissed";
    case "all":
      return true;
    default:
      return status === filter;
  }
}

export interface StatusCounts {
  readonly open: number;
  readonly new: number;
  readonly active: number;
  readonly dismissed: number;
  readonly all: number;
}

/** Tallies hits by status for the filter-tab badge counts and the header's NEW count. */
export function countByStatus(hits: readonly SignatureHit[]): StatusCounts {
  let newCount = 0;
  let activeCount = 0;
  let dismissedCount = 0;
  for (const hit of hits) {
    if (hit.status === "new") newCount += 1;
    else if (hit.status === "active") activeCount += 1;
    else dismissedCount += 1;
  }
  return {
    open: newCount + activeCount,
    new: newCount,
    active: activeCount,
    dismissed: dismissedCount,
    all: hits.length,
  };
}

// ─── Status badge ────────────────────────────────────────────────────────────

export const STATUS_BADGE_COLOR_MAP: Readonly<Record<SignatureHitStatus, string>> = {
  new: "blue",
  active: "green",
  dismissed: "gray",
};

// ─── Cell formatters ─────────────────────────────────────────────────────────

/** Formats a velocity ratio (newcomer rpd / established rpd), e.g. `1.5 -> "1.50×"`. */
export function formatVelocityRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

/** Formats a nullable integer-ish metric (fast newcomers / accelerating apps / max reviews). */
export function formatIntOrDash(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

/** Formats a nullable genre-zone label. */
export function formatZone(zone: string | null): string {
  return zone ?? "—";
}
