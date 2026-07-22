import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import {
  appendKeywordOutcomeEvents,
  loadRunKeywordSeeds,
  recomputeKeywordOutcomeCounts,
  recordKeywordSeedExposure,
} from "./keyword-outcome-feedback";
import { buildSeedOutcomeEvents } from "./graph-outcome-feedback";
import {
  getPipelineKilledWeights,
  upsertKeywordVerdict,
} from "../../sources/appstore/keyword-verdict-store";

const TEST_RUN_IDS: readonly string[] = [
  "zzz-koa-run-exposure",
  "zzz-koa-run-materialize",
  "zzz-koa-run-preserve-verdict",
  "zzz-koa-run-decay",
];

const TEST_KEYWORDS: readonly string[] = [
  "zzz-koa-kw-a",
  "zzz-koa-kw-b",
  "zzz-koa-kw-killed",
  "zzz-koa-kw-preexisting",
  "zzz-koa-kw-decay-old",
  "zzz-koa-kw-decay-new",
];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_outcome_events WHERE run_id IN ${db(TEST_RUN_IDS)}`;
  await db`DELETE FROM appstore_keyword_seed_exposure WHERE run_id IN ${db(TEST_RUN_IDS)}`;
  await db`DELETE FROM appstore_keyword_verdicts WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

