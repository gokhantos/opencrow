# Funnel Breadth Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both idea funnels ingest a broad, theme-stratified seed pool, cheaply sketch ideas across many candidates, then spend expensive deep-development only on a diverse few — so output stops collapsing to a monoculture.

**Architecture:** Three stages — (1) broad stratified intake in the shared collectors, (2) a NEW cheap "shallow ideation" pass that one-line-sketches every candidate via a routed cheap model, (3) diversity-aware selection (reusing `selectDiverseBy`) feeding the existing deep-development. The post-synthesis competability/demand gate is unchanged in position but now filters a diverse set.

**Tech Stack:** Bun, TypeScript (strict, `import type`, `noUncheckedIndexedAccess`), Zod config, PostgreSQL via `Bun.sql`, the `chat()` agent seam + DB-backed `getModelRoute()`, existing `idea-diversity.ts` Shannon-entropy selector.

## Global Constraints

- Immutability: never mutate inputs; return new objects. Domain types `readonly`.
- No bare model-id literals in logic — resolve via `getModelRoute(key)` (`src/store/model-routing.ts`). Confirm any `claude-*` id via the `claude-api` skill before pinning.
- Test lanes by filename suffix: `*.test.ts` (unit, no DB), `*.isolated.test.ts` (uses `mock.module`, own process — mock the NARROWEST dep), `*.integration.test.ts` (real `getDb()`; `docker compose up -d postgres`). Never bare `bun test`.
- All new behavior behind config defaults that can revert to today's. Biome 2-space/double-quote/semicolons; `bun run lint` + `bun run typecheck` green before each commit.
- Worktree-first (RULE 1); integrate via PR to `origin` (RULE 3). `bun install` in a fresh worktree before trusting checks.
- Verified base: `origin/master` @ `0774557`. `BroadCorpus` is a SIGE-only type; the pipeline passes `TrendData`/`ClusteredPains`/`CapabilityScan` separately. `isEchoChamberSignal`/`echoChamberFactor` do NOT exist — extend `saturatedThemes` (`pipeline-context.ts:194`) + `diversityGuard` instead.

---

## File Structure

**New files**
- `src/pipelines/ideas/shallow-ideation.ts` — Stage 2: form candidates → batched cheap sketches → score. One responsibility: produce `ScoredSketch[]` from the collector artifacts.
- `src/pipelines/ideas/shallow-ideation.test.ts` — pure scoring/selection unit tests.
- `src/pipelines/ideas/shallow-ideation.isolated.test.ts` — batched cheap-model call, mocking `../../agent/chat`.
- `src/pipelines/ideas/collector-stratify.ts` — Stage 1: `(signalCategory × kind)` quota selector wrapping `selectRanked`.
- `src/pipelines/ideas/collector-stratify.test.ts` — quota-spread unit tests.

**Modified files**
- `src/config/schema.ts` — flip `signalFacets`/`signalRanking` defaults; add `shallowIdeation`, `deepDevelopCount`, `intake` knobs; raise `sigeAuto.maxDeepFrontiers` cap.
- `src/store/model-routing.ts` — add `"ideas.sketches"` routing key + default.
- `src/pipelines/ideas/collectors.ts` — use the stratified selector in `scanCapabilities`/`clusterReviews`; rotate the pain-category pick in `analyzeAppLandscape`.
- `src/pipelines/ideas/synthesizer.ts` — raise the `slice` ceiling; expose intersections to Stage 2.
- `src/pipelines/ideas/pipeline.ts` — wire Stage 2 → `selectDiverseBy` → deep development.
- `src/sige/run.ts` + `src/sige/discovery/frontier-discovery.ts` — raise cluster cap + `maxDeepFrontiers`; `selectDiverseBy` over frontiers before the deep game.

---

## Phase A — Broad, stratified intake

### Task 1: [A1] Config — flip enrichment defaults + add new knobs

