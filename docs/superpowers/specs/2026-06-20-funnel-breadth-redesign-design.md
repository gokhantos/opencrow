# Funnel Breadth Redesign — Broad Intake → Broad-Shallow Ideation → Selective-Deep Development

**Date:** 2026-06-20
**Status:** Design approved; spec for implementation planning
**Scope:** Both idea funnels — the `src/pipelines/ideas` pipeline AND the `src/sige` autonomous engine — via their shared collector layer.

---

## 1. Problem

Both funnels produce homogeneous, derivative ideas because **broad discovery is funneled through a narrow neck before any ideation happens**, with no theme stratification. Verified root causes (file:line):

- **SIGE collapses to one theme:** `src/sige/run.ts:349` — `topFrontiers = discovery.frontiers.slice(0, sigeAutoConfig.maxDeepFrontiers)` with `maxDeepFrontiers` default **1** (cap 3, `src/config/schema.ts:770`). It discovers up to 8 divergent frontiers, then deep-develops exactly one.
- **Pipeline collapses to top-10:** `src/pipelines/ideas/synthesizer.ts:393` — `slice(0, Math.min(maxIdeas*2, 10))`, fed by per-source global top-K in `collectors.ts` with **no cross-category quota**, so a hot theme monopolizes.
- **Complaint monoculture:** `analyzeAppLandscape` orders categories `AVG(rating) ASC` and **both funnels share it**, so every run starts from the same lowest-rated categories.
- **Stratification data is OFF:** `signalFacets`/`signalRanking` default false (`src/config/schema.ts:991,994`), so `signalCategory`/`facetEntities`/`signalImportance` — the fields needed to spread selection — are null.
- The existing diversity guard (`src/pipelines/ideas/idea-diversity.ts`) is a **post-synthesis re-sort**; it cannot inject diversity the seed stage never collected.

## 2. Goals / Non-Goals

**Goals**
- Seed pool spread across many themes/sources/categories, not a per-source top-K monoculture.
- Ideate (cheaply) over **many** candidates, then spend the expensive deep-development on a **diverse few**.
- A measurable reduction in homogeneity: more distinct `signalCategory`/archetype values per run.
- Shared intake improvement benefits both funnels; neck restructure applied to both.

**Non-Goals**
- Graph-reasoning path-quality (separate backlog: edge weighting, embedding gating, seed diversification).
- Fixing dead demand probes (separate `idea-quality-root-cause` thread).
- Removing the complaint/pain lens — complaints are the intended signal; we diversify *within* it.
- Changing the synthesizer's deep-development prompt itself.

## 3. Architecture — three stages

```
[ Stage 1: broad stratified intake ]   (shared: collectors.ts + config)
        → wide candidate pool spread across signalCategory × kind
[ Stage 2: broad-shallow ideation ]    (NEW shared stage)
        → ~30+ candidate themes → cheap one-line sketch each (small model, batched)
        → score sketches (signal-strength + novelty-vs-mem0 + market-gap)
[ Stage 3: selective-deep development ](pipeline synthesizer / SIGE deep-game)
        → diversity-aware select top ~5-6 → deep-develop ONLY those
[ Stage 4: filter after ideation ]     (existing competability/taste gate, unchanged position)
        → now filters a DIVERSE set, not a monoculture
```

### Stage 1 — Broad, stratified intake (shared)
Files: `src/pipelines/ideas/collectors.ts`, `src/pipelines/ideas/collector-ranking.ts`, `src/config/schema.ts`, `analyzeAppLandscape`.

1. **Enrichment ON by default:** flip `pipelines.ideas.smart.signalFacets` and `signalRanking` defaults to `true` so `signalCategory`/`facetEntities`/`signalImportance` populate on new signals. (Existing ~12k points already backfilled 2026-06-20.)
2. **Stratified selection:** replace the single global per-source top-K in `scanCapabilities`/`clusterReviews` with **quota-based selection across `(signalCategory × source kind)`** — a per-bucket cap so no single theme or source monopolizes the pool. Keep the existing 30+70 top/mid window + niche bonus (`collector-ranking.ts`) as the within-bucket ranker.
3. **Diversified pain-pick:** in `analyzeAppLandscape`, keep `AVG(rating) ASC` as the lens but add **category anti-saturation** — persist recently-used categories (reuse the saturation/`saturatedThemes` mechanism) and rotate/weight-sample across the low-rated space instead of a fixed bottom-N.
4. **Raise raw volume:** increase per-source fetch windows / per-kind caps so there is more to stratify from (new config knobs, conservative defaults).

*Output:* a wide candidate pool (trends/pains/capabilities) spread across many categories and kinds.

