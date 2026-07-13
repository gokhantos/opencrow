# Buildability Score — Design (Phase 1 of keyword-value roadmap)

**Date:** 2026-07-14
**Screen:** App Store → Keyword Research → Opportunities table.
**Goal:** One explicit 0–100 "can a solo dev win this?" number, so the user
sorts by a single trustworthy metric instead of eyeballing four sub-scores.

## Context / roadmap
Follows the shipped buildable-filters work. Next phases (separate specs):
2) cluster keywords → app concepts (will rank clusters BY this score),
3) review-gap deep-dive, 4) external demand signal (research spike first).
This phase is the small, foundational quick win.

## The score (solo-indie calibrated)
Pure, deterministic function of already-stored per-keyword fields
(`demand`, `top_app_reviews`, `avg_rating`). No trend (trend history is thin,
~1.72 scans/keyword). Distinct from `opportunity`: it HARD-GATES on real demand
(no searches → 0) and centers on out-competing the TOP incumbent specifically.

```
norm(x, ref)  = clamp01( ln(1+x) / ln(1+ref) )
demandFactor  = norm(demand, 50)                      # real search interest
reviewOpening = clamp01( 1 - norm(topAppReviews, 5000) )  # few incumbent reviews → big opening
ratingOpening = clamp01( (4.5 - avgRating) / 1.5 )    # incumbents ≤3.0★ → wide open
opening       = 0.65*reviewOpening + 0.35*ratingOpening
buildability  = round( 100 * demandFactor * opening ) # 0..100, demand multiplicative gate
```
- **REVIEW_REF = 5000** (the "beatable solo" ceiling — user-chosen).
- Bands for the badge: 🟢 ≥70, 🟡 40–69, ⚪ <40.

## Implementation — read-time, NO migration
Buildability is a deterministic function of stored columns, so compute it at
READ time. This applies instantly to all ~37k existing rows and needs no rescan.

### Backend
- `src/sources/appstore/keyword-scoring.ts`
  - `export const BUILDABILITY_REVIEW_REF = 5000`
  - `export function computeBuildability(a: { demand; topAppReviews; avgRating }): number`
    — the CANONICAL formula above (pure, unit-tested).
- `src/sources/appstore/keyword-store.ts`
  - Add a SQL expression that mirrors `computeBuildability` exactly, over the
    `s` (DISTINCT ON latest-scan) columns, e.g.
    `round(100 * least(1,greatest(0, ln(1+s.demand)/ln(1+50))) *
      (0.65*least(1,greatest(0, 1 - ln(1+s.top_app_reviews)/ln(1+5000)))
       + 0.35*least(1,greatest(0,(4.5-s.avg_rating)/1.5))))`
  - Return it in each row as `buildability: number`.
  - Add `buildability` to the `SortKey` whitelist (`SORT_COLUMNS`) — the ORDER BY
    value is the full CONSTANT expression string (still no user input in ORDER BY,
    whitelist safety preserved).
  - Add optional `minBuildability?: number` filter (0..100), applied to BOTH the
    page and COUNT queries via the shared filter clause (parameterized `${...}`).
- `src/web/routes/appstore.ts`
  - `sort` enum gains `"buildability"`.
  - New Zod param `minBuildability: z.coerce.number().min(0).max(100).optional()`.

### Drift guard (critical)
The SQL expression and the TS `computeBuildability` MUST agree. An integration
test fetches rows and asserts, for each, that the row's server `buildability`
equals `computeBuildability({demand, topAppReviews, avgRating})` (allowing ±1 for
rounding). This fails loudly if the two formulas drift.

### Frontend (`OpportunitiesTab.tsx`)
- Add a **Buildability** column: the number + a band badge (🟢/🟡/⚪). Sortable
  (server-side, `sort=buildability`).
- The **Indie sweet spot** preset's default sort changes from `opportunity` to
  `buildability` desc (opportunity stays a visible sortable column).
- Optionally show the badge in the row-expand verdict line.
- `OpportunityRow` client type gains `buildability: number`.

## Non-goals
No migration/stored column, no scanner change, no trend in the score, no new
external data. Clustering and review-gap are later phases.

## Testing
- Unit: `computeBuildability` — demand=0 → 0; low-review+low-rating high demand → high;
  clamps; rounding; REVIEW_REF sensitivity.
- Integration: SQL buildability == TS computeBuildability per row (drift guard);
  `sort=buildability` orders correctly; `minBuildability` bounds the set + `total`
  reflects it; route rejects minBuildability>100 → 400.
- UI isolated: buildability column + badge render; sweet-spot preset default-sorts
  by buildability; column header sorts by it.

## Success criteria
Sorting by Buildability (default in the sweet-spot view) puts genuinely
solo-winnable keywords (real demand + weak, low-review incumbents) at the top,
as a single 0–100 number with an at-a-glance badge.