**Files:**
- Modify: `src/config/schema.ts` (`pipelines.ideas.smart` ~:991,994; `sigeAuto` ~:765-794)
- Test: `src/config/schema.test.ts` (create if absent, unit)

**Interfaces:**
- Produces: `smart.signalFacets`/`smart.signalRanking` default `true`; `smart.intake.{perBucketCap:number, fetchMultiplier:number}`; `smart.shallowIdeation.{enabled:boolean, candidateCount:number}`; `smart.deepDevelopCount:number`; `sigeAuto.maxDeepFrontiers` max raised to 8.

- [ ] **Step 1: Write the failing test**
```ts
// src/config/schema.test.ts
import { describe, expect, test } from "bun:test";
import { configSchema } from "./schema";

test("intake enrichment + breadth defaults", () => {
  const c = configSchema.parse({});
  const smart = c.pipelines.ideas.smart;
  expect(smart.signalFacets).toBe(true);
  expect(smart.signalRanking).toBe(true);
  expect(smart.deepDevelopCount).toBe(6);
  expect(smart.shallowIdeation.enabled).toBe(true);
  expect(smart.shallowIdeation.candidateCount).toBe(30);
  expect(smart.intake.perBucketCap).toBeGreaterThan(0);
  expect(c.pipelines.ideas.smart.sigeAuto.maxDeepFrontiers).toBe(1); // default unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun run test:unit src/config/schema.test.ts`
Expected: FAIL (`signalFacets` is `false`; `deepDevelopCount`/`shallowIdeation`/`intake` undefined).

- [ ] **Step 3: Edit schema**
In `src/config/schema.ts`, set `signalFacets: z.boolean().default(true)` and `signalRanking: z.boolean().default(true)` (lines ~991/994 and the mirrored object defaults ~1051-1053). Add inside the `smart` object:
```ts
deepDevelopCount: z.number().int().min(1).max(20).default(6),
intake: z
  .object({
    perBucketCap: z.number().int().min(1).max(50).default(6),
    fetchMultiplier: z.number().min(1).max(5).default(2),
  })
  .default({ perBucketCap: 6, fetchMultiplier: 2 }),
shallowIdeation: z
  .object({
    enabled: z.boolean().default(true),
    candidateCount: z.number().int().min(5).max(100).default(30),
  })
  .default({ enabled: true, candidateCount: 30 }),
```
In `sigeAuto`, change `maxDeepFrontiers: z.number().int().min(1).max(3).default(1)` to `.max(8).default(1)` (default unchanged; cap raised so it can be configured up).

- [ ] **Step 4: Run test to verify it passes**
Run: `bun run test:unit src/config/schema.test.ts` → PASS. Also `bun run typecheck`.

- [ ] **Step 5: Commit**
```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): enable signal enrichment by default; add intake/shallowIdeation/deepDevelopCount knobs"
```

### Task 2: [A2] Stratified `(signalCategory × kind)` selector

**Files:**
- Create: `src/pipelines/ideas/collector-stratify.ts`
- Create: `src/pipelines/ideas/collector-stratify.test.ts` (unit)

**Interfaces:**
- Consumes: `selectRanked` (`collector-ranking.ts:262`) per bucket.
- Produces:
```ts
export interface StratifyInput<T> {
  readonly rows: readonly T[];
  readonly id: (row: T) => string;
  readonly bucketKey: (row: T) => string;   // e.g. `${signalCategory}::${kind}`
  readonly score: (row: T) => number;
  readonly perBucketCap: number;
  readonly target: number;                   // overall max to return
  readonly consumed?: ReadonlySet<string>;
}
export function selectStratified<T>(input: StratifyInput<T>): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] };
```

