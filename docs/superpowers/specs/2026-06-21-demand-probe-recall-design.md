# Demand-Probe Recall Fix — Deterministic, Internal-Corpus-Only

**Date:** 2026-06-21
**Status:** Design approved; spec for implementation planning
**Scope:** `src/pipelines/ideas/demand.ts`, `src/pipelines/ideas/demand-probes.ts`, a new `src/pipelines/ideas/demand-intent-markers.ts`, and config (`src/config/schema.ts` + `src/config/loader.ts`). `giant.ts` is **untouched**.

---

## 1. Problem

The demand axis floors genuinely-good niche/B2B ideas. The earlier crude defects are already fixed (the probe set is now reddit-intent + funding-news + review-complaint + hn-intent + ph-supply, and probes DB-prefilter on the keyword instead of pulling a global top-N). What remains, verified in the live code:

- **Matching is literal substring** — `haystack.toLowerCase().includes(kw)` (`demand-probes.ts:131`) and `distinctKeywordHits` (`demand.ts:280`). An idea worded differently than the corpus ("payroll reconciliation" vs a thread about "timesheet errors") scores zero. It also has a precision bug: `"cat"` matches inside `"category"`.
- **The reddit/HN intent gate is rigidly phrase-bound** — a row only counts when it contains one of ~18 hardcoded markers (`REDDIT_INTENT_PATTERNS`, `demand-probes.ts:56`) AND a keyword. Real niche/B2B pain rarely phrases itself as "is there a tool for X", so those probes almost never fire for B2B.
- **`x_scraped_tweets` is scraped but unused** by demand — organic intent text left on the table.

The scoring curve and the absence floor are **not** the problem. With engagement weighting a single strong match already clears demand 2–3; the issue is *getting any match at all*. Absence is correctly penalized and must stay penalized — the fix surfaces more **real, cited** rows, it never fabricates demand.

## 2. Goals / Non-Goals

**Goals**
- Bias toward **recall**: more niche/B2B ideas earn a *cited* `DemandArtifact` from the existing scraped corpus.
- Stay **internal-corpus-only**: no external APIs, no new paid dependency, license-clean.
- Stay **deterministic**: every number still derives from real row counts; no LLM asserts demand. The anti-hallucination contract in `demand.ts` holds.
- Fully **reversible** via config flags.

**Non-Goals**
- Semantic / embedding matching (deferred; the rows are only embedded at memory-chunk level via the SIGE indexer, and the default embedder is a paid OpenRouter model — out of scope here).
- Wiring a real external-trends / search-volume vendor (`externalTrendsProbe` stays a no-op stub).
- Changing the score curve, weights saturation, or the giant.ts demand-evidence gate.
- Fixing the corpus echo-chamber sourcing (separate ingestion thread).

## 3. Architecture — four deterministic levers

All four operate over already-scraped tables and emit the existing `DemandEvidence` shape, so `aggregateDemand` is unchanged.

### Lever 1 — Soften the intent gate (strong vs weak)
Today `redditIntentProbe` / `hnProbe` `continue` unless `firstPatternMatch(haystack, REDDIT_INTENT_PATTERNS)` is non-null. New per-row rule (the `minKeywordHits` relevance gate is still required first):

