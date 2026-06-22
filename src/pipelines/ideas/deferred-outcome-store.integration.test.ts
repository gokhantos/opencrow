/**
 * Integration test for the deferred-outcome-probes store (migration 032).
 *
 * Requires Postgres (`docker compose up -d postgres` first). initDb runs all
 * migrations idempotently, so migration 032 is applied before these assertions.
 *
 * Covers:
 *   - migration 032 is idempotent (re-running initDb does not error).
 *   - enqueue is idempotent via the partial UNIQUE (one OPEN row per idea_id).
 *   - claimDueReprobes respects the due window AND never double-claims a row.
 *   - recordReprobeOutcome writes label / delta / snapshot and closes the row,
 *     which frees the partial-unique slot for a fresh enqueue.
 *
 * Uses UNIQUE idea_ids per run so we touch only our own rows (the integration DB
 * may be a shared opencrow-postgres-1; we never truncate shared tables).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import type { DemandArtifact } from "./demand";
import {
  claimDueReprobes,
  enqueueValidatedIdea,
  recordReprobeOutcome,
} from "./deferred-outcome-store";

const NS = `reprobe-itest-${crypto.randomUUID()}`;
const ideaId = (suffix: string): string => `${NS}-${suffix}`;

const T = 1_700_000_000; // base epoch seconds

function demand(score: number, confidence = 0.8): DemandArtifact {
  return { score, confidence, whitespace: 0.5, evidence: [] };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM deferred_outcome_probes WHERE idea_id LIKE ${`${NS}-%`}`;
}

beforeEach(async () => {
  await initDb();
  await cleanup();
});

afterEach(async () => {
  await cleanup();
  await closeDb();
});

describe("deferred-outcome-store (migration 032)", () => {
  it("migration is idempotent — re-running initDb does not error", async () => {
    await initDb(); // a second run must apply cleanly
    const db = getDb();
    const [row] = await db`SELECT to_regclass('public.deferred_outcome_probes') AS t`;
    expect(row?.t).toBe("deferred_outcome_probes");
  });

  it("enqueue inserts a row and is idempotent for an OPEN idea", async () => {
    const id = ideaId("enqueue");
    const first = await enqueueValidatedIdea({
      ideaId: id,
      title: "First enqueue",
      validationSource: "proxy:high-giant",
      validatedAt: T,
      baselineDemand: demand(3),
      dueAt: T - 10, // already due
    });
    expect(first).toBe(true);

    // Second enqueue while the first is still OPEN → no-op (partial unique).
    const second = await enqueueValidatedIdea({
      ideaId: id,
      title: "Duplicate enqueue",
      validationSource: "proxy:high-giant",
      validatedAt: T,
      baselineDemand: demand(3),
      dueAt: T - 10,
    });
    expect(second).toBe(false);

    const db = getDb();
    const rows = await db`SELECT id FROM deferred_outcome_probes WHERE idea_id = ${id}`;
    expect(rows.length).toBe(1);
  });

  it("claimDueReprobes respects the due window", async () => {
    const dueId = ideaId("due");
    const futureId = ideaId("future");
    await enqueueValidatedIdea({
      ideaId: dueId,
      title: "Due now",
      validationSource: "proxy:a",
      validatedAt: T,
      baselineDemand: demand(3),
      dueAt: T - 100,
    });
    await enqueueValidatedIdea({
      ideaId: futureId,
      title: "Not due",
      validationSource: "proxy:b",
      validatedAt: T,
      baselineDemand: demand(3),
      dueAt: T + 1_000_000,
    });

    const claimed = await claimDueReprobes(10, T);
    const claimedForNs = claimed.filter((c) => c.ideaId.startsWith(NS));
    expect(claimedForNs.map((c) => c.ideaId)).toContain(dueId);
    expect(claimedForNs.map((c) => c.ideaId)).not.toContain(futureId);
    // Baseline demand round-trips as a real object (JSONB), not a string.
    const dueRow = claimedForNs.find((c) => c.ideaId === dueId);
    expect(dueRow?.baselineDemand?.score).toBe(3);
  });

  it("does NOT double-claim a row already claimed", async () => {
    const id = ideaId("once");
    await enqueueValidatedIdea({
      ideaId: id,
      title: "Claim once",
      validationSource: "proxy:a",
      validatedAt: T,
      baselineDemand: demand(2),
      dueAt: T - 5,
    });

    const first = await claimDueReprobes(10, T);
    expect(first.filter((c) => c.ideaId === id).length).toBe(1);

    // Already claimed (claimed_at set) → a second claim must NOT return it again.
    const second = await claimDueReprobes(10, T);
    expect(second.filter((c) => c.ideaId === id).length).toBe(0);
  });

  it("recordReprobeOutcome writes label/delta and closes + frees the open slot", async () => {
    const id = ideaId("record");
    await enqueueValidatedIdea({
      ideaId: id,
      title: "Record me",
      validationSource: "proxy:a",
      validatedAt: T,
      baselineDemand: demand(2),
      dueAt: T - 5,
    });
    // claimDueReprobes is global; resolve OUR row id directly by idea_id.
    const mine = await getMineById(id);
    expect(mine).toBeDefined();

    const ok = await recordReprobeOutcome({
      id: mine!.id,
      label: "grew",
      reprobeDemand: demand(4),
      scoreDelta: 2,
      recordedAt: T + 1,
    });
    expect(ok).toBe(true);

    const db = getDb();
    const [row] = await db`
      SELECT reprobe_label, reprobe_score_delta, reprobe_demand_json, outcome_recorded_at
      FROM deferred_outcome_probes WHERE id = ${mine!.id}
    `;
    expect(row?.reprobe_label).toBe("grew");
    expect(Number(row?.reprobe_score_delta)).toBe(2);
    expect((row?.reprobe_demand_json as DemandArtifact).score).toBe(4);
    expect(Number(row?.outcome_recorded_at)).toBe(T + 1);

    // The slot is freed → a fresh enqueue for the same idea now succeeds.
    const reEnqueue = await enqueueValidatedIdea({
      ideaId: id,
      title: "Second cycle",
      validationSource: "human",
      validatedAt: T + 2,
      baselineDemand: null,
      dueAt: T + 3,
    });
    expect(reEnqueue).toBe(true);
  });
});

/** Look up our claimed row id directly (claimDueReprobes is global). */
async function getMineById(id: string): Promise<{ id: number } | undefined> {
  const db = getDb();
  const [row] = await db`SELECT id FROM deferred_outcome_probes WHERE idea_id = ${id}`;
  return row ? { id: Number(row.id) } : undefined;
}
