# App Store Keyword-Gap Scanner — Design

- **Date:** 2026-07-09
- **Branch:** `feat/appstore-keyword-gap-scanner`
- **Status:** Draft for review
- **Owner subsystems:** `src/sources/appstore`, `src/store/migrations`, `src/pipelines/ideas`, `src/web`

---

## 1. Problem

OpenCrow's idea funnel is **complaint-driven and ranking-driven**. It mines
what users hate about existing apps (`demand-probes.ts` over ≤2★
`appstore_reviews`), what is climbing the charts (`collectors.ts` /
`incumbents.ts` over `appstore_rankings`), and cross-references capabilities from
other sources. It has **no per-search-term supply/demand analysis**: nothing
measures, for a given search phrase, *how much demand exists* versus *how strong
and how weak the apps that currently rank for it are*.

That is the single most direct signal of a buildable app opportunity — a search
term people use, served only by weak or absent incumbents. It is also, per the
`DemandArtifact` contract, literally the definition of **whitespace** ("demand
intensity minus supply density"), a field the pipeline currently only *infers*
from scraped mega-app corpora.

Two consequences today:

1. **Niche whitespace is invisible.** The scraped App Store corpus is dominated
   by consumer mega-apps; niche and B2B categories legitimately fall to the
   demand **absence floor** (score 1) because no scraped row represents them
   (confirmed prior finding). A term like `fatty liver diet` — low competition,
   real and heating demand, uniformly weak incumbents — never enters the funnel.
2. **No opportunity ranking primitive.** There is no cheap, deterministic score
   that says "this keyword is an open lane," so the expensive LLM
   competability/synthesis stages have no upstream whitespace prior to focus on.

## 2. Goal

Add an **App Store keyword-gap scanner**: a scheduled sweep that, per keyword,
computes a deterministic **competitiveness / demand / incumbent-weakness /
trend / opportunity** profile from live iTunes data, persists it with history,
and feeds it into the existing idea funnel two ways — as **demand/whitespace
evidence** for candidates and as **seed signals** that spawn ideas — plus a
dashboard surface for direct human browsing.

### Non-goals

- Not replacing the review-complaint or ranking collectors — this is additive.
- Not the LLM per-idea competability judge (`competability.ts`, 0–5, moat
  dimensions). That stays downstream; the keyword scanner is a cheap upstream
  *supply-side* prior, not the moat verdict.
- Not Play Store in v1 (schema and scorer are store-agnostic; Play Store is a
  fast follow using the same tables with `store = 'play'`).
- No paid APIs. iTunes Search API + RSS + autocomplete hints only (already used).

## 3. Success criteria

- A daily cron scans a genre slice of a seed corpus without exceeding iTunes
  rate limits, writing one `appstore_keyword_scans` row per keyword per run.
- The scorer reproduces the reference anchors within tolerance on fixtures
  (calibration targets from the `appstore-mcp-server` we validated against:
  `glucose tracker`≈25, `fatty liver diet`≈21, `receipt scanner`≈81,
  `ai resume builder`≈77 competitiveness).
- A candidate whose keywords match a high-opportunity scan gets a
  `DemandEvidence` of the new kind, raising its `whitespace` with an auditable
  `sourceId`.
- Top opportunity gaps appear as seeds in a pipeline run and as rows in a new
  dashboard "Opportunities" tab, sortable by opportunity score with trend
  sparklines.
- All three test lanes green; `security-reviewer` clean on the diff.

## 4. Architecture

```
                 ┌─────────────────────────────────────────────┐
   corpus  ──►   │  keyword-gap scan (scheduled, genre-sliced)  │
 (seed table)    │  src/sources/appstore/keyword-gaps.ts        │
                 │   • fetch top-N via iTunes Search API        │
                 │   • score: competitiveness / demand /        │
                 │     incumbent-weakness / trend / opportunity │
                 └───────────────┬─────────────────────────────┘
                                 │ upsert
                 ┌───────────────▼─────────────────────────────┐
                 │  appstore_keywords  +  appstore_keyword_scans│  (migration 031)
                 │  (corpus)              (per-run snapshot,     │
                 │                         history → trend)      │
                 └───────┬───────────────────────┬──────────────┘
        demand path      │                       │   seed path
       ┌─────────────────▼──────┐     ┌──────────▼───────────────────┐
       │ demand enrichment      │     │ collector-keyword-gaps.ts    │
       │ new DemandEvidenceKind │     │ top gaps → synthesis seeds   │
       │ → DemandArtifact.      │     │ (feeds trends/pain stage)    │
       │   whitespace           │     └──────────┬───────────────────┘
       └─────────────────┬──────┘                │
                         └──────────► ideas pipeline ── ideas
                                                 │
                 ┌───────────────────────────────▼──────────────┐
                 │  dashboard: AppStore.tsx "Opportunities" tab  │
                 │  web/routes/appstore.ts new endpoints         │
                 └───────────────────────────────────────────────┘
```

Five components, each following an existing OpenCrow pattern.

## 5. Components

### 5.1 Keyword corpus — `appstore_keywords` + seeding

A seed table of terms to scan, tagged by genre-zone and provenance.

- **Columns (domain):** `keyword` (PK, normalized lowercase), `genre_zone`
  (e.g. `health`, `finance`, `productivity`…), `source`
  (`seed` | `autocomplete` | `manual` | `pipeline`), `active` (bool),
  `created_at`, `last_scanned_at`.
- **Seed generation** (`keyword-corpus.ts`, pure): category base-nouns ×
  modifiers (`tracker, log, planner, diary, reminder, coach, ai, diet,
  calculator, app`) + long-tail `X for Y` templates. Deterministic, unit-tested.
- **Autocomplete expansion:** a periodic job hits Apple's public search-hints
  endpoint for high-opportunity winners and inserts `source='autocomplete'`
  terms (bounded fan-out). This is the corpus's growth loop.

### 5.2 Keyword-gap scorer — `keyword-gaps.ts` (pure core + thin IO shell)

For each keyword: fetch the top-N (N=20) `entity=software&country=us` results via
the existing SSRF-safe fetch, then compute — all as **pure functions** over the
fetched rows so they are unit-testable without network:

| Metric | Definition (deterministic) |
|---|---|
| `demand` | mean `ratingsPerDay` across top-N, where `ratingsPerDay = userRatingCount / max(ageDays, 1)`. Live demand proxy. |
| `competitiveness` (0–100) | monotone combine of log-scaled `topAppReviews`, log-scaled mean `ratingsPerDay`, and title/description match density. Calibrated to reference anchors (§3) via fixtures. |
| `incumbent_weakness` (0–1) | high when top-N mean rating is low, review counts are thin, and apps are old/stale (large `avgAgeDays`, few recent updates). |
| `trend` | `heating` / `stable` / `cooling` from current `demand` vs the previous scan's `demand` for the same keyword (needs history; first scan = `new`). |
| `opportunity` (0–1) | `demandNorm × (1 − competitiveness/100) × (0.5 + 0.5·incumbent_weakness) × trendMultiplier`. This is the headline rank key and maps to `DemandArtifact.whitespace`. |

Raw fetched metrics (`topAppReviews`, `avgAgeDays`, `avgRating`,
`newestVelocity`, `establishedVelocity`) are persisted too, for auditability and
recalibration. **Calibration is a fixture-locked unit test**: the anchor
keywords with their expected competitiveness bands.

### 5.3 Storage — migration `031_appstore_keyword_gaps.sql`

Two tables, `IF NOT EXISTS`, idempotent, mirroring the existing appstore
`XRow`/`rowToX`/`readonly` split in a new `keyword-store.ts`:

- **`appstore_keywords`** — the corpus (§5.1).
- **`appstore_keyword_scans`** — one row per (keyword, scan run): `store`
  (`app` | `play`, default `app`), `keyword`, `scanned_at`, `competitiveness`,
  `demand`, `incumbent_weakness`, `opportunity`, `trend`, plus the raw metrics
  and a `top_apps` JSONB snapshot (the top-N ids/names/ratings for the citation
  trail). Indexes: `(keyword, scanned_at DESC)` for latest+history,
  `(scanned_at DESC, opportunity DESC)` for "today's top gaps."

`store` is included from day one so Play Store is a data-only follow-up.

### 5.4 Scheduled scan — day-by-day genre slices

A scan job (new cron entry, or a scheduled capability on the appstore scraper —
decision in §12) that each run:

1. Selects the day's **genre-zone slice** of `active` corpus keywords, ordered by
   stalest `last_scanned_at`.
2. Scans them with a concurrency cap + inter-request delay honoring iTunes limits
   (reuse the scraper's existing throttle; ≈250–350 keywords/day sustainable).
3. Upserts scans, updates `last_scanned_at`, logs slice summary.

Cadence config-driven (`scanIntervalMs`, `dailyKeywordBudget`,
`genreZoneRotation`). Steady state after the first full pass = re-scan watchlist
+ rotate a fresh slice + autocomplete-expand winners, so gaps surface *as they
open*.

### 5.5 Demand integration — new `DemandEvidenceKind`

Add `"appstore_gap"` to `DEMAND_EVIDENCE_KINDS`. In demand enrichment
(`demand-probes.ts` / `demand.ts`): when a candidate's extracted keywords match a
scanned term with high `opportunity`, emit a `DemandEvidence`:

- `kind: "appstore_gap"`, `query: <keyword>`, `count: <weighted, real>` derived
  from the scan's demand velocity (a **real measured number**, never an LLM
  assertion — honors the existing contract), `sourceId: <scan row id>`,
  `quote`: a top-incumbent name + rating for the audit trail.
- Add its weight to `DEMAND_KIND_WEIGHTS`. Because `opportunity` already encodes
  "wanted but underserved," it should feed `whitespace` strongly. Calibrated so
  it cannot single-handedly saturate demand (respects `SCORE_SATURATION`).

This directly lifts the niche-whitespace-invisible defect (§1.1): the probe no
longer depends on a niche existing in the scraped mega-app corpus.

### 5.6 Seed path — `collector-keyword-gaps.ts`

A fourth collector alongside `analyzeAppLandscape` / `clusterReviews` /
`scanCapabilities`, consuming `CollectorContext`. It selects the current top-K
opportunity gaps (fresh, deduped against consumed via `consumption.ts`) and emits
them as synthesis seeds tagged `store:"appstore"`, `signalType:"keyword_gap"`, so
`shallow-ideation` / `synthesizer` turn a gap like `fatty liver diet` into
*generated, scored ideas* — not just a report row. Honors the existing
per-source and (source×signalType) share ceilings so gaps can't monopolize seeds.

### 5.7 Dashboard — "Opportunities" tab

- **API:** extend `src/web/routes/appstore.ts` with `GET /appstore/opportunities`
  (latest scan per keyword, sortable by `opportunity`, filter by genre-zone/trend)
  and `GET /appstore/opportunities/:keyword` (scan history for sparklines). Zod on
  query params.
- **UI:** a tab on `src/web/ui/views/AppStore.tsx`: sortable gap table
  (keyword, opportunity, competitiveness, demand, incumbent-weakness, trend), a
  watchlist star, and a trend sparkline per row. React 19 conventions.

### 5.8 (Optional) agent tool — `analyze_keyword_gap`

Expose an on-demand `analyze_keyword_gap(keyword)` tool via `createAppStoreTools`
so agents (Telegram/web) can pull a live gap profile conversationally, reusing the
§5.2 scorer. Low cost, high leverage; included in the full build.

## 6. Data flow (end to end)

1. Cron picks the day's genre slice from `appstore_keywords`.
2. Scorer fetches top-N per keyword, computes the profile, upserts a
   `appstore_keyword_scans` row, sets `last_scanned_at`.
3. **Demand path:** during a pipeline run, `enrichDemand` matches candidate
   keywords to recent scans → `appstore_gap` evidence → raises `whitespace`.
4. **Seed path:** `collector-keyword-gaps` pulls top fresh gaps → synthesis seeds
   → ideas.
5. **Human path:** dashboard reads latest + history for browsing/watchlisting.
6. Autocomplete expansion grows the corpus from winners; trend recomputes each
   re-scan.

## 7. Safety, rate limits, correctness

- **SSRF:** all fetches via `src/sources/shared/ssrf-safe-fetch.ts`. Only the
  fixed iTunes hosts.
- **Rate limiting:** reuse the appstore scraper's throttle; hard daily budget;
  exponential backoff on 403/429; a slice that fails partway is resumable
  (stalest-first ordering makes retries self-healing).
- **Determinism:** scoring is pure and fixture-tested; no LLM in the scoring
  path (LLM only later, in synthesis).
- **Immutability / strict TS / Zod / Biome / `Bun.sql`** per repo conventions.
- **No PII:** keywords + public app metadata only.

## 8. Config additions (`src/config/schema.ts`)

Under the demand-side grounding block, a `appstoreKeywordGap` section:
`enabled`, `scanIntervalMs`, `dailyKeywordBudget`, `topN` (default 20),
`genreZoneRotation`, `demandWeight`, `opportunityThresholdForSeed`,
`autocompleteExpansion.enabled`. All Zod-defaulted; safe when absent.

## 9. Error handling

- Fetch failure for one keyword → log + skip that keyword, never abort the slice.
- Empty/again-throttled result → record no scan (not a zero-score row) so trend
  isn't corrupted by a failed fetch.
- Migration is idempotent and non-fatal on startup per convention.
- Demand/collector integrations degrade to no-op when the tables are empty (first
  boot before any scan), exactly like the existing "rankings may be absent"
  fall-throughs.

## 10. Testing plan

- **Unit (`*.test.ts`)**: corpus generation; every scorer function; the
  calibration fixture (anchor keywords → expected competitiveness bands); trend
  classification from synthetic history; opportunity formula edge cases;
  demand-evidence mapping; collector selection + dedup + share-ceiling.
- **Integration (`*.integration.test.ts`)**: migration applies; upsert/read of
  scans; `GET /appstore/opportunities` shape against a seeded DB; demand
  enrichment reading a real scan row.
- **Isolated (`*.isolated.test.ts`)**: any `mock.module` fetch stubs for the IO
  shell (mocked iTunes responses → deterministic scores).
- Coverage ≥80% on new business logic. `qa-test-engineer` owns the sweep.

## 11. Rollout / operation (the day-by-day plan, productized)

| Phase | Action |
|---|---|
| Migration + scorer + store | land tables and the pure scorer with fixtures |
| Seed corpus | generate + insert the base corpus (all genre-zones) |
| First full pass (~2 wks) | cron scans one genre-zone/day; watchlist emerges |
| Wire demand + collector | gaps start enriching candidates and seeding ideas |
| Dashboard | Opportunities tab live for human browsing |
| Steady state | daily re-scan of watchlist + rotate slice + autocomplete-expand |

## 12. Open decisions (resolve during writing-plans)

1. **Scan host:** new dedicated cron job vs. a scheduled capability inside the
   existing appstore scraper process. Leaning **scheduled capability in the
   appstore scraper** (co-located with `scraper.ts`, reuses its throttle and
   lifecycle) unless process isolation is preferred.
2. **`demandWeight` calibration:** start conservative; tune against
   `competability-calibration` / outcome memory once real ideas flow.
3. **Autocomplete expansion in v1** or fast-follow (corpus works without it).

## 13. File-by-file change map (→ owning agent per RULE 2)

| File | Change | Agent |
|---|---|---|
| `src/store/migrations/031_appstore_keyword_gaps.sql` | new tables | `senior-backend-engineer` |
| `src/sources/appstore/keyword-store.ts` | Row/rowTo/upsert/read | `senior-backend-engineer` |
| `src/sources/appstore/keyword-corpus.ts` | pure corpus gen | `scraper-integrations-engineer` |
| `src/sources/appstore/keyword-gaps.ts` | scorer + scan sweep | `scraper-integrations-engineer` |
| `src/sources/appstore/scraper.ts` | wire scheduled scan (if §12.1 = capability) | `scraper-integrations-engineer` |
| `src/pipelines/ideas/demand.ts` / `demand-probes.ts` | `appstore_gap` kind + enrichment | `senior-backend-engineer` |
| `src/pipelines/ideas/collector-keyword-gaps.ts` | seed collector | `senior-backend-engineer` |
| `src/config/schema.ts` | `appstoreKeywordGap` config | `senior-backend-engineer` |
| `src/tools/appstore.ts` | optional `analyze_keyword_gap` tool | `senior-ai-engineer` |
| `src/web/routes/appstore.ts` | opportunities endpoints | `senior-backend-engineer` |
| `src/web/ui/views/AppStore.tsx` | Opportunities tab | `senior-frontend-engineer` |
| tests across lanes | per §10 | `qa-test-engineer` |
| diff review | prompt-injection/SSRF/SQL/secret review | `security-reviewer` |

---

*Next step after approval: `superpowers:writing-plans` → phased implementation
plan, then dispatch the owning agents per the map above.*