describe("keyword-outcome-feedback (integration)", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("recordKeywordSeedExposure / loadRunKeywordSeeds", () => {
    it("round-trips the exposed keywords for a run", async () => {
      await recordKeywordSeedExposure("zzz-koa-run-exposure", [
        "zzz-koa-kw-a",
        "zzz-koa-kw-b",
      ]);
      const seeds = await loadRunKeywordSeeds("zzz-koa-run-exposure");
      expect([...seeds].sort()).toEqual(["zzz-koa-kw-a", "zzz-koa-kw-b"]);
    });

    it("is idempotent — recording the same (run, keyword) twice does not duplicate", async () => {
      await recordKeywordSeedExposure("zzz-koa-run-exposure", ["zzz-koa-kw-a"]);
      await recordKeywordSeedExposure("zzz-koa-run-exposure", ["zzz-koa-kw-a"]);
      const seeds = await loadRunKeywordSeeds("zzz-koa-run-exposure");
      expect(seeds.filter((k) => k === "zzz-koa-kw-a")).toHaveLength(1);
    });

    it("returns an empty array for a run with no recorded exposure", async () => {
      const seeds = await loadRunKeywordSeeds("zzz-koa-run-never-exposed");
      expect(seeds).toEqual([]);
    });
  });

  describe("appendKeywordOutcomeEvents / recomputeKeywordOutcomeCounts", () => {
    it("materializes killed_count onto a pipeline-sourced verdict row, readable via getPipelineKilledWeights", async () => {
      const now = Math.floor(Date.now() / 1000);
      // Same builder pipeline-runner.ts uses — a run-aggregate KILLED verdict
      // attributed to one exposed keyword.
      const events = buildSeedOutcomeEvents({
        runId: "zzz-koa-run-materialize",
        verdictMap: new Map([
          ["idea-1", { verdict: "killed", verdictSource: "human" }],
        ]),
        runSeeds: ["zzz-koa-kw-killed"],
        config: { validatedWeight: 1, killedWeight: -1, maxSeedWeight: 5 },
        createdAtSec: now,
      });
      expect(events).toHaveLength(1);

      await appendKeywordOutcomeEvents(events);
      await recomputeKeywordOutcomeCounts({ now, halfLifeDays: 45 });

      const weights = await getPipelineKilledWeights();
      expect(weights.get("zzz-koa-kw-killed")).toBeGreaterThan(0);
    });

    it("appending the same event twice does not double-count (UNIQUE run_id, keyword, verdict)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const events = buildSeedOutcomeEvents({
        runId: "zzz-koa-run-materialize",
        verdictMap: new Map([["idea-1", { verdict: "killed", verdictSource: "human" }]]),
        runSeeds: ["zzz-koa-kw-killed"],
        config: { validatedWeight: 1, killedWeight: -1, maxSeedWeight: 5 },
        createdAtSec: now,
      });

      await appendKeywordOutcomeEvents(events);
      await appendKeywordOutcomeEvents(events); // re-append, should no-op via ON CONFLICT
      await recomputeKeywordOutcomeCounts({ now, halfLifeDays: 45 });

      const weights = await getPipelineKilledWeights();
      const first = weights.get("zzz-koa-kw-killed") ?? 0;

      // A second recompute over the SAME (deduped) event log should be stable.
      await recomputeKeywordOutcomeCounts({ now, halfLifeDays: 45 });
      const weightsAgain = await getPipelineKilledWeights();
      expect(weightsAgain.get("zzz-koa-kw-killed")).toBeCloseTo(first, 6);
    });

    it("never overwrites an EXISTING pipeline verdict/note — only the two count columns", async () => {
      const now = Math.floor(Date.now() / 1000);
      // Simulate F5 leg 2: a screener dismissal already wrote a pipeline row.
      await upsertKeywordVerdict({
        keyword: "zzz-koa-kw-preexisting",
        verdict: "dismissed",
        source: "pipeline",
        note: "screener dismissal",
      });

      const events = buildSeedOutcomeEvents({
        runId: "zzz-koa-run-preserve-verdict",
        verdictMap: new Map([["idea-1", { verdict: "killed", verdictSource: "human" }]]),
        runSeeds: ["zzz-koa-kw-preexisting"],
        config: { validatedWeight: 1, killedWeight: -1, maxSeedWeight: 5 },
        createdAtSec: now,
      });
      await appendKeywordOutcomeEvents(events);
      await recomputeKeywordOutcomeCounts({ now, halfLifeDays: 45 });

      const db = getDb();
      const rows = await db`
        SELECT verdict, note, killed_count FROM appstore_keyword_verdicts
        WHERE keyword = ${"zzz-koa-kw-preexisting"} AND source = 'pipeline'
      `;
      const row = (rows as ReadonlyArray<{ verdict: string; note: string | null; killed_count: number }>)[0];
      expect(row?.verdict).toBe("dismissed");
      expect(row?.note).toBe("screener dismissal");
      expect(Number(row?.killed_count)).toBeGreaterThan(0);
    });

    it("decays an older event's contribution relative to a fresher one", async () => {
      const now = Math.floor(Date.now() / 1000);
      const oldEvents = buildSeedOutcomeEvents({
        runId: "zzz-koa-run-decay",
        verdictMap: new Map([["idea-old", { verdict: "killed", verdictSource: "human" }]]),
        runSeeds: ["zzz-koa-kw-decay-old"],
        config: { validatedWeight: 1, killedWeight: -1, maxSeedWeight: 5 },
        createdAtSec: now - 200 * 86_400, // 200 days old, well past a 45d half-life
      });
      const newEvents = buildSeedOutcomeEvents({
        runId: "zzz-koa-run-decay",
        verdictMap: new Map([["idea-new", { verdict: "killed", verdictSource: "human" }]]),
        runSeeds: ["zzz-koa-kw-decay-new"],
        config: { validatedWeight: 1, killedWeight: -1, maxSeedWeight: 5 },
        createdAtSec: now,
      });

      await appendKeywordOutcomeEvents([...oldEvents, ...newEvents]);
      await recomputeKeywordOutcomeCounts({ now, halfLifeDays: 45 });

      const weights = await getPipelineKilledWeights();
      const oldWeight = weights.get("zzz-koa-kw-decay-old") ?? 0;
      const newWeight = weights.get("zzz-koa-kw-decay-new") ?? 0;
      expect(newWeight).toBeGreaterThan(oldWeight);
    });
  });
});
