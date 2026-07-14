# Semantic Keyword Concepts (Phase 2) — Design

**Date:** 2026-07-14
**Goal:** Group the ~37k noisy keywords into **app concepts** (e.g. Music,
Budgeting, Sleep, Flights) so the user sees a short list of *ideas to build*,
not 50 variant rows. Validated by a live spike: local semantic embeddings
produce real concept clusters (Music/Shopping/Travel/Airlines/Food/Banking);
LEXICAL clustering was garbage and is rejected.

## Spike findings that shape this design
- Local Ollama `nomic-embed-text` + greedy cosine (~0.72–0.76) yields good
  concept groups, BUT: (a) a generic-"app" mega-bucket forms, and (b) pure-noise
  clusters ("updated/update/updating"). Both fixed by **junk-prefiltering before
  clustering** + a tuned threshold. So: prefilter hard, then cluster.

## Architecture (batch precompute → serve)
Clustering is expensive + non-realtime, so precompute assignments in a manual
batch job and serve them read-only. No per-request embedding.

### 1. Migration `038_appstore_keyword_clusters.sql`
Idempotent (`IF NOT EXISTS`). Table `appstore_keyword_clusters`:
`keyword TEXT PRIMARY KEY, cluster_id INTEGER NOT NULL, cluster_label TEXT NOT NULL,
similarity REAL, updated_at BIGINT NOT NULL`. Index on `cluster_id`.

### 2. Clustering pipeline (`src/sources/appstore/keyword-clustering.ts`)
Pure, testable core + a thin runner:
- **Candidate selection:** distinct keywords from latest scans with `demand >= 1`
  AND NOT junk. Junk = the existing `JUNK_KEYWORDS` PLUS an EXTENDED generic-noise
  set discovered in the spike (`updated, update, updating, application, applications,
  ios, iphone, ipad, android, recent, what, whats, more, all, full, popular`), plus
  `char_length < 3` / numeric-only. Also drop keywords that are ONLY generic tokens.
  Cap total candidates (e.g. 20000, highest-demand first) to bound compute; `log()`
  what was dropped/capped (no silent truncation).
- **Embed:** via `createEmbeddingProviderFromConfig()` (`.embed(texts)`, batched)
  with the `createEmbeddingCache` in front. L2-normalize vectors.
- **Cluster (pure fn `clusterByCosine(items, threshold)`):** greedy assignment to
  running normalized centroids; `threshold` config (default 0.74). Unit-test this
  on hand-built vectors (no network).
- **Label each cluster:** the member keyword with the highest `demand` (fallback
  highest buildability) becomes `cluster_label`. Store per-keyword `similarity`
  to its centroid.
- **Persist:** upsert assignments into `appstore_keyword_clusters` (replace prior
  run: clear + insert, or upsert + delete-stale, in one transaction).
- **Runner/tool:** an on-demand tool/CLI `appstore:cluster-keywords` (NOT on every
  scraper tick — expensive). Reuse the existing tool/CLI registration pattern.

### 3. Clusters API (`getOpportunityClusters` in keyword-store + route)
`GET /api/appstore/opportunity-clusters` — same filter/pagination/sort surface as
`/opportunities`. SQL: join latest-scan `s` (DISTINCT ON) to
`appstore_keyword_clusters c` on keyword; apply the EXISTING member-level filters
(minDemand/maxCompetitiveness/minIncumbentWeakness/minOpportunity/minBuildability/
hideJunk/trend) BEFORE aggregation; `GROUP BY c.cluster_id, c.cluster_label`.
Per cluster return: `{ clusterId, label, memberCount, maxBuildability, maxOpportunity,
avgDemand, minTopAppReviews, topMembers: [{keyword, buildability, demand, opportunity}] }`
(topMembers = top ~6 by buildability via a lateral/window). Reuse `BUILDABILITY_SQL`.
Sort default by `maxBuildability DESC`; support sort by memberCount/avgDemand.
`meta.total` = distinct cluster count after filters. A separate endpoint
`GET /opportunity-clusters/:clusterId` returns all member keyword rows (full
`OpportunityRow`s) for the expand view.

### 4. UI (`OpportunitiesTab.tsx` + a sibling `ConceptsTab.tsx`)
- A **Keywords | Concepts** toggle at the top of the Keyword Research screen.
- **Concepts view:** cluster cards (or a table) sorted by buildability — each shows
  the label, a Buildability badge (reuse `buildabilityBand`), memberCount, avg demand,
  and the top member keywords as chips. The existing preset/filter bar applies
  (filters flow to the clusters endpoint).
- **Expand a cluster** → fetch `/opportunity-clusters/:id` → render the member
  keywords in the existing opportunities mini-table (reuse row rendering/formatters).
- Empty state when no clusters match / clustering hasn't run yet ("Run the keyword
  clustering job to populate concepts").

## Non-goals (YAGNI)
- No realtime/per-request embedding. No pgvector (vectors are transient in the job).
- No auto-refresh on scraper ticks (manual tool for now). No change to the existing
  demand/opportunity/buildability formulas. No cross-store (Play) data (none exists).

## Security
- The cluster tool + endpoints are internal/bearer-auth (same as opportunities).
- Clustering reads only our own DB + local Ollama (no external calls, no SSRF).
- SQL: reuse the parameterized/whitelist patterns; cluster label/keyword are our
  data but still bind as parameters.

## Testing
- Unit: `clusterByCosine` (groups near-duplicate vectors, splits distant ones,
  threshold sensitivity, singleton handling); junk-prefilter drops the noise set +
  keeps real multi-word concepts; label = highest-demand member.
- Integration: seed scans + cluster rows (nonce keywords — NEVER real corpus
  strings), assert `getOpportunityClusters` aggregates correctly, filters at member
  level, paginates, `meta.total` = cluster count; `/opportunity-clusters/:id`
  returns members.
- UI isolated: toggle switches views + fires the clusters query; cluster card
  renders label/badge/members; expand fetches + renders members.
- The live embedding run is validated MANUALLY by running the tool + eyeballing
  cluster quality before ship (not in CI).

## Success criteria
The Concepts view opens on a short, sorted list of real app-concept cards (Music,
Budgeting, Sleep, Flights…) — not the "app"/"updated" noise the spike flagged —
each showing how buildable it is and its member keywords.
