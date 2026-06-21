# Theme-Stratified Intake — bucket the seed pool by signalCategory × source

**Date:** 2026-06-21
**Status:** Design approved (approach + granularity chosen); spec for implementation.
**Scope:** `src/store/migrations/` (new migration), `src/memory/indexer.ts` (enrichment write-back), `src/pipelines/ideas/collectors.ts` (read + bucket key), `src/config/schema.ts` (flag). Shared collector layer → benefits BOTH the pipeline and SIGE funnels.

---

## 1. Problem

Stage-1 stratified intake already ships (`selectStratified`, `collector-ranking.ts:294`, default ON) but it buckets on `${table}:${signalType}` — i.e. it spreads the seed pool across **sources and sub-sources, not themes**. Prod diversity summaries show the funnel still collapses: every run today logs `distinctCategories: 1`, `dominantArchetype` share ≈ 1.0, `archetypeEntropy` ≈ 0. Source-stratification did not buy theme diversity.

The spec's intended Stage-1 bucket key — `signalCategory × source-kind` — is unbuilt because `signalCategory` (the LLM-extracted theme) is computed **post-collection**, at **batch granularity**, keyed by a `memory_sources` UUID. The original scraped-row id (`reddit_posts.id`, …) is never stored in `signal_facets` or the Qdrant payload (only as an unqueried CSV in `metadata_json.postIds`), so there is **no key to read the category back** at selection time. Qdrant also has no batch `IN` filter.

## 2. Goals / Non-Goals

**Goals**
- Make each scraped row's `signalCategory` available to the collectors at selection time, with **zero added reads** on the selection path.
- Bucket the stratified seed pool on theme (`signalCategory`) so a hot theme can't monopolize, while preserving today's source/sub-source spread for rows not yet enriched.
- Shared change → both funnels benefit; fully reversible via config.