- **keyword + marker** → *strong* evidence, full engagement `count` (today's behavior, unchanged).
- **keyword, no marker, engagement ≥ `weakIntentMinEngagement`** → *weak* evidence: SAME evidence `kind`, `count` multiplied by `weakIntentFactor` (default 0.35).

Rationale: a high-engagement niche post that names the idea but doesn't use a canned intent phrase is real demand — counted, but discounted so it can't masquerade as strong buyer-intent. The relevance gate (≥ `minKeywordHits` distinct idea keywords) remains the precision guardrail against generic single-word noise. No new evidence kind, so the confidence-diversity math is unchanged by this lever.

Guardrail: weak evidence requires the FULL relevance gate AND a minimum engagement floor (`weakIntentMinEngagement`, default `1.5` — i.e. `1 + log1p(score+comments) ≥ 1.5`, so the row needs at least ~1 upvote/comment of community signal) so a dead, zero-engagement keyword mention does not flood the pool.

### Lever 2 — Expand the marker list (pure data)
Extract markers + a curated synonym map into a new focused module `src/pipelines/ideas/demand-intent-markers.ts` (keeps `demand-probes.ts` from growing). Expand `REDDIT_INTENT_PATTERNS` with:
- question forms: "how do you", "how do you all", "what do you use for", "best way to", "any recommendations", "anyone using";
- frustration: "frustrated with", "sick of", "tired of", "hate that", "pain in the", "such a pain";
- manual-workaround: "by hand", "manually", "stuck with spreadsheets", "google sheet", "copy paste", "no good tool", "nothing out there";
- willingness: "happy to pay", "take my money".

Curated to stay topical-when-paired-with-a-keyword; the keyword co-occurrence gate is what keeps precision. Shared by reddit, HN, and the new X probe.

### Lever 3 — Fuzzy lexical matching (replaces brittle `includes()`)
New PURE helpers in `demand.ts`:
- `stemToken(token)` — conservative suffix stripping (plural `-s`/`-es`, `-ing`, `-ed`, `-er`, `-tion`→`-t` only where safe). Deterministic, no dependency, no over-stemming.
- `matchesKeyword(haystack, keyword)` — stem + **word-boundary** match (fixes the `"cat"`-in-`"category"` substring bug) + a narrow curated synonym expansion (e.g. scheduling↔scheduler↔shift planning; invoicing↔billing; payroll↔wages). Synonyms live in `demand-intent-markers.ts`.
- `distinctKeywordHits` and `firstKeywordMatch` are reimplemented on top of `matchesKeyword`, so ALL probes + `computePhSupplyDensity` inherit consistent matching.

DB prefilter: the `ILIKE` candidate prefilter (`buildKeywordFilter`) queries the **stem** form (`%schedul%`) so variants pass the cheap prefilter; the precise stem/boundary/synonym gate runs in code per row. The prefilter stays OR-semantics (recall-safe); precision is enforced in code. This change RAISES both recall (variants) and precision (boundaries).

### Lever 4 — New `x_scraped_tweets` demand probe
`xIntentProbe` parallel to `redditIntentProbe`:
- new evidence kind `x_intent` added to `DEMAND_EVIDENCE_KINDS` with weight ~1.0 in `DEMAND_KIND_WEIGHTS` (same buyer-intent semantics as reddit);
- reads `x_scraped_tweets` (`text` + engagement columns — verify exact column names at implementation: likes/retweets/favorite_count), applies the same strong/weak intent logic and relevance gate;
- engagement-weighted `count`; graceful `[]` on any failure or absent table/columns;
- added to `DEFAULT_DEMAND_PROBES` and gated by an `xIntent` config flag.

Note: adding `x_intent` grows `DEMAND_EVIDENCE_KINDS` 6→7, so the confidence diversity denominator (`distinctKinds / DEMAND_EVIDENCE_KINDS.length`) shifts slightly; existing confidence tests are updated to the new denominator.

## 4. Data flow / interfaces

- `DemandEvidence` / `DemandArtifact` shapes unchanged; `aggregateDemand` (curve, weights, absence floor, confidence) unchanged except the kinds-length constant grows by one (Lever 4).
- New pure units, all unit-testable with no IO: `stemToken`, `matchesKeyword`, the rewired `distinctKeywordHits` / `firstKeywordMatch`, and the weak-vs-strong count derivation.
- `EnrichDemandConfig` (mirrors `smart.demand`) gains: `weakIntent`, `weakIntentFactor`, `weakIntentMinEngagement`, `fuzzyMatch`, `xIntent`. Threaded through `DemandProbeOptions` where probes need them (weak-intent params, fuzzy-match toggle).
- `selectProbes` learns the `x_intent` probe (`cfg.xIntent !== false`).

## 5. Config changes (`schema.ts` + `loader.ts`)

New `smart.demand` flags, **all default ON** (this is the fix; recall is the goal), each reversible:
- `weakIntent: boolean` default `true`
- `weakIntentFactor: number` default `0.35` (bounds 0..1)
- `weakIntentMinEngagement: number` default `1.5` (bounds ≥ 1; the engagement-weighted count a marker-less row must reach)
- `fuzzyMatch: boolean` default `true`
- `xIntent: boolean` default `true`

Env overrides under `OPENCROW_SMART_DEMAND_*` in `loader.ts`, mirroring the existing demand-flag pattern. Flipping any flag restores today's behavior for that lever; flipping all restores today's demand path exactly (modulo the precision boundary-match bugfix, which is strictly better and not flag-gated).

## 6. Testing & success metric

- **Unit** (`*.test.ts`, no DB): `stemToken` cases; `matchesKeyword` recall (variants/synonyms) + precision (`cat`/`category` rejected, boundary respected); `distinctKeywordHits` over stems; weak-vs-strong `count` math (factor applied, engagement floor enforced); confidence denominator with the new kind.
- **Integration** (`*.integration.test.ts`, real DB — `docker compose up -d postgres` or native PG): each probe incl. `xIntentProbe` against seeded rows; weak-intent path fires on a marker-less high-engagement keyword row; relevance gate still rejects a generic single-word row; a stem-variant row now matches where literal substring missed; existing demand integration tests stay green.
- **Success metric (before/after):** on a sample pipeline run, the share of candidates with a cited `DemandArtifact` (`hasCitedDemand` true) materially increases, and the demand-axis distribution widens off the absence floor — without generic-noise rows passing the relevance gate.

## 7. Risks & mitigations

- **Recall → false demand.** Mitigated by: keeping the `minKeywordHits` relevance gate, the weak-evidence discount (`weakIntentFactor`), and the weak-intent engagement floor. Weak-only evidence yields a low (not floored) score — intended.
- **Cross-cutting matcher change** (`distinctKeywordHits` touches every probe + supply density). Mitigated by making `matchesKeyword` a small pure unit with exhaustive unit tests and re-running the full demand integration suite.
- **Over-stemming** collapsing distinct terms (e.g. "billing"→"bill"). Mitigated by conservative suffix rules + unit tests pinning non-collapse cases; synonym map curated narrow.
- **`x_scraped_tweets` schema drift / sparse population.** Probe degrades to `[]` on absent columns or empty table; verify exact column names at implementation; flag-gated.
- **Default-ON changes live demand scores.** Acceptable and intended (the user chose recall + default-ON); fully reversible per-lever via config; `giant.ts` gate semantics unchanged so the blast radius is "more ideas earn a citation," not a scoring-curve shift.

## 8. Rollout

1. Lever 3 matcher (`stemToken`/`matchesKeyword`) + rewire `distinctKeywordHits`/`firstKeywordMatch` + unit tests — the foundation; verify no regression in existing demand unit tests.
2. Lever 2 marker/synonym module.
3. Lever 1 weak-intent gate in reddit/HN probes + config flags.
4. Lever 4 `xIntentProbe` + new kind + weight + `selectProbes` wiring.
5. Config flags + env overrides; integration tests; measure the cited-demand share before/after; ship via the repo's worktree → PR → CI → deploy flow.