### Stage 2 — Broad-shallow ideation (NEW, shared)
New module (e.g. `src/pipelines/ideas/shallow-ideation.ts`), consumed by both `pipeline.ts` and `src/sige/run.ts`.

1. Form **~30+ candidate themes** — pipeline: raise the `synthesizer.ts:393` `slice` ceiling; SIGE: keep all discovered frontiers (~8) and optionally expand `broadPoolSize`.
2. For each candidate, generate **one cheap one-line idea sketch**, **batched into a few calls on a small/cheap model** (Haiku-class), never the deep model.
3. Score each sketch: `signalStrength + novelty(vs mem0 saturation) + market-gap`. (Reuse existing mem0/saturation scoring where present.)

**Fork resolved → Approach A** (LLM sketches → score → diversity-select). Chosen over metric-only theme scoring (B) because it genuinely "ideates over many" and the sketch cost is small.

### Stage 3 — Selective-deep development
Files: `src/pipelines/ideas/synthesizer.ts`, `src/sige/run.ts`, `src/pipelines/ideas/idea-diversity.ts`, `src/config/schema.ts`.

1. **Diversity-aware selection at selection time:** apply the existing Shannon-entropy `selectDiverse`/`selectDiverseBy` machinery (today used post-hoc in `idea-diversity.ts`) to pick the top **~5-6 diverse** sketches — not the top-K by a single scalar.
2. Deep-develop only those (pipeline synthesizer; SIGE deep-game).
3. **Make the deep-dive count configurable** (default ~5-6). Raise SIGE `maxDeepFrontiers` default and its cap-of-3 (`schema.ts:770`).

### Stage 4 — Filter after ideation (mostly existing)
The competability/taste gate (`crossWriteSigeIdeas`, pipeline `critiqueIdeas`) already runs **after** ideation. Position unchanged. The win: it now filters a diverse candidate set, so it stops collapsing to similar survivors.

## 4. Config changes (`src/config/schema.ts`)
- `pipelines.ideas.smart.signalFacets` → default `true`
- `pipelines.ideas.smart.signalRanking` → default `true`
- NEW: intake-volume knobs (per-source fetch windows / per-kind caps)
- NEW: stratification quota params (per-bucket cap for `signalCategory × kind`)
- NEW: `shallowIdeation.candidateCount` (~30), `shallowIdeation.model` (cheap model id)
- `deepDevelopCount` (~5-6, configurable) — drives both pipeline slice and SIGE `maxDeepFrontiers`
- Raise SIGE `maxDeepFrontiers` max above 3

All new flags default to the broadened behavior but are reversible to today's via config.

## 5. Data flow / interfaces
- Stage 1 emits the existing `BroadCorpus { trends, pains, capabilities }` shape, just wider + stratified — no interface change for consumers.
- Stage 2 is a new pure-ish unit: `(candidates, deps) → ScoredSketch[]`. Testable in isolation with a mocked cheap-model client.
- Stage 3 consumes `ScoredSketch[]` → `selectDiverse` → deep-develop. The synthesizer/SIGE deep-game inputs are unchanged per-theme.

## 6. Testing & success metric
- **Unit:** stratified-quota spread (no bucket exceeds cap); `selectDiverse` picks across categories; sketch scoring/ranking ordering.
- **Isolated:** Stage 2 with a mocked cheap-model client (use `*.isolated.test.ts` if `mock.module`).
- **Integration:** a pipeline run produces ideas spanning N distinct `signalCategory`/archetype values.
- **Success metric (before/after):** distinct `signalCategory` and distinct archetype counts per run materially increase; manual read of a sample run shows less "same idea, reworded."

## 7. Risks & mitigations
- **Cost creep from Stage 2 sketches** → batched + cheap model; deep-dives stay ~5-6. Net increase modest; `deepDevelopCount` + `candidateCount` are config-bounded.
- **Stratification starves on sparse categories** → quota selection must never shrink the kept set below `min(target, available)` (mirror the existing diversity-guard guarantee).
- **Facets-on adds enrichment latency to ingest** → it's fire-and-forget today; keep it off the critical path; the weekly/backfill path covers gaps.
- **SIGE cost** (expensive GLM path, currently config-disabled) → `maxDeepFrontiers` default stays conservative (~5-6) and configurable; no change to the on/off gate.

## 8. Rollout
1. Stage 1 intake (shared) + config flags — verifiable via collector output diversity, no LLM.
2. Stage 2 shallow ideation module + tests.
3. Stage 3 selective-deep wiring in pipeline, then SIGE.
4. Behind config defaults; measure distinct-category metric before/after; ship per the repo's worktree → PR → CI → deploy flow.
