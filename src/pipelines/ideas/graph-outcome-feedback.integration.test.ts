/**
 * Integration test for the graph-outcome-feedback Postgres bookkeeping
 * (migration 033). Requires Postgres (`docker compose up -d postgres`). initDb
 * runs all migrations idempotently, so 033 is applied before these assertions.
 *
 * Covers:
 *   - migration 033 is idempotent (re-running initDb does not error).
 *   - appendOutcomeEvents is append-only & de-duped on (run_id, seed_name, verdict).
 *   - recomputeSeedWeights matches the pure decay math.
 *   - graph_seed_exposure round-trips via recordSeedExposure → loadRunSeeds.
 *
 * Uses UNIQUE run_id / seed_name per run so we touch only our own rows (the
 * integration DB may be a shared opencrow-postgres-1; we never truncate shared
 * tables).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import {
  appendOutcomeEvents,
  decaySeedWeight,
  loadRunSeeds,
  loadSeedWeightsForProjection,
  recomputeSeedWeights,
  recordSeedExposure,
  type GraphOutcomeEvent,
} from "./graph-outcome-feedback";

const NS = `graphfb-itest-${crypto.randomUUID()}`;
const runId = (suffix: string): string => `${NS}-run-${suffix}`;
const seed = (suffix: string): string => `${NS}-seed-${suffix}`;

const T = 1_700_000_000; // base epoch seconds

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM graph_outcome_events WHERE run_id LIKE ${`${NS}-%`}`;
  await db`DELETE FROM graph_seed_exposure WHERE run_id LIKE ${`${NS}-%`}`;
  await db`DELETE FROM graph_seed_weights WHERE seed_name LIKE ${`${NS}-%`}`;
}

beforeEach(async () => {
  await initDb();
  await cleanup();
});

afterEach(async () => {
  await cleanup();
  await closeDb();
});

describe("graph-outcome-feedback store (migration 033)", () => {
  it("migration is idempotent — re-running initDb does not error", async () => {
    await initDb();
    const db = getDb();
    const [events] = await db`SELECT to_regclass('public.graph_outcome_events') AS t`;
    const [exposure] = await db`SELECT to_regclass('public.graph_seed_exposure') AS t`;
    const [weights] = await db`SELECT to_regclass('public.graph_seed_weights') AS t`;
    expect(events?.t).toBe("graph_outcome_events");
    expect(exposure?.t).toBe("graph_seed_exposure");
    expect(weights?.t).toBe("graph_seed_weights");
  });

  it("graph_seed_exposure round-trips and is idempotent on the PK", async () => {
    const r = runId("exposure");
    await recordSeedExposure(r, [seed("a"), seed("b"), seed("a")]); // dup collapses
    await recordSeedExposure(r, [seed("a")]); // re-record is a no-op (PK)

    const loaded = await loadRunSeeds(r);
    expect([...loaded].sort()).toEqual([seed("a"), seed("b")].sort());
  });

  it("appendOutcomeEvents is append-only & de-duped on (run_id, seed_name, verdict)", async () => {
    const r = runId("append");
    const event: GraphOutcomeEvent = {
      runId: r,
      seedName: seed("x"),
      verdict: "validated",
      weight: 1,
      createdAtSec: T,
    };
    await appendOutcomeEvents([event]);
    // A second identical append is a no-op via the UNIQUE constraint.
    await appendOutcomeEvents([{ ...event, weight: 99 }]);

    const db = getDb();
    const rows = (await db`
      SELECT weight FROM graph_outcome_events WHERE run_id = ${r}
    `) as { weight: number }[];
    expect(rows.length).toBe(1);
    // The ORIGINAL weight survives (DO NOTHING does not overwrite).
    expect(Number(rows[0]!.weight)).toBe(1);
  });

  it("recomputeSeedWeights matches the pure decay math and counts exposure/sample", async () => {
    const halfLifeDays = 60;
    const s = seed("decay");
    const oneHalfLifeAgo = T - halfLifeDays * 86_400;
    const events: GraphOutcomeEvent[] = [
      { runId: runId("d1"), seedName: s, verdict: "validated", weight: 4, createdAtSec: oneHalfLifeAgo },
      { runId: runId("d2"), seedName: s, verdict: "validated", weight: 2, createdAtSec: T },
    ];
    await appendOutcomeEvents(events);

    const materialized = await recomputeSeedWeights({ now: T, halfLifeDays });
    expect(materialized).toBeGreaterThanOrEqual(1);

    const projection = await loadSeedWeightsForProjection();
    const mine = projection.find((p) => p.seedName === s);
    expect(mine).toBeDefined();
    // 4 decayed by one half-life (→2) + 2 fresh (→2) = 4.
    const expected = decaySeedWeight(events, T, halfLifeDays);
    expect(mine!.successWeight).toBeCloseTo(expected, 6);
    expect(mine!.successWeight).toBeCloseTo(4, 6);
    // exposure = 2 distinct runs.
    expect(mine!.exposureCount).toBe(2);
  });
});