- [ ] **Step 1: Write the failing test**
```ts
// src/pipelines/ideas/collector-stratify.test.ts
import { expect, test } from "bun:test";
import { selectStratified } from "./collector-stratify";

const rows = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, cat: "fitness", s: 100 - i })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, cat: "finance", s: 50 - i })),
];

test("no bucket exceeds perBucketCap when alternatives exist", () => {
  const { selected } = selectStratified({
    rows, id: (r) => r.id, bucketKey: (r) => r.cat, score: (r) => r.s,
    perBucketCap: 3, target: 8,
  });
  const fitness = selected.filter((r) => r.cat === "fitness").length;
  expect(fitness).toBeLessThanOrEqual(3);
  expect(selected.some((r) => r.cat === "finance")).toBe(true);
});

test("does not shrink below min(target, available)", () => {
  const { selected } = selectStratified({
    rows, id: (r) => r.id, bucketKey: (r) => r.cat, score: (r) => r.s,
    perBucketCap: 2, target: 13,
  });
  expect(selected.length).toBe(Math.min(13, rows.length));
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun run test:unit src/pipelines/ideas/collector-stratify.test.ts`
Expected: FAIL ("Cannot find module './collector-stratify'").

- [ ] **Step 3: Implement**
```ts
// src/pipelines/ideas/collector-stratify.ts
export interface StratifyInput<T> {
  readonly rows: readonly T[];
  readonly id: (row: T) => string;
  readonly bucketKey: (row: T) => string;
  readonly score: (row: T) => number;
  readonly perBucketCap: number;
  readonly target: number;
  readonly consumed?: ReadonlySet<string>;
}

export function selectStratified<T>(input: StratifyInput<T>): {
  readonly selected: readonly T[];
  readonly selectedIds: readonly string[];
} {
  const { rows, id, bucketKey, score, perBucketCap, target } = input;
  const consumed = new Set(input.consumed ?? []);
  // group → score-desc within bucket
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    if (consumed.has(id(row))) continue;
    const key = bucketKey(row);
    const list = buckets.get(key) ?? [];
    buckets.set(key, [...list, row]);
  }
  for (const [key, list] of buckets) {
    buckets.set(key, [...list].sort((a, b) => score(b) - score(a)));
  }
  // round-robin: take up to perBucketCap per bucket per pass, until target or exhausted
  const selected: T[] = [];
  const picked = new Set<string>();
  let round = 0;
  let progressed = true;
  while (selected.length < target && progressed) {
    progressed = false;
    for (const list of buckets.values()) {
      if (round >= perBucketCap) continue;
      const row = list[round];
      if (row === undefined) continue;
      const rid = id(row);
      if (picked.has(rid)) continue;
      selected.push(row);
      picked.add(rid);
      progressed = true;
      if (selected.length >= target) break;
    }
    round += 1;
    if (round >= perBucketCap) {
      // anti-starvation: if still short, relax the cap and keep filling by global score
      const remaining = rows
        .filter((r) => !picked.has(id(r)) && !consumed.has(id(r)))
        .sort((a, b) => score(b) - score(a));
      for (const row of remaining) {
        if (selected.length >= target) break;
        selected.push(row);
        picked.add(id(row));
      }
      break;
    }
  }
  return { selected, selectedIds: selected.map(id) };
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `bun run test:unit src/pipelines/ideas/collector-stratify.test.ts` → PASS. `bun run typecheck`.

- [ ] **Step 5: Commit**
```bash
git add src/pipelines/ideas/collector-stratify.ts src/pipelines/ideas/collector-stratify.test.ts
git commit -m "feat(ideas): add (category × kind) stratified collector selector"
```

### Task 3: [A3] Use the stratified selector + rotate the pain-category pick

**Files:**
- Modify: `src/pipelines/ideas/collectors.ts` — `scanCapabilities` per-source `selectRanked` calls (:885-1201) → `selectStratified` keyed on `(signalCategory, kind)`; `analyzeAppLandscape` (:249-278) category ordering.
- Modify: `src/pipelines/ideas/pipeline-context.ts` — add a category-rotation helper alongside `buildSaturatedThemes`.
- Test: `src/pipelines/ideas/collectors-stratify.isolated.test.ts` (isolated — mocks `../../store/db`).

**Interfaces:**
- Consumes: `selectStratified` (A2), `smart.intake.perBucketCap`, signal `facetEntities`/`signalCategory` payloads.
- Produces: `scanCapabilities`/`clusterReviews` unchanged return types (`CapabilityScan`/`ClusteredPains`), but selection is category-stratified; `analyzeAppLandscape` returns categories sampled across the low-rated space.

- [ ] **Step 1: Write the failing test** (category rotation is pure — test it first)
```ts
// add to src/pipelines/ideas/pipeline-context.test.ts (unit)
import { rotateLowRatedCategories } from "./pipeline-context";
test("rotates across low-rated categories instead of fixed bottom-N", () => {
  const cats = ["a", "b", "c", "d", "e", "f"]; // already AVG(rating) ASC
  const recent = new Set(["a", "b"]);           // used last run
  const pick = rotateLowRatedCategories(cats, recent, 3);
  expect(pick).toHaveLength(3);
  expect(pick.includes("a") && pick.includes("b")).toBe(false); // de-prioritize recent
  expect(pick[0]).toBe("c");
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bun run test:unit src/pipelines/ideas/pipeline-context.test.ts` → FAIL (`rotateLowRatedCategories` not exported).

- [ ] **Step 3: Implement the helper**
```ts
// src/pipelines/ideas/pipeline-context.ts (append)
/** Pick `n` low-rated categories (input already AVG(rating) ASC), de-prioritizing
 *  ones used recently so successive runs rotate across the pain space. Never returns
 *  fewer than min(n, available). */
export function rotateLowRatedCategories(
  orderedCats: readonly string[],
  recent: ReadonlySet<string>,
  n: number,
): readonly string[] {
  const fresh = orderedCats.filter((c) => !recent.has(c));
  const stale = orderedCats.filter((c) => recent.has(c));
  return [...fresh, ...stale].slice(0, Math.min(n, orderedCats.length));
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `bun run test:unit src/pipelines/ideas/pipeline-context.test.ts` → PASS.

- [ ] **Step 5: Wire into collectors (isolated test first)**
Write `src/pipelines/ideas/collectors-stratify.isolated.test.ts` mocking `../../store/db` to return rows across 3 categories for one source kind, asserting `scanCapabilities` output spans ≥2 categories (not all from the densest). Then in `collectors.ts`: replace each per-source `selectRanked(rows, consumed, id, target, score, adaptive)` with `selectStratified({ rows, id, bucketKey: (r) => `${r.signalCategory ?? "uncat"}::${kind}`, score, perBucketCap: cfg.intake.perBucketCap, target })`. In `analyzeAppLandscape`, keep the `AVG(rating) ASC` SQL, then apply `rotateLowRatedCategories(orderedCats, recentCats, focusCount)` where `recentCats` comes from a small persisted set (reuse the saturation store; if unavailable, pass empty — behavior degrades to today's bottom-N).

- [ ] **Step 6: Run lanes**
Run: `bun run test:unit && bun run test:isolated src/pipelines/ideas/collectors-stratify.isolated.test.ts && bun run typecheck && bun run lint` → all green.

- [ ] **Step 7: Commit**
```bash
git add src/pipelines/ideas/collectors.ts src/pipelines/ideas/pipeline-context.ts src/pipelines/ideas/pipeline-context.test.ts src/pipelines/ideas/collectors-stratify.isolated.test.ts
git commit -m "feat(ideas): stratify collector selection by category×kind and rotate pain-category pick"
```

---

## Phase B — Broad-shallow ideation

### Task 4: [B1] Add the `ideas.sketches` model routing key

**Files:**
- Modify: `src/store/model-routing.ts` (`ModelRoutingKey` union + `MODEL_ROUTING_DEFAULTS` ~:36-45)
- Test: `src/store/model-routing.test.ts` (unit)

**Interfaces:**
- Produces: `getModelRoute("ideas.sketches")` resolves to a cheap default `{ provider, model }`.

- [ ] **Step 1: Write the failing test**
```ts
// src/store/model-routing.test.ts (add)
import { MODEL_ROUTING_DEFAULTS } from "./model-routing";
test("ideas.sketches has a cheap default route", () => {
  const r = MODEL_ROUTING_DEFAULTS["ideas.sketches"];
  expect(r).toBeDefined();
  expect(r.provider).toBeTruthy();
  expect(r.model).toBeTruthy();
});
```

- [ ] **Step 2: Run test → FAIL**
Run: `bun run test:unit src/store/model-routing.test.ts` (key missing).

- [ ] **Step 3: Implement**
Add `"ideas.sketches"` to the `ModelRoutingKey` union and to `MODEL_ROUTING_DEFAULTS`. Mirror the existing cheap signal route — reuse the SAME provider/model as `"signal.facets"` (`{ provider: "alibaba", model: "deepseek-v4-flash" }`) so no new model id is introduced. Do NOT hardcode a `claude-*` id.

- [ ] **Step 4: Run test → PASS**; `bun run typecheck`.

- [ ] **Step 5: Commit**
```bash
git add src/store/model-routing.ts src/store/model-routing.test.ts
git commit -m "feat(routing): add ideas.sketches cheap-model routing key"
```

### Task 5: [B2] `shallow-ideation.ts` — candidates → cheap sketches → scored

**Files:**
- Create: `src/pipelines/ideas/shallow-ideation.ts`
- Create: `src/pipelines/ideas/shallow-ideation.test.ts` (unit — pure scoring/select)
- Create: `src/pipelines/ideas/shallow-ideation.isolated.test.ts` (isolated — mocks `../../agent/chat`)

**Interfaces:**
- Consumes: `chat` (`src/agent/chat.ts:52`), `getModelRoute("ideas.sketches")`, `selectDiverseBy` (`idea-diversity.ts:232`).
- Produces:
```ts
export interface SketchCandidate { readonly id: string; readonly theme: string; readonly seedText: string; readonly category: string; readonly signalStrength: number; }
export interface ScoredSketch extends SketchCandidate { readonly sketch: string; readonly score: number; }
export interface ShallowIdeationDeps { readonly chat: typeof import("../../agent/chat").chat; readonly model: string; readonly provider: string; }
export async function sketchAndScore(candidates: readonly SketchCandidate[], deps: ShallowIdeationDeps, batchSize?: number): Promise<readonly ScoredSketch[]>;
export function selectDeepTargets(scored: readonly ScoredSketch[], count: number, maxBucketShare: number): readonly ScoredSketch[];
```

- [ ] **Step 1: Write the failing pure-scoring test**
```ts
// src/pipelines/ideas/shallow-ideation.test.ts
import { expect, test } from "bun:test";
import { type ScoredSketch, selectDeepTargets } from "./shallow-ideation";
const mk = (id: string, cat: string, score: number): ScoredSketch => ({
  id, theme: id, seedText: "", category: cat, signalStrength: score, sketch: "s", score,
});
test("selectDeepTargets returns count, diversified across categories", () => {
  const scored = [
    mk("1", "fitness", 9), mk("2", "fitness", 8), mk("3", "fitness", 7),
    mk("4", "finance", 6), mk("5", "travel", 5),
  ];
  const out = selectDeepTargets(scored, 3, 0.5);
  expect(out).toHaveLength(3);
  expect(new Set(out.map((s) => s.category)).size).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run test → FAIL** (module missing).
Run: `bun run test:unit src/pipelines/ideas/shallow-ideation.test.ts`

- [ ] **Step 3: Implement the module**
```ts
// src/pipelines/ideas/shallow-ideation.ts
import { selectDiverseBy } from "./idea-diversity";

export interface SketchCandidate {
  readonly id: string; readonly theme: string; readonly seedText: string;
  readonly category: string; readonly signalStrength: number;
}
export interface ScoredSketch extends SketchCandidate { readonly sketch: string; readonly score: number; }
export interface ShallowIdeationDeps {
  readonly chat: typeof import("../../agent/chat").chat;
  readonly model: string; readonly provider: string;
}

const SYSTEM = "You are a product ideation assistant. For each numbered seed, return ONE terse one-sentence product idea. Output ONLY a JSON object mapping the seed number (string) to the idea string. No prose, no code fences.";

function buildPrompt(batch: readonly SketchCandidate[]): string {
  const lines = batch.map((c, i) => `${i + 1}. theme=${c.theme} :: ${c.seedText}`).join("\n");
  return `Seeds:\n${lines}`;
}

function parseSketches(content: string, batch: readonly SketchCandidate[]): Map<string, string> {
  let text = content.trim();
  if (text.startsWith("```")) text = text.split("```")[1]?.replace(/^json/, "").trim() ?? text;
  let obj: Record<string, unknown> = {};
  try { obj = JSON.parse(text); }
  catch { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s >= 0 && e > s) obj = JSON.parse(text.slice(s, e + 1)); }
  const out = new Map<string, string>();
  batch.forEach((c, i) => {
    const v = obj[String(i + 1)];
    if (typeof v === "string" && v.length > 0) out.set(c.id, v);
  });
  return out;
}

/** novelty/market score: signalStrength is the available scalar; sketches that the
 *  model declined to produce score 0 (dropped from deep targets). */
function scoreOf(c: SketchCandidate, sketch: string | undefined): number {
  if (sketch === undefined) return 0;
  return c.signalStrength;
}

export async function sketchAndScore(
  candidates: readonly SketchCandidate[],
  deps: ShallowIdeationDeps,
  batchSize = 12,
): Promise<readonly ScoredSketch[]> {
  const out: ScoredSketch[] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    let sketches = new Map<string, string>();
    try {
      const resp = await deps.chat(
        [{ role: "user", content: buildPrompt(batch), timestamp: Date.now() }],
        { model: deps.model, provider: deps.provider, systemPrompt: SYSTEM },
      );
      sketches = parseSketches(resp.content ?? "", batch);
    } catch { /* leave batch unsketched → scored 0, filtered below */ }
    for (const c of batch) {
      const sketch = sketches.get(c.id);
      out.push({ ...c, sketch: sketch ?? "", score: scoreOf(c, sketch) });
    }
  }
  return out.filter((s) => s.score > 0);
}

export function selectDeepTargets(
  scored: readonly ScoredSketch[],
  count: number,
  maxBucketShare: number,
): readonly ScoredSketch[] {
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  return selectDiverseBy(ranked, {
    maxIdeas: count, maxBucketShare,
    resolveBucket: (s) => s.category || "uncat",
  });
}
```
(Adjust `resp.content` access to the real `AgentResponse` field name — confirm in `src/agent/chat.ts`.)

- [ ] **Step 4: Run pure test → PASS**
Run: `bun run test:unit src/pipelines/ideas/shallow-ideation.test.ts` → PASS.

- [ ] **Step 5: Isolated test for the batched call**
```ts
// src/pipelines/ideas/shallow-ideation.isolated.test.ts
import { expect, mock, test } from "bun:test";
test("sketchAndScore batches and maps sketches back by id", async () => {
  const chat = mock(async () => ({ content: '{"1":"idea one","2":"idea two"}' }));
  const { sketchAndScore } = await import("./shallow-ideation");
  const cands = [
    { id: "a", theme: "t1", seedText: "s1", category: "fitness", signalStrength: 5 },
    { id: "b", theme: "t2", seedText: "s2", category: "finance", signalStrength: 4 },
  ];
  const out = await sketchAndScore(cands, { chat: chat as never, model: "m", provider: "p" }, 12);
  expect(out).toHaveLength(2);
  expect(out.find((s) => s.id === "a")?.sketch).toBe("idea one");
  expect(chat).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 6: Run isolated test → PASS**
Run: `bun run test:isolated src/pipelines/ideas/shallow-ideation.isolated.test.ts` → PASS. `bun run typecheck && bun run lint`.

- [ ] **Step 7: Commit**
```bash
git add src/pipelines/ideas/shallow-ideation.ts src/pipelines/ideas/shallow-ideation.test.ts src/pipelines/ideas/shallow-ideation.isolated.test.ts
git commit -m "feat(ideas): add shallow-ideation cheap-sketch + diverse deep-target selection"
```

---

## Phase C — Selective-deep wiring (pipeline)

### Task 6: [C1] Widen the intersection neck → shallow → diverse → deep

**Files:**
- Modify: `src/pipelines/ideas/synthesizer.ts` (:390-393 slice; expose intersections)
- Modify: `src/pipelines/ideas/pipeline.ts` (between intersection build ~:402 and deep develop ~:410)
- Test: `src/pipelines/ideas/synthesizer-ranking.test.ts` (unit, extend)

**Interfaces:**
- Consumes: `sketchAndScore`/`selectDeepTargets` (B2), `smart.shallowIdeation.candidateCount`, `smart.deepDevelopCount`, `IntersectionHypothesis` (`types.ts:215`).
- Produces: deep development receives `deepDevelopCount` diverse intersections drawn from a `candidateCount`-wide pool.

- [ ] **Step 1: Write the failing test**
```ts
// src/pipelines/ideas/synthesizer-ranking.test.ts (add)
import { topCandidateIntersections } from "./synthesizer";
test("widened neck returns up to candidateCount, not hardcoded 10", () => {
  const xs = Array.from({ length: 40 }, (_, i) => ({
    title: `t${i}`, painSignal: "", capabilitySignal: "", marketSignal: "",
    hypothesis: "", signalStrength: 40 - i,
  }));
  expect(topCandidateIntersections(xs, 30)).toHaveLength(30);
});
```

- [ ] **Step 2: Run → FAIL** (`topCandidateIntersections` not exported).
Run: `bun run test:unit src/pipelines/ideas/synthesizer-ranking.test.ts`

- [ ] **Step 3: Extract + widen the neck**
In `synthesizer.ts`, replace the inline `slice(0, Math.min(maxIdeas*2, 10))` with an exported pure fn used by both the legacy path and Stage 2:
```ts
export function topCandidateIntersections(
  intersections: readonly IntersectionHypothesis[],
  candidateCount: number,
): readonly IntersectionHypothesis[] {
  return [...intersections].sort((a, b) => b.signalStrength - a.signalStrength).slice(0, candidateCount);
}
```
Call it with `config.smart.shallowIdeation.candidateCount` (default 30) instead of the literal 10.

- [ ] **Step 4: Run → PASS**.

- [ ] **Step 5: Wire Stage 2 in `pipeline.ts`**
After intersections are built, map them to `SketchCandidate[]` (`id=title`, `theme=title`, `seedText=hypothesis`, `category` from the intersection's pain category, `signalStrength`), call `sketchAndScore(cands, deps)` then `selectDeepTargets(scored, config.smart.deepDevelopCount, config.smart.diversityGuard.maxBucketShare)`, and feed the resulting themes into the existing `developIdeasWide`. Gate on `config.smart.shallowIdeation.enabled` (when false, fall back to today's `topIntersections.slice` path). Build `deps` via `getModelRoute("ideas.sketches")` + `chat`.

- [ ] **Step 6: Run lanes**
Run: `bun run test:unit && bun run typecheck && bun run lint` → green. (Add an `*.integration.test.ts` asserting a run yields ideas spanning ≥3 distinct `signalCategory` values when seed data spans categories.)

- [ ] **Step 7: Commit**
```bash
git add src/pipelines/ideas/synthesizer.ts src/pipelines/ideas/pipeline.ts src/pipelines/ideas/synthesizer-ranking.test.ts
git commit -m "feat(ideas): widen intersection neck and route through shallow-ideation + diverse deep selection"
```

---

## Phase D — Selective-deep wiring (SIGE)

### Task 7: [D1] Raise cluster cap + frontier breadth, diversify deep targets

**Files:**
- Modify: `src/sige/discovery/frontier-discovery.ts` (clusterCap ~:416; `DEFAULT_MAX_FRONTIERS` :36)
- Modify: `src/sige/run.ts` (:331-368 — frontier selection + deep loop)
- Test: `src/sige/discovery/frontier-discovery.test.ts` (unit) + `src/sige/run.isolated.test.ts`

**Interfaces:**
- Consumes: `selectDiverseBy` (`idea-diversity.ts:232`), `sigeAuto.maxDeepFrontiers`, the `Frontier` type (`frontier-discovery.ts:45`).
- Produces: SIGE deep-develops `maxDeepFrontiers` DIVERSE frontiers (by `theme`/category), chosen from a pool sized independent of `maxDeepFrontiers`.

- [ ] **Step 1: Write the failing test**
```ts
// src/sige/discovery/frontier-discovery.test.ts (add)
import { resolveClusterCap } from "./frontier-discovery";
test("cluster cap is independent of deep-frontier count", () => {
  // discover a broad pool regardless of how many we later deep-dive
  expect(resolveClusterCap(1)).toBe(8);
  expect(resolveClusterCap(6)).toBe(8);
});
```

- [ ] **Step 2: Run → FAIL** (`resolveClusterCap` not exported / still couples to depth).
Run: `bun run test:unit src/sige/discovery/frontier-discovery.test.ts`

- [ ] **Step 3: Decouple cluster cap from deep count**
Extract the cap calc into `export function resolveClusterCap(_requestedDeep: number): number { return DEFAULT_MAX_FRONTIERS; }` and call it in `clusterIntoFrontiers` so discovery always produces up to 8 frontiers, regardless of how many get deep-developed.

- [ ] **Step 4: Run → PASS**.

- [ ] **Step 5: Diversify frontier selection in `run.ts`**
Replace `discovery.frontiers.slice(0, maxDeepFrontiers)` (:349) with:
```ts
import { selectDiverseBy } from "../pipelines/ideas/idea-diversity";
const topFrontiers = selectDiverseBy([...discovery.frontiers].sort((a, b) => b.score - a.score), {
  maxIdeas: sigeAutoConfig.maxDeepFrontiers,
  maxBucketShare: 0.5,
  resolveBucket: (f) => f.theme,
});
```
Add an isolated test (`run.isolated.test.ts`, mocking `discoverFrontiers`) asserting that with `maxDeepFrontiers=3` over 8 frontiers spanning 4 themes, the 3 chosen span ≥2 themes.

- [ ] **Step 6: Run lanes**
Run: `bun run test:unit && bun run test:isolated && bun run typecheck && bun run lint` → green.

- [ ] **Step 7: Commit**
```bash
git add src/sige/discovery/frontier-discovery.ts src/sige/run.ts src/sige/discovery/frontier-discovery.test.ts src/sige/run.isolated.test.ts
git commit -m "feat(sige): discover full frontier pool and deep-develop a diverse subset"
```

---

## Final verification (before PR)

- [ ] `bun run typecheck && bun run lint`
- [ ] `bun run test:unit && bun run test:isolated`
- [ ] `docker compose up -d postgres && bun run test:integration` (the distinct-category metric test)
- [ ] Manual: run the pipeline with `env -u CLAUDECODE` against seed data spanning ≥4 categories; confirm the run summary shows materially more distinct `signalCategory`/archetype values than a `shallowIdeation.enabled=false` baseline run.
- [ ] Dispatch `security-reviewer` on the diff (untrusted seed text now reaches the cheap-model sketch prompt — confirm the UNTRUSTED preamble/escaping applies and no injection into deep prompts).
- [ ] Ship via worktree → PR → CI → deploy (native restart) per repo flow.

## Success metric

Distinct `signalCategory` count and distinct archetype count per run materially increase vs. the `shallowIdeation.enabled=false` baseline; a manual read of one run shows visibly less "same idea, reworded." Capture both numbers in the PR description.
