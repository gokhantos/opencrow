# Buildable-Keyword Filters — Design

**Date:** 2026-07-13
**Screen:** App Store → Keyword Research → Opportunities table (`OpportunitiesTab`)
**Goal:** Let the user find the keywords worth building an app on. Today, sorting
by Opportunity buries the good ones under dead/noise terms and there's no way to
filter to the buildable, indie-beatable sweet spot.

## Problem (confirmed by the user)

All four of these are true today:
1. Junk / noise terms crowd the top (generic words, brand fragments mined from app names).
2. No filtering — just one giant sorted list.
3. Can't judge buildability per keyword — a term alone doesn't show if incumbents are beatable.
4. Ranking "feels off" — low-search / un-buildable terms outrank obviously good ones.

**Ambition calibration:** solo / indie. "Beatable" = incumbents with modest review
counts and/or mediocre ratings; real-but-not-giant demand.

## Data reality (live DB, n = 37,443 distinct keyword+store)

- **54%** of keywords have `demand < 1` rating/day — effectively dead.
- `demand` p50 = 0.70, p90 = 45.25; `competitiveness` p50 = 40.6;
  `incumbent_weakness` p50 = 0.07, p90 = 0.60; `opportunity` p50 = 0.043, p90 = 0.203.
- **~163** keywords satisfy `demand ≥ 5 AND competitiveness ≤ 45 AND incumbent_weakness ≥ 0.4`
  — the genuinely buildable set. Weak incumbents (`iw ≥ 0.4`) are ~top-10% rare.

Implication: cutting dead demand + noise words, and jumping straight to the sweet
spot, is the whole fix. No new scoring formula is needed — the demand floor is what
corrects "ranking feels off."

## Scope — Approach 1 (Filter-first). Approved.

### A. Junk suppression (server-side)
A `hideJunk` predicate applied in the opportunities query:
- Curated stoplist (case-insensitive, whole-keyword or sole-token match):
  `free, pro, app, apps, best, top, new, online, mobile, hd, lite, download, game`
  plus the brand fragments already stripped by `keyword-miner.ts` (reuse its brand
  set if exported; otherwise a small local list). Keep the list in ONE named
  constant so it's easy to extend.
- Drop keywords shorter than 3 characters and purely numeric/symbol keywords.
- Implemented as SQL `WHERE` conditions gated by the `hideJunk` flag. The stoplist
  is a bound array parameter (`k.keyword ILIKE ANY(...)` / `<> ALL(...)`), never
  string-interpolated.

### B. Filter bar + presets (server-side facets)
Extend `GET /api/appstore/opportunities` with bounded, optional params (all
Zod-validated; omitted = no constraint):
- `minDemand` (number ≥ 0)
- `maxCompetitiveness` (number 0..100)
- `minIncumbentWeakness` (number 0..1)
- `minOpportunity` (number 0..1)
- `hideJunk` (boolean, default false at the API; the UI sends true for presets)
- existing: `trend`, `genreZone`, `limit`, `offset`, `sort`, `dir`

`meta.total` continues to reflect the full filtered set so pagination stays correct.

**Preset buttons** in the UI (each just sets the filter state, resets to page 0):
- **Indie sweet spot** (DEFAULT on load): `minDemand=5, maxCompetitiveness=45,
  minIncumbentWeakness=0.4, hideJunk=true`, sort `opportunity desc`.
- **Heating:** `trend=heating, minDemand=3, hideJunk=true`.
- **All:** clears every filter, `hideJunk=false`.

The active preset is highlighted; changing any individual filter switches the
active preset to "Custom".

### C. Incumbents in the row-expand panel (frontend only)
The row already carries `topApps: TopApp[]` (name, reviews, rating, ageDays,
ratingsPerDay, titleMatch). In the expand panel (currently just the trend
sparkline) add a compact incumbents table/list:
- top ~5 apps: name, reviews (thousands-formatted), rating (`x.x★`), age, a
  "title match" chip.
- A one-line verdict derived from the row, e.g.
  *"Strong demand, weak incumbents — top app: 1.8k reviews @ 3.6★ → beatable."*
  Verdict wording keys off demand / competitiveness / incumbentWeakness bands.
No backend change for this piece.

### D. Ranking
No new score. The default view's demand floor removes the dead-term noise that
made the ranking feel off. Opportunity remains the default sort; all sub-scores
stay visible as sortable columns and as filters (satisfies "show me the math").

## Non-goals (YAGNI)
- No bespoke "Buildability" score (deferred fast-follow only if the sweet-spot
  view still feels off).
- No keyword search box (declined earlier).
- No changes to the scanner / scoring math in `keyword-scoring.ts`.
- No new DB columns or migration — everything is query-time filtering over existing data.

## Files
- `src/sources/appstore/keyword-store.ts` — extend `getTopOpportunities` with the
  new filter opts + junk predicate; keep whitelist ORDER BY + `{ rows, total }` shape.
- `src/web/routes/appstore.ts` — extend `opportunitiesQuerySchema` + pass-through.
- `src/web/ui/views/appstore/OpportunitiesTab.tsx` — filter/preset bar, default
  preset, incumbents in expand panel.
- Small helper for the junk stoplist + (optionally) `opportunities-format.ts` for
  the verdict string.
- Tests: `keyword-store.integration.test.ts`, `appstore.integration.test.ts`,
  `OpportunitiesTab.isolated.test.ts`.

## Testing
- Store: junk predicate removes stoplist/short/numeric terms; each numeric filter
  bounds the set; `total` reflects filtered count; presets' combined filters return
  the expected subset; ORDER BY whitelist still safe.
- Route: Zod bounds (reject out-of-range `maxCompetitiveness`, `minIncumbentWeakness`,
  etc. → 400); filters pass through to the store.
- UI: default load fires the Indie-sweet-spot query; preset buttons set the right
  params + reset page; incumbents render in expand; empty-state when a filter set
  returns nothing.

## Success criteria
Opening the screen shows a short, high-signal list of buildable keywords (not the
dead 54%); presets switch between sweet-spot / heating / all in one click; expanding
a row shows the incumbents so the user can eyeball beatability.
