# App Store Keyword-Gap Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scheduled App Store keyword-gap scanner that measures per-keyword demand vs. competitiveness vs. incumbent-weakness, persists it with history, and feeds the idea funnel as both demand/whitespace evidence and idea seeds, plus a dashboard surface.

**Architecture:** A pure, deterministic scorer over live iTunes Search results populates two new tables (`appstore_keywords`, `appstore_keyword_scans`) via a scheduled capability co-located in the existing appstore scraper. The idea pipeline consumes scans through a new `appstore_gap` demand-evidence kind (→ `DemandArtifact.whitespace`) and a new seed collector; the web dashboard reads them through new endpoints.

**Tech Stack:** Bun, strict TypeScript (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`), PostgreSQL via `Bun.sql`, Zod, Hono, React 19, Biome.

## Global Constraints

- **Worktree:** already active — `.claude/worktrees/appstore-keyword-gap-scanner` on `feat/appstore-keyword-gap-scanner`. Run `bun install` before trusting any check.
- **Immutability:** never mutate inputs; domain types are `readonly`.
- **Strict TS:** `import type` for types; treat indexed access as `T | undefined`.
- **DB:** `Bun.sql` via `getDb()`; migrations numbered `.sql`, `IF NOT EXISTS`, idempotent. Keep `XRow` ↔ `rowToX()` ↔ `readonly` domain split. Arrays interpolate as `col IN ${db(arr)}` (NOT `= ANY`); epoch-int columns compared to `Math.floor(Date.now()/1000) - windowSec`, never `NOW()`.
- **Validation:** Zod at every external boundary (config, HTTP query params, fetched JSON).
- **Logging:** `createLogger("scope")`; no bare `console.log`.
- **Files:** 200–400 lines typical, 800 max.
- **Lint/format:** Biome (2-space, double quotes, semicolons, trailing commas, width 100). `bun run lint`.
- **Tests — lane by filename suffix:** `*.test.ts` → `bun run test:unit` (no DB); `*.integration.test.ts` → `bun run test:integration` (`docker compose up -d postgres` first); `*.isolated.test.ts` → `bun run test:isolated` (any `mock.module`). Never bare `bun test`.
- **Definition of done:** `bun run typecheck`, `bun run lint`, relevant test lane(s) green (seen, not assumed); `bun run tw:build` if styles changed.
- **Scoring calibration anchors** (competitiveness, US storefront, from the validated `appstore-mcp-server`): `glucose tracker`≈25, `fatty liver diet`≈21, `receipt scanner`≈81, `ai resume builder`≈77. Fixture tests must keep the scorer within ±8 of these.
- **Git:** conventional commits; integrate via PR to `origin/master` only — never merge/reset local `master`.

---

## Shared type contract (created in Task 2 as `keyword-types.ts`; referenced everywhere)

```typescript
// src/sources/appstore/keyword-types.ts
export type GapTrend = "heating" | "stable" | "cooling" | "new";

export interface TopApp {
  readonly id: string;
  readonly name: string;
  readonly reviews: number;       // userRatingCount
  readonly rating: number;        // averageUserRating (0..5)
  readonly ageDays: number;       // days since releaseDate
  readonly ratingsPerDay: number; // reviews / max(ageDays,1)
  readonly titleMatch: boolean;   // keyword tokens present in trackName
}

export interface KeywordGapProfile {
  readonly keyword: string;
  readonly store: "app" | "play";
  readonly competitiveness: number;    // 0..100
  readonly demand: number;             // mean ratingsPerDay across topApps
  readonly incumbentWeakness: number;  // 0..1
  readonly opportunity: number;        // 0..1  (== whitespace)
  readonly trend: GapTrend;
  readonly topAppReviews: number;      // max reviews in field (raw, audit)
  readonly avgRating: number;          // mean rating (raw, audit)
  readonly avgAgeDays: number;         // mean age (raw, audit)
  readonly topApps: readonly TopApp[];
  readonly scannedAt: number;          // epoch seconds
}
```

---

## Phase 1 — Data foundation

### Task 1: Migration — keyword-gap tables

**Files:**
- Create: `src/store/migrations/031_appstore_keyword_gaps.sql`
- Test: `src/sources/appstore/keyword-store.integration.test.ts` (asserts tables exist; written in Task 2)

**Interfaces:**
- Produces: tables `appstore_keywords`, `appstore_keyword_scans` (schemas below).

- [ ] **Step 1: Write the migration**

```sql
-- App Store keyword-gap scanner: the seed corpus of search terms to scan and a
-- per-run snapshot of each term's supply/demand profile. Additive + idempotent.
-- `appstore_keyword_scans` keeps history (one row per keyword per scan run) so
-- `trend` is computable and the dashboard can sparkline. `store` is present from
-- day one so Play Store is a data-only follow-up (default 'app').

CREATE TABLE IF NOT EXISTS appstore_keywords (
  keyword         TEXT PRIMARY KEY,
  genre_zone      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'seed',   -- seed|autocomplete|manual|pipeline
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      BIGINT NOT NULL,
  last_scanned_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_appstore_keywords_slice
  ON appstore_keywords (active, genre_zone, last_scanned_at ASC NULLS FIRST);

CREATE TABLE IF NOT EXISTS appstore_keyword_scans (
  id                 BIGSERIAL PRIMARY KEY,
  keyword            TEXT NOT NULL,
  store              TEXT NOT NULL DEFAULT 'app',
  scanned_at         BIGINT NOT NULL,
  competitiveness    REAL NOT NULL,
  demand             REAL NOT NULL,
  incumbent_weakness REAL NOT NULL,
  opportunity        REAL NOT NULL,
  trend              TEXT NOT NULL,
  top_app_reviews    INTEGER NOT NULL,
  avg_rating         REAL NOT NULL,
  avg_age_days       REAL NOT NULL,
  top_apps           JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_history
  ON appstore_keyword_scans (keyword, store, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_top
  ON appstore_keyword_scans (scanned_at DESC, opportunity DESC);
```

- [ ] **Step 2: Verify it applies** — Run: `docker compose up -d postgres && bun run migrate` (or start the app once). Expected: no error; `\d appstore_keyword_scans` in `psql` shows the columns.

- [ ] **Step 3: Commit**

```bash
git add src/store/migrations/031_appstore_keyword_gaps.sql
git commit -m "feat: migration for appstore keyword-gap tables"
```

---

### Task 2: Keyword store — rows, upsert, readers

**Files:**
- Create: `src/sources/appstore/keyword-types.ts` (the shared type contract above — `GapTrend`, `TopApp`, `KeywordGapProfile`)
- Create: `src/sources/appstore/keyword-store.ts`
- Test: `src/sources/appstore/keyword-store.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 tables; `KeywordGapProfile`, `TopApp`, `GapTrend` (created here in `keyword-types.ts`).
- Produces:
  - `upsertKeywords(rows: readonly KeywordSeedRow[]): Promise<number>`
  - `getStaleKeywords(genreZone: string, limit: number): Promise<readonly string[]>`
  - `markScanned(keywords: readonly string[], at: number): Promise<void>`
  - `insertScan(p: KeywordGapProfile): Promise<void>`
  - `getLatestScan(keyword: string, store?: "app"|"play"): Promise<KeywordScanRow | null>`
  - `getTopOpportunities(opts: { limit: number; genreZone?: string; trend?: GapTrend }): Promise<readonly KeywordScanRow[]>`
  - `getScanHistory(keyword: string, limit: number): Promise<readonly KeywordScanRow[]>`
  - types `KeywordSeedRow`, `KeywordScanRow`, `rowToScan()`

- [ ] **Step 1: Write the failing integration test**

```typescript
// keyword-store.integration.test.ts
import { describe, expect, it, beforeAll } from "bun:test";
import { upsertKeywords, getStaleKeywords, markScanned, insertScan, getLatestScan, getTopOpportunities } from "./keyword-store";

describe("keyword-store", () => {
  it("upserts corpus and reads a stale slice", async () => {
    await upsertKeywords([{ keyword: "fatty liver diet", genreZone: "health", source: "seed" }]);
    const stale = await getStaleKeywords("health", 10);
    expect(stale).toContain("fatty liver diet");
  });

  it("persists a scan and reads it back as latest + top opportunity", async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertKeywords([{ keyword: "zzz test gap", genreZone: "health", source: "seed" }]);
    await insertScan({
      keyword: "zzz test gap", store: "app", competitiveness: 20, demand: 13, incumbentWeakness: 0.8,
      opportunity: 0.53, trend: "heating", topAppReviews: 11, avgRating: 3.4, avgAgeDays: 500,
      topApps: [{ id: "1", name: "Toy", reviews: 11, rating: 3.4, ageDays: 500, ratingsPerDay: 0.02, titleMatch: true }],
      scannedAt: now,
    });
    await markScanned(["zzz test gap"], now);
    const latest = await getLatestScan("zzz test gap");
    expect(latest?.opportunity).toBeCloseTo(0.53, 2);
    const top = await getTopOpportunities({ limit: 5 });
    expect(top.some((r) => r.keyword === "zzz test gap")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `docker compose up -d postgres && bun run test:integration keyword-store` → FAIL (module not found).

- [ ] **Step 3: Implement `keyword-store.ts`**

Follow the exact patterns in `src/sources/appstore/store.ts`: `getDb()`, `INSERT ... ON CONFLICT`, epoch-int `created_at`, a `KeywordScanRow` interface + `rowToScan()` casting the JSONB `top_apps`. Key bodies:

```typescript
import { getDb } from "../../store/db";
import type { GapTrend, KeywordGapProfile, TopApp } from "./keyword-types";

export interface KeywordSeedRow {
  readonly keyword: string;
  readonly genreZone: string;
  readonly source: "seed" | "autocomplete" | "manual" | "pipeline";
}

export interface KeywordScanRow {
  readonly id: number;
  readonly keyword: string;
  readonly store: "app" | "play";
  readonly scannedAt: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly opportunity: number;
  readonly trend: GapTrend;
  readonly topAppReviews: number;
  readonly avgRating: number;
  readonly avgAgeDays: number;
  readonly topApps: readonly TopApp[];
}

export async function upsertKeywords(rows: readonly KeywordSeedRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const r of rows) {
    await db`
      INSERT INTO appstore_keywords (keyword, genre_zone, source, active, created_at)
      VALUES (${r.keyword}, ${r.genreZone}, ${r.source}, TRUE, ${now})
      ON CONFLICT (keyword) DO UPDATE SET genre_zone = EXCLUDED.genre_zone
    `;
    n++;
  }
  return n;
}

export async function getStaleKeywords(genreZone: string, limit: number): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keywords
    WHERE active = TRUE AND genre_zone = ${genreZone}
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return rows.map((r: { keyword: string }) => r.keyword);
}

export async function markScanned(keywords: readonly string[], at: number): Promise<void> {
  if (keywords.length === 0) return;
  const db = getDb();
  await db`UPDATE appstore_keywords SET last_scanned_at = ${at} WHERE keyword IN ${db(keywords)}`;
}

export async function insertScan(p: KeywordGapProfile): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO appstore_keyword_scans (
      keyword, store, scanned_at, competitiveness, demand, incumbent_weakness,
      opportunity, trend, top_app_reviews, avg_rating, avg_age_days, top_apps
    ) VALUES (
      ${p.keyword}, ${p.store}, ${p.scannedAt}, ${p.competitiveness}, ${p.demand},
      ${p.incumbentWeakness}, ${p.opportunity}, ${p.trend}, ${p.topAppReviews},
      ${p.avgRating}, ${p.avgAgeDays}, ${JSON.stringify(p.topApps)}
    )
  `;
}
```

`getLatestScan`, `getTopOpportunities`, `getScanHistory`, and `rowToScan` follow the same `getDb()` + `DISTINCT ON (keyword) ... ORDER BY scanned_at DESC` shape used by `getRankings` in `store.ts`. `rowToScan` parses `top_apps` (already an object from JSONB) and coerces numeric columns.

- [ ] **Step 4: Run to verify it passes** — Run: `bun run test:integration keyword-store` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/appstore/keyword-store.ts src/sources/appstore/keyword-store.integration.test.ts
git commit -m "feat: keyword-gap store (upsert corpus, insert/read scans)"
```

---

### Task 3: Keyword corpus generation (pure)

**Files:**
- Create: `src/sources/appstore/keyword-corpus.ts`
- Test: `src/sources/appstore/keyword-corpus.test.ts`

**Interfaces:**
- Produces:
  - `GENRE_ZONES: readonly string[]`
  - `buildSeedCorpus(): readonly KeywordSeedRow[]` (deterministic; base-nouns × modifiers + `X for Y` long-tail per zone)
  - `MODIFIERS: readonly string[]`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { buildSeedCorpus, GENRE_ZONES } from "./keyword-corpus";

describe("keyword-corpus", () => {
  it("is deterministic and covers every genre zone", () => {
    const a = buildSeedCorpus();
    const b = buildSeedCorpus();
    expect(a).toEqual(b);
    for (const zone of GENRE_ZONES) expect(a.some((r) => r.genreZone === zone)).toBe(true);
  });
  it("normalizes keywords to lowercase and dedupes", () => {
    const corpus = buildSeedCorpus();
    const keys = corpus.map((r) => r.keyword);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k === k.toLowerCase())).toBe(true);
  });
  it("includes a known health gap seed", () => {
    expect(buildSeedCorpus().some((r) => r.keyword === "fatty liver diet")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test:unit keyword-corpus` → FAIL.

- [ ] **Step 3: Implement** — a `Record<zone, { nouns: string[]; longTail: string[] }>` seed table, cross `nouns × MODIFIERS`, add `longTail`, normalize (`toLowerCase().trim()` collapsing whitespace), dedupe via `Set`, tag each with `source: "seed"`. Keep the noun lists focused (10–25 nouns/zone) — the autocomplete loop (Task 8b) grows it later. Zones: `health, finance, productivity, business, lifestyle, food, education, utilities, photo, parenting, social, travel, sports, entertainment, reference`.

- [ ] **Step 4: Run to verify it passes** — Run: `bun run test:unit keyword-corpus` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/appstore/keyword-corpus.ts src/sources/appstore/keyword-corpus.test.ts
git commit -m "feat: deterministic app-store keyword seed corpus"
```

---

## Phase 2 — Scoring core

### Task 4: Scorer — demand, competitiveness, incumbent-weakness, opportunity (pure)

**Files:**
- Create: `src/sources/appstore/keyword-scoring.ts`
- Test: `src/sources/appstore/keyword-scoring.test.ts`

**Interfaces:**
- Consumes: `TopApp`, `GapTrend` (from `keyword-types.ts`, created in Task 2).
- Produces (all pure):
  - `computeDemand(apps: readonly TopApp[]): number`
  - `computeCompetitiveness(apps: readonly TopApp[]): number` (0..100)
  - `computeIncumbentWeakness(apps: readonly TopApp[], competitiveness: number): number` (0..1)
  - `computeOpportunity(a: { demand: number; competitiveness: number; incumbentWeakness: number; trend: GapTrend }): number` (0..1)
  - constants `REVIEWS_REF = 500_000`, `VELOCITY_REF = 400`, `DEMAND_REF = 50`

Formulas (calibrated to the anchors):

```typescript
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const norm = (x: number, ref: number) => clamp01(Math.log1p(x) / Math.log1p(ref));

// per-app strength blends review mass and live velocity
const appStrength = (a: TopApp) =>
  0.6 * norm(a.reviews, REVIEWS_REF) + 0.4 * norm(a.ratingsPerDay, VELOCITY_REF);

export function computeDemand(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  return apps.reduce((s, a) => s + a.ratingsPerDay, 0) / apps.length;
}
export function computeCompetitiveness(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  const mean = apps.reduce((s, a) => s + appStrength(a), 0) / apps.length;
  return Math.round(mean * 1000) / 10; // 0..100, one decimal
}
export function computeIncumbentWeakness(apps: readonly TopApp[], competitiveness: number): number {
  if (apps.length === 0) return 1;
  const meanRating = apps.reduce((s, a) => s + a.rating, 0) / apps.length;
  const ratingWeakness = clamp01((4.5 - meanRating) / 2); // 4.5+→0, 2.5→1
  return clamp01(0.6 * (1 - competitiveness / 100) + 0.4 * ratingWeakness);
}
const TREND_MULT: Record<GapTrend, number> = { heating: 1.15, stable: 1.0, new: 1.0, cooling: 0.85 };
export function computeOpportunity(a: { demand: number; competitiveness: number; incumbentWeakness: number; trend: GapTrend }): number {
  const demandNorm = norm(a.demand, DEMAND_REF);
  return clamp01(demandNorm * (1 - a.competitiveness / 100) * (0.5 + 0.5 * a.incumbentWeakness) * TREND_MULT[a.trend]);
}
```

- [ ] **Step 1: Write the failing test (calibration + ordering + edges)**

```typescript
import { describe, expect, it } from "bun:test";
import { computeCompetitiveness, computeDemand, computeIncumbentWeakness, computeOpportunity } from "./keyword-scoring";
import type { TopApp } from "./keyword-types";

const app = (reviews: number, rating: number, ratingsPerDay: number): TopApp =>
  ({ id: "x", name: "x", reviews, rating, ageDays: 1000, ratingsPerDay, titleMatch: true });

// saturated field (receipt-scanner-like): many strong apps
const saturated = Array.from({ length: 20 }, () => app(400_000, 4.6, 180));
// open field (fatty-liver-like): all toys
const open = Array.from({ length: 20 }, () => app(8, 3.4, 0.03));

describe("keyword-scoring", () => {
  it("scores a saturated field high (>=70) and an open field low (<=30)", () => {
    expect(computeCompetitiveness(saturated)).toBeGreaterThanOrEqual(70);
    expect(computeCompetitiveness(open)).toBeLessThanOrEqual(30);
  });
  it("flags weak incumbents on the open field", () => {
    const comp = computeCompetitiveness(open);
    expect(computeIncumbentWeakness(open, comp)).toBeGreaterThan(0.6);
  });
  it("ranks the open gap's opportunity above the saturated one", () => {
    const oComp = computeCompetitiveness(open);
    const sComp = computeCompetitiveness(saturated);
    const oOpp = computeOpportunity({ demand: computeDemand(open), competitiveness: oComp, incumbentWeakness: computeIncumbentWeakness(open, oComp), trend: "heating" });
    const sOpp = computeOpportunity({ demand: computeDemand(saturated), competitiveness: sComp, incumbentWeakness: computeIncumbentWeakness(saturated, sComp), trend: "stable" });
    expect(oOpp).toBeGreaterThan(sOpp);
  });
  it("handles an empty field without throwing", () => {
    expect(computeCompetitiveness([])).toBe(0);
    expect(computeDemand([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test:unit keyword-scoring` → FAIL.
- [ ] **Step 3: Implement** `keyword-types.ts` + `keyword-scoring.ts` with the formulas above.
- [ ] **Step 4: Run to verify it passes** — Run: `bun run test:unit keyword-scoring` → PASS. If a band misses, tune `REVIEWS_REF`/`VELOCITY_REF` (only) until anchors hold; do not change the shape.
- [ ] **Step 5: Commit**

```bash
git add src/sources/appstore/keyword-types.ts src/sources/appstore/keyword-scoring.ts src/sources/appstore/keyword-scoring.test.ts
git commit -m "feat: deterministic keyword-gap scoring core"
```

---

### Task 5: Trend classification (pure)

**Files:**
- Modify: `src/sources/appstore/keyword-scoring.ts`
- Test: `src/sources/appstore/keyword-scoring.test.ts` (append)

**Interfaces:**
- Produces: `classifyTrend(currentDemand: number, previousDemand: number | null): GapTrend`

- [ ] **Step 1: Add failing test**

```typescript
import { classifyTrend } from "./keyword-scoring";
describe("classifyTrend", () => {
  it("returns new with no history", () => expect(classifyTrend(10, null)).toBe("new"));
  it("heating when up >15%", () => expect(classifyTrend(12, 10)).toBe("heating"));
  it("cooling when down >15%", () => expect(classifyTrend(8, 10)).toBe("cooling"));
  it("stable within band", () => expect(classifyTrend(10.5, 10)).toBe("stable"));
});
```

- [ ] **Step 2: Run → FAIL.** `bun run test:unit keyword-scoring`
- [ ] **Step 3: Implement**

```typescript
export function classifyTrend(current: number, previous: number | null): GapTrend {
  if (previous === null || previous <= 0) return "new";
  const ratio = current / previous;
  if (ratio > 1.15) return "heating";
  if (ratio < 0.85) return "cooling";
  return "stable";
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: keyword-gap trend classification"`

---

### Task 6: iTunes fetch shell + scanKeyword orchestration

**Files:**
- Create: `src/sources/appstore/keyword-gaps.ts`
- Test: `src/sources/appstore/keyword-gaps.isolated.test.ts` (uses `mock.module` → `.isolated` suffix)

**Interfaces:**
- Consumes: `keyword-scoring.ts`, `keyword-store.ts` (`getLatestScan`), `ssrf-safe-fetch`.
- Produces:
  - `toTopApp(raw: ItunesSoftwareResult, keyword: string, now: number): TopApp`
  - `fetchTopApps(keyword: string, topN: number): Promise<readonly TopApp[]>`
  - `scanKeyword(keyword: string, opts?: { topN?: number; store?: "app"|"play" }): Promise<KeywordGapProfile>`

- [ ] **Step 1: Write the failing isolated test** — `mock.module` the fetch to return a fixed iTunes payload (2 toys + reuse the `open` fixture shape) and a stubbed `getLatestScan` returning `null`; assert `scanKeyword("fatty liver diet")` yields `competitiveness < 30`, `trend === "new"`, `topApps.length === 2`, and `opportunity > 0`.

```typescript
import { describe, expect, it, mock, beforeEach } from "bun:test";

const sample = { results: [
  { trackId: 1, trackName: "LiverPal", userRatingCount: 7, averageUserRating: 5, releaseDate: "2020-01-01T00:00:00Z" },
  { trackId: 2, trackName: "Fatty Liver", userRatingCount: 1, averageUserRating: 1, releaseDate: "2019-01-01T00:00:00Z" },
]};

describe("scanKeyword", () => {
  beforeEach(() => {
    mock.module("../shared/ssrf-safe-fetch", () => ({ ssrfSafeFetch: async () => ({ ok: true, json: async () => sample }) }));
    mock.module("./keyword-store", () => ({ getLatestScan: async () => null }));
  });
  it("scores an open gap from live results", async () => {
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("fatty liver diet");
    expect(p.topApps.length).toBe(2);
    expect(p.competitiveness).toBeLessThan(30);
    expect(p.trend).toBe("new");
    expect(p.opportunity).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun run test:isolated keyword-gaps`
- [ ] **Step 3: Implement** — `toTopApp` computes `ageDays` from `releaseDate`, `ratingsPerDay = userRatingCount / max(ageDays,1)`, `titleMatch` from tokenized keyword ⊆ trackName. `fetchTopApps` builds `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&entity=software&limit=${topN}&country=us`, fetches via `ssrfSafeFetch`, Zod-parses results, maps. `scanKeyword` = fetch → compute all metrics → `classifyTrend(demand, (await getLatestScan(keyword))?.demand ?? null)` → assemble `KeywordGapProfile` with `scannedAt = Math.floor(Date.now()/1000)`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add src/sources/appstore/keyword-gaps.ts src/sources/appstore/keyword-gaps.isolated.test.ts && git commit -m "feat: scanKeyword — live iTunes fetch to gap profile"`

---

## Phase 3 — Scheduled scan

### Task 7: Scan sweep (genre slice, budget, throttle) wired into the appstore scraper

**Files:**
- Modify: `src/sources/appstore/keyword-gaps.ts` (add `runScanSlice`)
- Modify: `src/sources/appstore/scraper.ts` (invoke the sweep on the scraper's existing scheduled loop, reusing its throttle/backoff — mirror the `indexUnindexedRankings()` loop already there)
- Test: `src/sources/appstore/keyword-gaps.isolated.test.ts` (append `runScanSlice` case)

**Interfaces:**
- Consumes: `getStaleKeywords`, `scanKeyword`, `insertScan`, `markScanned`.
- Produces: `runScanSlice(opts: { genreZone: string; budget: number; delayMs: number }): Promise<{ scanned: number; failed: number }>`

- [ ] **Step 1: Add failing isolated test** — stub `getStaleKeywords` → `["a","b"]`, `scanKeyword` → profile (throw on `"b"`), spy `insertScan`/`markScanned`; assert `runScanSlice` returns `{ scanned: 1, failed: 1 }`, `insertScan` called once, and it never throws.
- [ ] **Step 2: Run → FAIL.** `bun run test:isolated keyword-gaps`
- [ ] **Step 3: Implement `runScanSlice`** — load stale slice; for each keyword: `try { insertScan(await scanKeyword(k)); scanned++ } catch { failed++ }` with `await sleep(delayMs)` between; `markScanned(succeeded, now)` at end. Never throw (log + continue), matching the graceful pattern in `scraper.ts`.
- [ ] **Step 4: Wire into `scraper.ts`** — pick the day's `genreZone` from a rotation (`GENRE_ZONES[dayIndex % GENRE_ZONES.length]`, `dayIndex` from epoch/86400) and call `runScanSlice` from the scraper's scheduled tick, gated by `config.appstoreKeywordGap.enabled`. Use `createLogger("appstore:keyword-gaps")`.
- [ ] **Step 5: Run isolated + typecheck → PASS.** `bun run test:isolated keyword-gaps && bun run typecheck`
- [ ] **Step 6: Commit** — `git commit -am "feat: daily genre-sliced keyword-gap scan in appstore scraper"`

---

## Phase 4 — Funnel integration

### Task 8: Add the `appstore_gap` demand-evidence kind

**Files:**
- Modify: `src/pipelines/ideas/demand.ts` (`DEMAND_EVIDENCE_KINDS`, `DEMAND_KIND_WEIGHTS`)
- Test: `src/pipelines/ideas/demand.test.ts` (append)

**Interfaces:**
- Produces: `"appstore_gap"` ∈ `DemandEvidenceKind`; a weight in `DEMAND_KIND_WEIGHTS`.

- [ ] **Step 1: Add failing test** — assert `DEMAND_EVIDENCE_KINDS.includes("appstore_gap")` and `DEMAND_KIND_WEIGHTS.appstore_gap > 0`.
- [ ] **Step 2: Run → FAIL.** `bun run test:unit demand.test`
- [ ] **Step 3: Implement** — append `"appstore_gap"` to the `as const` array (with a doc comment: a measured supply/demand gap from `appstore_keyword_scans` — the low-supply/high-demand IS the whitespace), and add a weight to `DEMAND_KIND_WEIGHTS` (start equal to `search_trend`; note it feeds whitespace strongly but is capped by `SCORE_SATURATION`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: appstore_gap demand-evidence kind"`

---

### Task 9: `appstoreGapProbe` over `appstore_keyword_scans`

**Files:**
- Create: `src/pipelines/ideas/appstore-gap-probe.ts`
- Modify: `src/pipelines/ideas/demand-probes.ts` (register in `DEFAULT_DEMAND_PROBES`)
- Test: `src/pipelines/ideas/appstore-gap-probe.integration.test.ts`

**Interfaces:**
- Consumes: candidate demand keywords (`readonly string[]`), `DemandProbeOptions`, `appstore_keyword_scans`.
- Produces: `appstoreGapProbe: DemandProbe` emitting `DemandEvidence` `{ kind: "appstore_gap", query, count, quote, sourceId }`.

- [ ] **Step 1: Write the failing integration test** — seed one `appstore_keyword_scans` row (`keyword: "fatty liver diet"`, high `opportunity`, `top_apps`); call `appstoreGapProbe.probe(["fatty liver diet"], defaultOpts)`; assert one evidence, `kind === "appstore_gap"`, `count > 0` (real, derived from demand velocity), `sourceId` set to the scan id, `quote` naming the weak incumbent.
- [ ] **Step 2: Run → FAIL.** `bun run test:integration appstore-gap-probe`
- [ ] **Step 3: Implement** — follow `reviewComplaintProbe` in `demand-probes.ts`: `getDb()`, match the latest scan per candidate keyword (`DISTINCT ON (keyword) ... ORDER BY scanned_at DESC`), only emit when `opportunity >= config threshold`; `count = Math.max(1, Math.round(demand))`; `quote` = top weak app name + rating from `top_apps`; wrap in try/catch → `[]`. Register in `DEFAULT_DEMAND_PROBES`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add ... && git commit -m "feat: appstore keyword-gap demand probe → whitespace"`

---

### Task 10: Seed collector — `collector-keyword-gaps.ts`

**Files:**
- Create: `src/pipelines/ideas/collector-keyword-gaps.ts`
- Modify: `src/pipelines/ideas/pipeline.ts` (invoke in the trends/pain collection phase; feed seeds into synthesis alongside `analyzeAppLandscape`)
- Test: `src/pipelines/ideas/collector-keyword-gaps.test.ts` (unit — pure selection) + `.integration.test.ts` (reads scans)

**Interfaces:**
- Consumes: `getTopOpportunities`, `getConsumedIds`/`markConsumed` (`consumption.ts`), `CollectorContext`.
- Produces: `collectKeywordGaps(ctx: CollectorContext, opts: { limit: number; minOpportunity: number }): Promise<readonly GapSeed[]>` where `GapSeed = { keyword: string; opportunity: number; store: "appstore"; signalType: "keyword_gap"; sourceId: string }`.

- [ ] **Step 1: Write the failing unit test** — a pure `selectGapSeeds(scans, consumedIds, { limit, minOpportunity })` filters below-threshold + already-consumed, sorts by `opportunity` desc, caps at `limit`. Assert ordering, threshold filter, and dedup.
- [ ] **Step 2: Run → FAIL.** `bun run test:unit collector-keyword-gaps`
- [ ] **Step 3: Implement** — pure `selectGapSeeds` + a thin `collectKeywordGaps` that loads `getTopOpportunities`, applies `selectGapSeeds` against `getConsumedIds`, maps to `GapSeed`. Then wire into `pipeline.ts` so seeds join the synthesis candidate pool tagged `store:"appstore"`, `signalType:"keyword_gap"` — honoring the existing per-source and (source×signalType) share ceilings (see `config-signals`).
- [ ] **Step 4: Run unit + integration → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: keyword-gap seed collector into idea synthesis"`

---

## Phase 5 — Surfaces

### Task 11: Config — `appstoreKeywordGap` block

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/config/schema.test.ts` (or the nearest existing config test) — assert defaults parse.

**Interfaces:**
- Produces: `config.appstoreKeywordGap`: `{ enabled: boolean; scanIntervalMs: number; dailyKeywordBudget: number; topN: number; demandWeight: number; opportunityThresholdForSeed: number; autocompleteExpansion: { enabled: boolean } }` — all Zod-defaulted.

- [ ] **Step 1: Add failing test** — `configSchema.parse({})` yields `appstoreKeywordGap.enabled === false` (safe default off) and `topN === 20`.
- [ ] **Step 2: Run → FAIL.** `bun run test:unit schema`
- [ ] **Step 3: Implement** — add a `z.object({...}).default({...})` under the demand-side grounding block (near line ~824), mirroring the existing `reviewComplaint` probe config shape.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: config for appstore keyword-gap scanner"`

---

### Task 12: Web route — opportunities endpoints

**Files:**
- Modify: `src/web/routes/appstore.ts`
- Test: `src/web/routes/appstore.integration.test.ts` (or nearest existing route test)

**Interfaces:**
- Produces:
  - `GET /appstore/opportunities?limit&genreZone&trend` → `KeywordScanRow[]` (latest per keyword, opportunity desc)
  - `GET /appstore/opportunities/:keyword` → scan history

- [ ] **Step 1: Write failing integration test** — seed a scan; `GET /appstore/opportunities?limit=5`; assert 200 and the keyword present, sorted by opportunity.
- [ ] **Step 2: Run → FAIL.** `bun run test:integration appstore`
- [ ] **Step 3: Implement** — add two Hono handlers following the existing route pattern in `appstore.ts`; Zod-parse query params; delegate to `getTopOpportunities` / `getScanHistory`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: /appstore/opportunities endpoints"`

---

### Task 13: Dashboard — "Opportunities" tab

**Files:**
- Modify: `src/web/ui/views/AppStore.tsx`
- Create: `src/web/ui/views/appstore/OpportunitiesTab.tsx`
- Test: co-located `*.test.ts` for any pure formatting helper (e.g. trend badge, opportunity→percent).

**Interfaces:**
- Consumes: `GET /appstore/opportunities`.
- Produces: a tab rendering a sortable table (keyword, opportunity, competitiveness, demand, incumbent-weakness, trend), a watchlist star (localStorage), and a per-row sparkline from `/opportunities/:keyword`.

- [ ] **Step 1: Write failing unit test** — for a pure helper `formatOpportunity(0.53) === "53%"` and `trendBadge("heating")` shape.
- [ ] **Step 2: Run → FAIL.** `bun run test:unit OpportunitiesTab`
- [ ] **Step 3: Implement** the helper + the `OpportunitiesTab` component (React 19, existing view conventions), and register the tab in `AppStore.tsx`.
- [ ] **Step 4: Run tests + styles** — `bun run test:unit OpportunitiesTab && bun run tw:build`
- [ ] **Step 5: Commit** — `git commit -am "feat: AppStore Opportunities dashboard tab"`

---

### Task 14: Agent tool — `analyze_keyword_gap`

**Files:**
- Modify: `src/tools/appstore.ts` (add to `createAppStoreTools`)
- Test: `src/tools/appstore.test.ts` (or `.isolated` if it must `mock.module` the fetch)

**Interfaces:**
- Consumes: `scanKeyword` (Task 6).
- Produces: an agent tool `analyze_keyword_gap` with Zod input `{ keyword: string }`, `categories: ["research"]`, returning a formatted profile string.

- [ ] **Step 1: Write failing test** — mock `scanKeyword`; invoke the tool; assert output includes the keyword, competitiveness, and opportunity.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — mirror the existing `search_appstore_apps` tool definition shape in `appstore.ts`; call `scanKeyword`; format via a small pure `formatGapProfile(p)` (unit-testable).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: analyze_keyword_gap agent tool"`

---

## Phase 6 — Corpus growth + hardening

### Task 15: Autocomplete corpus expansion

**Files:**
- Create: `src/sources/appstore/keyword-autocomplete.ts`
- Modify: `src/sources/appstore/scraper.ts` (periodic expansion of winners, gated by `config.appstoreKeywordGap.autocompleteExpansion.enabled`)
- Test: `src/sources/appstore/keyword-autocomplete.isolated.test.ts`

**Interfaces:**
- Produces: `expandFromWinners(opts: { minOpportunity: number; perSeed: number }): Promise<number>` — for each recent high-opportunity keyword, fetch Apple search hints (`https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?q=<term>`), normalize, `upsertKeywords(source:"autocomplete")`.

- [ ] **Step 1: Failing isolated test** — mock hints fetch + `getTopOpportunities`; assert new terms upserted with `source:"autocomplete"`, bounded to `perSeed`.
- [ ] **Step 2: Run → FAIL.** `bun run test:isolated keyword-autocomplete`
- [ ] **Step 3: Implement** via `ssrfSafeFetch`; bounded fan-out; dedupe against existing corpus.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: autocomplete-driven keyword corpus expansion"`

---

### Task 16: Seed the corpus + final verification + reviews

**Files:**
- Create: `scripts/seed-appstore-keywords.ts` (one-shot: `upsertKeywords(buildSeedCorpus())`)
- No new product code.

- [ ] **Step 1:** Write `scripts/seed-appstore-keywords.ts` calling `buildSeedCorpus()` → `upsertKeywords`. Run once against the dev DB; confirm row count > 0.
- [ ] **Step 2: Full verification** — Run and read output of: `bun run typecheck`, `bun run lint`, `bun run test:unit`, then (with `docker compose up -d postgres`) `bun run test:integration` and `bun run test:isolated`. Paste any failure; fix before proceeding. Only claim green when seen.
- [ ] **Step 3: Dispatch `security-reviewer`** on the full diff (SSRF on the new fetch surfaces, SQL safety on the new `Bun.sql`/`db.unsafe` usage, config/secret hygiene, prompt-injection via scraped app names flowing into synthesis). Fix CRITICAL/HIGH.
- [ ] **Step 4: Dispatch `qa-test-engineer`** to confirm ≥80% coverage on new business logic and lane-suffix correctness.
- [ ] **Step 5: Commit** — `git commit -am "chore: seed script + verification for keyword-gap scanner"`

---

## Integration

When all tasks are green and reviewed: push the branch and open a PR to `origin/master` (prefer the `ship` agent, which owns git→CI→merge→deploy and removes the worktree). **Never** merge into or reset the local `master` checkout (RULE 3).

## Ownership map (RULE 2 — dispatch per task area)

| Tasks | Owning agent |
|---|---|
| 1, 2, 8, 9, 10, 11, 12 (store/migrations/pipeline/config/routes) | `senior-backend-engineer` |
| 3, 6, 7, 15 (scraper/corpus/fetch/scan) | `scraper-integrations-engineer` |
| 4, 5 (scoring core) | `scraper-integrations-engineer` or `senior-backend-engineer` |
| 13 (dashboard) | `senior-frontend-engineer` |
| 14 (agent tool) | `senior-ai-engineer` |
| 16 QA/coverage | `qa-test-engineer` |
| 16 security | `security-reviewer` |
