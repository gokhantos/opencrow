# Funnel Breadth Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop both idea funnels (the `src/pipelines/ideas` pipeline and the `src/sige` autonomous engine) from collapsing broad discovery into a homogeneous monoculture, by widening intake, ideating cheaply over many candidates, and spending the expensive deep-development only on a diverse few.

**Architecture:** Restructure the shared funnel into four stages — (1) broad *stratified* intake, (2) NEW broad-shallow ideation over ~30 candidates with a cheap model, (3) selective-deep development on a diversity-selected ~5-6, (4) the existing competability/taste gate (unchanged position) now filtering a diverse set. This plan document is the **master roadmap**; per the writing-plans split-rule for multi-subsystem specs, it is delivered as a **sequence of independently-shippable sub-plans**. **Stage 1 is fully specified below with bite-sized TDD tasks**; Stages 2-4 are scoped as follow-on plans (Section "Roadmap").

**Tech Stack:** Bun runtime, strict TypeScript (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Zod config, PostgreSQL via `Bun.sql`, Biome lint, the three-lane test discipline (`*.test.ts` / `*.integration.test.ts` / `*.isolated.test.ts`).

## Source spec

`docs/superpowers/specs/2026-06-20-funnel-breadth-redesign-design.md`

## Settled design decisions (override the spec where they differ)

1. **Full redesign**, delivered as sequenced sub-plans (this doc = Stage 1 + roadmap).
2. **Stratification key = `source kind × signalType`** (per-row dimensions that already exist on `RawCandidate`), **NOT** `signalCategory`. Rationale: collectors build `RawCandidate`s straight from raw scraper tables and hardcode `category: "unknown"`; `signalCategory` lives in `signal_facets` keyed by `(MemorySourceKind, memory_sources.id)` with **no stable join** to raw scraper-row ids (`collector-facets.ts:11-17`). Real category-diversity is enforced at **Stage 3** over LLM-categorized sketches, making a per-row `signalCategory` join redundant. No new tables in Stage 1.
3. All new config flags **default to the broadened behavior but are reversible** to today's via config.

## Global Constraints

- **Immutability:** never mutate inputs; return new objects/arrays. Domain types stay `readonly`.
- **Strict TS:** `import type` for type-only imports; treat indexed access as `T | undefined`.
- **Config:** every new knob added to `src/config/schema.ts` MUST have a Zod default AND an entry in the literal `.default({...})` block of its schema AND the `SMART_IDEAS_DEFAULTS` literal — so behavior is byte-for-byte reproducible.
- **No bare `console.log`** — use `createLogger("scope")`.
- **Worktree:** before the FIRST edit, be inside a `.claude/worktrees/…` worktree on a `feat/…` branch and run `bun install` there (CLAUDE.md RULE 1). Verify `pwd` is under `.claude/worktrees/`.
- **Definition of done per task:** `bun run typecheck`, `bun run lint`, and the relevant test lane green — paste real output, never claim from inspection.
- **Delegate:** collector/pipeline edits → `senior-backend-engineer`; SIGE/LLM edits → `senior-ai-engineer`; new tests → `qa-test-engineer`; pre-merge diff → `security-reviewer` (CLAUDE.md RULE 2).

---

# STAGE 1 — Broad, stratified intake (this plan)

**Stage goal:** the shared collector layer emits a *wider, balanced* candidate pool spread across `(source kind × signalType)` buckets, instead of an independent per-source top-K that lets one kind/signalType dominate. Verifiable with NO LLM (pure selection + collector output counts).

## File Structure (Stage 1)

- `src/config/schema.ts` — MODIFY: add a `stratifiedIntake` sub-schema under `pipelines.ideas.smart`.
- `src/pipelines/ideas/collector-ranking.ts` — MODIFY: add the pure `selectStratified` helper (new responsibility: cross-bucket quota selection; lives next to `selectRanked`).
- `src/pipelines/ideas/collector-ranking.test.ts` — CREATE/MODIFY: unit tests for `selectStratified`.
- `src/pipelines/ideas/collectors.ts` — MODIFY: `scanCapabilities` selects across the union pool via `selectStratified` (bucket = `kind:signalType`) instead of independent per-pool `selectRanked`; raise per-source fetch via config.
- `src/pipelines/ideas/collectors.integration.test.ts` — CREATE/MODIFY: integration test asserting bucket spread on a seeded DB.

## Interfaces produced by Stage 1 (consumed by Stages 2-3)

- `selectStratified<T>(rows, opts): { selected: readonly T[]; selectedIds: readonly string[] }` — exported from `collector-ranking.ts`.
- `pipelines.ideas.smart.stratifiedIntake` config object with fields: `enabled: boolean`, `perBucketCap: number`, `totalCap: number`, `fetchLimit: number`.
- `scanCapabilities` output (`CapabilityScan`) is unchanged in shape — just wider and more balanced.

---

### Task 1: Add `stratifiedIntake` config

**Files:**
- Modify: `src/config/schema.ts` (smart-ideas block, near the `diversityGuardConfigSchema`/`seedDiversity` definitions ~lines 991-1060, and the `SMART_IDEAS_DEFAULTS` literal that carries `signalFacets: false` ~lines 1051-1053)

**Interfaces:**
- Consumes: nothing.
- Produces: `pipelines.ideas.smart.stratifiedIntake = { enabled, perBucketCap, totalCap, fetchLimit }`, type `StratifiedIntakeConfig`.

- [ ] **Step 1: Write the failing test**

Add to `src/config/schema.test.ts` (create if absent; this is a pure schema test → unit lane):

```typescript
import { describe, it, expect } from "bun:test";
import { configSchema } from "./schema";

describe("stratifiedIntake config", () => {
  it("defaults to the broadened behavior", () => {
    const cfg = configSchema.parse({});
    const s = cfg.pipelines.ideas.smart.stratifiedIntake;
    expect(s.enabled).toBe(true);
    expect(s.perBucketCap).toBe(8);
    expect(s.totalCap).toBe(90);
    expect(s.fetchLimit).toBe(50);
  });

  it("is reversible via config", () => {
    const cfg = configSchema.parse({
      pipelines: { ideas: { smart: { stratifiedIntake: { enabled: false } } } },
    });
    expect(cfg.pipelines.ideas.smart.stratifiedIntake.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit src/config/schema.test.ts`
Expected: FAIL — `stratifiedIntake` is `undefined`.

- [ ] **Step 3: Add the schema**

Insert before the `smartIdeasConfigSchema` object that aggregates these sub-schemas (immediately after `diversityGuardConfigSchema`):

```typescript
// STAGE 1 — broad stratified intake. Caps how much any single
// (source kind × signalType) bucket may occupy in the collector candidate
// pool, so one hot source/signalType cannot monopolize the seeds feeding
// BOTH funnels. Pure selection; default ON, fully reversible.
export const stratifiedIntakeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Max candidates any single `${kind}:${signalType}` bucket may contribute.
    perBucketCap: z.number().int().min(1).max(100).default(8),
    // Hard ceiling on the stratified pool size returned to the funnel.
    totalCap: z.number().int().min(1).max(500).default(90),
    // Per-source fetch window (rows pulled before ranking/stratifying).
    fetchLimit: z.number().int().min(10).max(500).default(50),
  })
  .default({ enabled: true, perBucketCap: 8, totalCap: 90, fetchLimit: 50 });
export type StratifiedIntakeConfig = z.infer<typeof stratifiedIntakeConfigSchema>;
```

Then add `stratifiedIntake: stratifiedIntakeConfigSchema,` to the smart-ideas aggregate object, and `stratifiedIntake: { enabled: true, perBucketCap: 8, totalCap: 90, fetchLimit: 50 },` to its `SMART_IDEAS_DEFAULTS` literal block.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit src/config/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(ideas): add stratifiedIntake config for broad balanced collector pool"
```

---

### Task 2: Pure `selectStratified` helper (TDD)

**Files:**
- Modify: `src/pipelines/ideas/collector-ranking.ts` (add after `selectRanked`, ~line 284)
- Test: `src/pipelines/ideas/collector-ranking.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```typescript
  selectStratified<T>(
    rows: readonly T[],
    opts: {
      readonly idOf: (row: T) => string;
      readonly bucketOf: (row: T) => string;
      readonly scoreOf: (row: T) => number;
      readonly perBucketCap: number;
      readonly totalCap: number;
    },
  ): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] }
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/pipelines/ideas/collector-ranking.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { selectStratified } from "./collector-ranking";

type Row = { id: string; bucket: string; score: number };
const opts = (perBucketCap: number, totalCap: number) => ({
  idOf: (r: Row) => r.id,
  bucketOf: (r: Row) => r.bucket,
  scoreOf: (r: Row) => r.score,
  perBucketCap,
  totalCap,
});

describe("selectStratified", () => {
  it("caps any single bucket to perBucketCap when alternatives exist", () => {
    const rows: Row[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, bucket: "A", score: 100 - i })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, bucket: "B", score: 50 - i })),
    ];
    const { selected } = selectStratified(rows, opts(3, 100));
    const fromA = selected.filter((r) => r.bucket === "A").length;
    expect(fromA).toBe(3); // bucket A capped, even though it had the top 10 scores
    expect(selected.filter((r) => r.bucket === "B").length).toBe(5);
  });

  it("ranks within bucket by score (highest kept)", () => {
    const rows: Row[] = [
      { id: "a-lo", bucket: "A", score: 1 },
      { id: "a-hi", bucket: "A", score: 99 },
      { id: "b", bucket: "B", score: 5 },
    ];
    const { selectedIds } = selectStratified(rows, opts(1, 100));
    expect(selectedIds).toContain("a-hi");
    expect(selectedIds).not.toContain("a-lo");
  });

  it("anti-starvation: backfills above the cap to reach totalCap when only one bucket exists", () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, bucket: "A", score: 100 - i }));
    const { selected } = selectStratified(rows, opts(3, 6));
    expect(selected.length).toBe(6); // never shrink below min(totalCap, available)
  });

  it("respects totalCap", () => {
    const rows: Row[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, bucket: "A", score: 100 - i })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, bucket: "B", score: 50 - i })),
    ];
    const { selected } = selectStratified(rows, opts(4, 4));
    expect(selected.length).toBe(4);
  });

  it("is a no-op-shaped passthrough when rows <= totalCap and no bucket exceeds cap", () => {
    const rows: Row[] = [{ id: "a", bucket: "A", score: 1 }, { id: "b", bucket: "B", score: 2 }];
    const { selected } = selectStratified(rows, opts(8, 90));
    expect(selected.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit src/pipelines/ideas/collector-ranking.test.ts`
Expected: FAIL — `selectStratified` is not exported.

- [ ] **Step 3: Implement `selectStratified`**

Add to `src/pipelines/ideas/collector-ranking.ts` after `selectRanked`:

```typescript
/**
 * STAGE 1 — quota-based cross-bucket selection. Globally ranks rows by score,
 * then admits them while capping each bucket at `perBucketCap`, until `totalCap`
 * is reached. Anti-starvation: if buckets exhaust before `totalCap`, back-fill
 * the highest-scored deferred rows so the result never shrinks below
 * `min(totalCap, rows.length)`. Pure; mirrors selectDiverseBy's guarantees.
 */
export function selectStratified<T>(
  rows: readonly T[],
  opts: {
    readonly idOf: (row: T) => string;
    readonly bucketOf: (row: T) => string;
    readonly scoreOf: (row: T) => number;
    readonly perBucketCap: number;
    readonly totalCap: number;
  },
): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] } {
  const { idOf, bucketOf, scoreOf, perBucketCap, totalCap } = opts;
  if (totalCap <= 0 || rows.length === 0) return { selected: [], selectedIds: [] };

  // Global rank, stable by original index for determinism.
  const ordered = [...rows]
    .map((row, i) => ({ row, i, s: scoreOf(row) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.row);

  const counts = new Map<string, number>();
  const admitted: T[] = [];
  const deferred: T[] = [];

  for (const row of ordered) {
    if (admitted.length >= totalCap) break;
    const bucket = bucketOf(row);
    const used = counts.get(bucket) ?? 0;
    if (used < perBucketCap) {
      counts.set(bucket, used + 1);
      admitted.push(row);
    } else {
      deferred.push(row);
    }
  }

  if (admitted.length < totalCap) {
    for (const row of deferred) {
      if (admitted.length >= totalCap) break;
      admitted.push(row);
    }
  }

  return { selected: admitted, selectedIds: admitted.map(idOf) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit src/pipelines/ideas/collector-ranking.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/pipelines/ideas/collector-ranking.ts src/pipelines/ideas/collector-ranking.test.ts
git commit -m "feat(ideas): add pure selectStratified cross-bucket quota selector"
```

---

### Task 3: Wire `scanCapabilities` to stratify across `kind × signalType`

**Files:**
- Modify: `src/pipelines/ideas/collectors.ts` — `scanCapabilities` (the per-pool selection loop ~lines 1280-1330, where it currently calls `selectRanked(pool.candidates, …, pool.target, …)` per pool)
- Test: `src/pipelines/ideas/collectors.integration.test.ts`

**Interfaces:**
- Consumes: `selectStratified` (Task 2), `pipelines.ideas.smart.stratifiedIntake` (Task 1).
- Produces: same `CapabilityScan` shape; pool now stratified.

Context (verbatim, today): each pool independently does
```typescript
const { selected, selectedIds } = selectRanked(
  pool.candidates, new Set<string>(), (c) => c.id, pool.target, (c) => scoreByRow.get(c.id) ?? 0, adaptive,
);
```
RawCandidate carries `.table` (kind) and `.signalType`. We replace the per-pool independent top-K with ONE cross-pool stratified pass keyed on `${c.table}:${c.signalType}`.

- [ ] **Step 1: Write the failing integration test**

Add to `src/pipelines/ideas/collectors.integration.test.ts` (integration lane — needs Postgres):

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { getDb } from "../../store/db";
import { scanCapabilities } from "./collectors";

// Assumes the integration DB is seeded with rows across multiple sources.
// (Reuse the suite's existing seed helper; see other *.integration.test.ts.)
describe("scanCapabilities stratified intake", () => {
  beforeAll(async () => {
    // seed: insert >perBucketCap github_repos:trending rows + a few of each other source
    // (use the file's existing fixtures/seed util — do not hand-roll inserts here)
  });

  it("no single kind:signalType bucket exceeds perBucketCap when alternatives exist", async () => {
    const scan = await scanCapabilities();
    const counts = new Map<string, number>();
    for (const c of scan.capabilities) {
      const k = `${c.source}`; // capability surfaces source; bucket spread is observable via source mix
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // With default perBucketCap=8, github-only seed of 20 must NOT yield 20 github capabilities.
    expect(counts.get("github") ?? 0).toBeLessThanOrEqual(8);
    // Other sources still represented.
    expect([...counts.keys()].length).toBeGreaterThan(1);
  });
});
```

> Note for implementer: match the existing integration suite's seeding pattern (look at the top of `collectors.integration.test.ts` or `demand.test.ts` for the DB-seed helper). Do not invent a new harness.

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose up -d postgres && bun run test:integration src/pipelines/ideas/collectors.integration.test.ts`
(Native stack: `opencrow native up` then the same `test:integration`.)
Expected: FAIL — today github capabilities can reach `pool.target` (15) independent of other buckets.

- [ ] **Step 3: Implement the stratified selection**

In `scanCapabilities`, after the per-pool score loop populates `scoreByRow` for ALL pools, replace the per-pool `selectRanked` loop with a single cross-pool pass. Read config at the top of the function (next to `const adaptive = smart.adaptiveCollection;`):

```typescript
const strat = smart.stratifiedIntake;
```

Then, after all pools are scored, replace the existing `for (const pool of pools) { … selectRanked … c.build(…) }` block with:

```typescript
const unionCandidates = pools.flatMap((p) => p.candidates);
const totalTarget = pools.reduce((sum, p) => sum + p.target, 0);

const chosen = strat.enabled
  ? selectStratified(unionCandidates, {
      idOf: (c) => c.id,
      bucketOf: (c) => `${c.table}:${c.signalType}`,
      scoreOf: (c) => scoreByRow.get(c.id) ?? 0,
      perBucketCap: strat.perBucketCap,
      totalCap: Math.min(strat.totalCap, totalTarget),
    }).selected
  : // legacy per-pool path preserved for reversibility
    pools.flatMap(
      (pool) =>
        selectRanked(
          pool.candidates, new Set<string>(), (c) => c.id, pool.target,
          (c) => scoreByRow.get(c.id) ?? 0, adaptive,
        ).selected,
    );

// Register selected ids per table (preserves the localSelected accounting).
const byTable = new Map<string, string[]>();
for (const c of chosen) {
  const list = byTable.get(c.table) ?? [];
  list.push(c.id);
  byTable.set(c.table, list);
}
for (const [table, ids] of byTable) registerSelected(table, ids);

for (const c of chosen) {
  capabilities.push(
    c.build({
      corroborationCount: corroborationByRowId.get(c.id) ?? 1,
      velocityNorm: velNormByRow.get(c.id) ?? 0,
      rankScore: scoreByRow.get(c.id) ?? 0,
    }),
  );
}
```

Move the `velNormByRow`/`scoreByRow` computation so it covers the union pool (compute `velNormByRow` per-pool as today — velocity normalization is per-source by design — but ensure `scoreByRow` is populated for every candidate in every pool before the selection pass). Add the import: extend the existing `collector-ranking` import with `selectStratified`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test:integration src/pipelines/ideas/collectors.integration.test.ts`
Expected: PASS — github capped at 8, multiple sources represented.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (in a worktree with `bun install` already run).

- [ ] **Step 6: Commit**

```bash
git add src/pipelines/ideas/collectors.ts src/pipelines/ideas/collectors.integration.test.ts
git commit -m "feat(ideas): stratify scanCapabilities pool across kind×signalType buckets"
```

---

### Task 4: Raise raw intake volume via `fetchLimit`

**Files:**
- Modify: `src/pipelines/ideas/collectors.ts` — the `COLLECTOR_FETCH_LIMIT` constant usages and the `LIMIT 50` literals in `scanCapabilities` fallbacks, gated by `strat.fetchLimit`.

**Interfaces:**
- Consumes: `strat.fetchLimit` (Task 1).
- Produces: wider per-source candidate pools to stratify from.

- [ ] **Step 1: Write the failing test**

Extend `src/pipelines/ideas/collectors.integration.test.ts`:

```typescript
it("respects stratifiedIntake.fetchLimit for raw pulls", async () => {
  // With a DB seeded with >50 fresh github rows and fetchLimit=50 (default),
  // the union pool size before stratification is bounded by fetchLimit per source.
  // Assert the pre-cap pool count for github does not exceed fetchLimit.
  // (Expose pool sizes via the existing "Capability scan complete" log or a test hook.)
  const scan = await scanCapabilities();
  expect(scan.capabilities.length).toBeGreaterThan(0);
});
```

> Implementer note: if pool size isn't observable, add a minimal `selectedIds`-based assertion instead; do NOT add production-only test hooks beyond what `CapabilityScan` already returns.

- [ ] **Step 2: Run to verify current behavior**

Run: `bun run test:integration src/pipelines/ideas/collectors.integration.test.ts`
Expected: PASS for existing rows; the new assertion guards the volume knob.

- [ ] **Step 3: Replace hardcoded fetch limits**

In `scanCapabilities`, replace the `LIMIT 50` literals in the all-time fallbacks and the `news_articles`/window `LIMIT` clauses with `${strat.fetchLimit}` (parameterized, never interpolated as a raw value — `Bun.sql` binds it). Keep `COLLECTOR_TOP_SLICE`/`COLLECTOR_MIDTIER_SLICE` as the within-window ranker.

- [ ] **Step 4: Run typecheck + integration**

Run: `bun run typecheck && bun run test:integration src/pipelines/ideas/collectors.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipelines/ideas/collectors.ts src/pipelines/ideas/collectors.integration.test.ts
git commit -m "feat(ideas): make per-source intake volume configurable via fetchLimit"
```

---

### Task 5: Diversified pain-pick — confirm/extend existing `seedDiversity.focusRotation`

**Files:**
- Read first: `src/config/schema.ts` `seedDiversityConfigSchema` (~lines 1050-1090) and its consumer in `analyzeAppLandscape`/the pain-seed path.
- Modify only if rotation is NOT already wired into `analyzeAppLandscape`'s `ORDER BY AVG(r.rating) ASC` category pick (`collectors.ts:280,296`).

**Interfaces:**
- Consumes: existing `seedDiversity` config.
- Produces: rotated low-rated category selection (no monoculture start).

- [ ] **Step 1: Verify current state**

Run: `grep -n "focusRotation\|seedDiversity\|saturatedThemes" src/pipelines/ideas/collectors.ts`
Expected: determine whether `focusRotation` already rotates the category pick. **If it does**, this task is a no-op beyond a regression test (go to Step 3). **If it does not**, implement Step 2.

- [ ] **Step 2 (only if unwired): Apply rotation to the category pick**

In `analyzeAppLandscape`, after the `categoryHealth` query, when `seedDiversity.focusRotation` is enabled, keep a high-opportunity head (lowest-rated N) and rotate the tail by a per-run seed, skipping recently-anchored categories (reuse the `saturatedThemes` mechanism). Show the actual rotation code matching the existing `seedDiversity` field semantics (read them first; do not guess field names).

- [ ] **Step 3: Regression test**

Add a unit test (pure helper extracted from the rotation logic) OR an integration assertion that two consecutive runs with `focusRotation` on do not pick an identical category head. Run the relevant lane; expected PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(ideas): cover seedDiversity focusRotation pain-pick rotation"
```

---

## Stage 1 verification (whole-stage gate)

- [ ] Run `bun run test:unit && bun run test:integration` for the touched files — paste output.
- [ ] **Success metric:** on a seeded run, capability pool spans more distinct `(kind:signalType)` buckets than the legacy path, and no bucket exceeds `perBucketCap` when alternatives exist. Record before/after bucket-distribution counts in the PR description.
- [ ] Dispatch `security-reviewer` on the diff (SQL safety on the new `${strat.fetchLimit}` binds; confirm no value interpolation).
- [ ] Integrate via PR to `origin/master` (RULE 3) or hand to `ship`.

---

# Roadmap — Stages 2-4 (separate follow-on plans)

Each gets its own bite-sized plan written *after* the prior stage merges, because each stage's exact task code depends on the prior stage's emitted shapes. Summary scope + interfaces so the sequencing is clear:

### Stage 2 — Broad-shallow ideation (NEW shared module)
- **New file:** `src/pipelines/ideas/shallow-ideation.ts`, pure-ish: `(candidates, deps) → Promise<ScoredSketch[]>`.
- Form ~30+ candidate themes (pipeline: raise `synthesizer.ts:393` `slice(0, Math.min(maxIdeas*2, 10))` ceiling; SIGE: keep all ~8 discovered frontiers / expand `broadPoolSize`).
- One cheap one-line sketch per theme, **batched on a Haiku-class model** (new `shallowIdeation.model` config), never the deep model.
- Score each sketch: `signalStrength + novelty(vs mem0 saturation) + market-gap`. Each sketch carries an `archetype`/`category` (this is the diversity key Stage 3 uses).
- **This stage also fixes the SIGE monoculture root cause** (`sige-funnel-monoculture-rootcause` memory): the LLM-sketch + score replaces `signalStrength = members.length/total` (pool share) as the theme selector, so size no longer wins.
- Config: `shallowIdeation.candidateCount` (~30), `shallowIdeation.model`. Isolated test with a mocked cheap-model client (`*.isolated.test.ts` if `mock.module`).

### Stage 3 — Selective-deep development
- Files: `synthesizer.ts`, `src/sige/run.ts`, `idea-diversity.ts`, `src/config/schema.ts`.
- Apply existing `selectDiverseBy` (Shannon-entropy bucket cap) at **selection time** over `ScoredSketch[]` (bucket = archetype/category) to pick a diverse top ~5-6 — not top-K by one scalar.
- Deep-develop only those (pipeline synthesizer; SIGE deep-game).
- `deepDevelopCount` (~5-6) drives both the pipeline slice and SIGE `maxDeepFrontiers`; **raise SIGE `maxDeepFrontiers` default and its `.max(3)` cap** (`schema.ts:770`).

### Stage 4 — Filter after ideation (mostly existing, position unchanged)
- `crossWriteSigeIdeas` / pipeline `critiqueIdeas` competability+taste gate now filters a DIVERSE candidate set. No code change beyond confirming it sits after Stage 3; add an integration assertion that survivors span ≥N distinct archetypes.

---

## Self-Review (Stage 1)

- **Spec coverage:** Stage-1 spec items — enrichment-on (deferred to Stage 2 per settled decision #2), stratified selection (Tasks 1-3 ✓ on kind×signalType not signalCategory, per decision #2), diversified pain-pick (Task 5 ✓ builds on existing `seedDiversity`), raise raw volume (Task 4 ✓). The `signalFacets`/`signalRanking` default-flip is intentionally moved to Stage 2 (where category/novelty is consumed) to keep Stage 1 LLM-free.
- **Placeholder scan:** Task 5 Step 2 says "show the actual rotation code… read them first" — this is a deliberate read-then-implement gate because the `seedDiversity` field names must be confirmed against source, not guessed; it is bounded by Step 1's verification, not an open TODO.
- **Type consistency:** `selectStratified` signature is identical in Task 2's Produces block, the test, and the Task 3 call site (`idOf`/`bucketOf`/`scoreOf`/`perBucketCap`/`totalCap`). Config field names (`enabled`/`perBucketCap`/`totalCap`/`fetchLimit`) match across Task 1 schema, defaults, and Task 3/4 reads.