**Non-Goals**
- Per-row enrichment accuracy (chosen granularity is **batch-level** — all rows in an index batch share the batch's category; per-row is a future option).
- Fixing enrichment coverage/latency (the benefit ramps as coverage grows; out of scope).
- Changing the downstream competability/demand gates or the diversity guard.
- The Qdrant facet store / `signal_facets` table (left as-is; we mirror to source columns instead).

## 3. Approach — mirror `signalCategory` onto the source rows at enrichment time

Chosen over Qdrant/PG read-back (infeasible: key mismatch, no batch filter) and over per-row enrichment (more LLM cost). Cost: one `UPDATE … WHERE id = ANY(...)` per index batch (already a write path); **zero** added reads at selection.

### Component 1 — Migration (additive, idempotent)
New numbered migration `src/store/migrations/NNN_signal_category_columns.sql` (use the next sequential number). For each of the 6 collector-read source tables — `reddit_posts`, `hn_stories`, `github_repos`, `ph_products`, `news_articles`, `x_scraped_tweets` — add:
- `signal_category TEXT` (nullable), via `ADD COLUMN IF NOT EXISTS`.
- An index to keep bucket reads cheap if ever filtered: `CREATE INDEX IF NOT EXISTS ... (signal_category)` (partial `WHERE signal_category IS NOT NULL`).
Follow the house idempotent migration style (guarded, non-fatal on re-run).

### Component 2 — Write category at enrichment time (`src/memory/indexer.ts`)
In `enrichAndPatch` (`indexer.ts:376-418`), once `facets.category` is known for a `sourceId`, also `UPDATE <source_table> SET signal_category = ${category} WHERE id = ANY(${rowIds})`.
- `rowIds` = the per-source scraped-row PKs the indexer already holds in scope (the `posts`/`stories`/`repos`/… arrays; the same ids it joins into `metadata_json.postIds` at `indexer.ts:632`). Thread them into the enrichment closure / `enrichAndPatch` so the UPDATE can run.
- `<source_table>` derives from the source `kind` (e.g. `reddit_post → reddit_posts`); use an explicit `kind → table` map (allow-list, never interpolate raw kind into SQL — table name from a fixed map, ids as bound params).
- Batch-level category fanned to every row in the batch (the chosen granularity). Empty/failed category → leave `signal_category` NULL.
- Keep it on the existing fire-and-forget enrichment path; a failure here must not break indexing (wrap, log via `createLogger`).

### Component 3 — Read + bucket on it (`src/pipelines/ideas/collectors.ts`)
- Add `signal_category` to each per-source `SELECT` (reddit ~`collectors.ts:1167`, hn, github, ph, news, x).
- Populate `RawCandidate.category` from `r.signal_category` instead of the hardcoded `"unknown"` (reddit `:1200`, hn `:1059`, github `:1130`, ph `:989`, news `:1256`, x `:1318`).
- Change the bucket key (`collectors.ts:1432`) to a **hybrid**:
  - enriched row (`category` present and ≠ `"unknown"`) → `${category}:${table}`
  - un-enriched row → fall back to `${signalType}:${table}` (today's behavior) — NOT a single `uncategorized` bucket, so the un-enriched tail keeps its current source/sub-source spread rather than collapsing into one bucket.

### Component 4 — Config flag (`src/config/schema.ts`)
Add `stratifiedIntake.bucketBy: z.enum(["signalType","signalCategory"]).default("signalCategory")`. `signalCategory` uses the hybrid key above; `signalType` reverts to today's exact `${table}:${signalType}`. Default to the new behavior (safe: with low coverage it degrades to ≈ today's source buckets via the fallback). Reversible by flipping the flag. Env override under the existing `stratifiedIntake` pattern if present.

## 4. Data flow / interfaces
- `RawCandidate` already carries `.id`, `.table`, `.signalType`; we now also populate `.category` from the new column. No new selection-time queries.
- `selectStratified` is unchanged — only its injected `bucketOf` closure changes (Component 3). Its per-bucket cap / total cap / anti-starvation backfill all apply to the new theme buckets automatically.
- Enrichment write is additive on an existing write path.

## 5. Testing & success metric
- **Unit:** the `bucketOf` key derivation — enriched → `${category}:${table}`; un-enriched (null/"unknown") → `${signalType}:${table}`; flag = `signalType` → legacy key. Pure, table-driven.
- **Integration** (`*.integration.test.ts`, real PG): the enrichment UPDATE writes `signal_category` to the correct rows for a seeded batch; a collector SELECT returns it; `selectStratified` spreads kept rows across ≥N distinct `signalCategory` buckets when categories are present; migration applies idempotently.
- **Success metric (before/after):** prod diversity summary `distinctCategories` per run rises above 1 as enrichment coverage grows; the dominant-theme share of the seed pool drops. (Ramp-dependent — see risk.)

## 6. Risks & mitigations
- **Low enrichment coverage initially** → a substantial share of each run's freshly-scraped candidates have `signal_category NULL`. Mitigated by the **hybrid fallback to `signalType`** (un-enriched rows keep today's source stratification, never worse than current); benefit ramps with coverage. State this plainly — it won't transform diversity on day one.
- **Batch-level category is coarse** (all rows in an index batch share a theme). Accepted for v1; per-row enrichment is the future upgrade if buckets prove too lumpy.
- **SQL safety** — table name from a fixed `kind→table` allow-list (never interpolate raw `kind`); ids as bound params. (security-reviewer to confirm.)
- **Write-path failure** must not break indexing → wrapped, logged, non-fatal.
- **Default-on** changes bucketing live, but degrades gracefully to ≈ today's behavior under low coverage; reversible via `bucketBy: "signalType"`.

## 7. Rollout
1. Migration (additive columns) — safe to land first.
2. Enrichment write-back (`indexer.ts`) — starts populating `signal_category` going forward; existing rows fill in as they re-enrich / via the `facet-backfill` path.
3. Collector read + hybrid bucket key + flag — turns theme-bucketing on.
4. Tests; ship via worktree → PR → CI → deploy; watch the `distinctCategories` diversity-summary metric over subsequent cron runs.
