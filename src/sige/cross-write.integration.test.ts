/**
 * Integration test for the SIGE → generated_ideas cross-write competability
 * wiring (PR #208 follow-up #1 + #2). Requires Postgres
 * (`docker compose up -d postgres` first).
 *
 * The LLM-gated competability SCORING is covered hermetically in the isolated
 * lane (competability-scoring.isolated.test.ts, chat mocked). Here we exercise
 * the real DB write path end to end with competability DISABLED — proving that
 * SIGE ideas still cross-write through dedup→insert and that the competability
 * columns persist as NULL when the gate did not run. No LLM call is made.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import { crossWriteSigeIdeas } from "./cross-write";
import { getIdeaById } from "../sources/ideas/store";
import type { ScoredIdea, StrategicMetadata } from "./types";

const META: StrategicMetadata = {
  paretoOptimal: true,
  dominantStrategy: false,
  evolutionarilyStable: false,
  nashEquilibrium: true,
};

function makeIdea(partial: Partial<ScoredIdea>): ScoredIdea {
  return {
    id: crypto.randomUUID(),
    title: `Cross-write itest ${crypto.randomUUID().slice(0, 8)}`,
    description: "A solo-buildable niche tool with no incumbent moat.",
    proposedBy: "founder",
    round: 1,
    expertScore: 0.7,
    fusedScore: 0.8,
    incentiveBreakdown: {
      diversityBonus: 0,
      buildingBonus: 0,
      surpriseBonus: 0,
      accuracyPenalty: 0,
      memoryReward: 0,
      coalitionStability: 0,
      signalCredibility: 0,
      socialViability: 0,
    },
    strategicMetadata: META,
    ...partial,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM generated_ideas WHERE agent_id = 'sige' AND sources_used = 'sige' AND title LIKE 'Cross-write itest %'`;
}

describe("crossWriteSigeIdeas (competability disabled)", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("persists a SIGE idea with NULL competability columns when the gate is off", async () => {
    const idea = makeIdea({});
    // memoryManager null → semantic dedup layer disabled; competability omitted
    // → no LLM call, gate does not run.
    const result = await crossWriteSigeIdeas([idea], "itest-session", null, 5);

    expect(result.inserted).toBe(1);
    expect(result.insertedIdeas).toHaveLength(1);

    const db = getDb();
    const rows = (await db`
      SELECT id, competability_overall, competability_json
      FROM generated_ideas
      WHERE sige_session_id = ${"itest-session"} AND title = ${idea.title}
    `) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);

    const read = await getIdeaById(rows[0]!.id);
    expect(read).not.toBeNull();
    expect(read!.competability_overall).toBeNull();
    expect(read!.competability_json).toBeNull();
  });
});
