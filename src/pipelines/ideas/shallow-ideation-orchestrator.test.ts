/**
 * Unit tests for the Stage 2 ORCHESTRATOR `runShallowIdeation`, driven through
 * injected `deps` (a plain cheap-model callback + a saturation lookup) — NO
 * `mock.module`, so this stays in the fast unit lane. The default deps factory
 * that threads model-routing into `chat` is covered separately in the isolated
 * lane.
 */

import { describe, expect, it } from "bun:test";
import {
  type ShallowIdeationDeps,
  type ThemeCandidate,
  runShallowIdeation,
} from "./shallow-ideation";

const candidate = (id: string, over: Partial<ThemeCandidate> = {}): ThemeCandidate => ({
  id,
  title: `theme ${id}`,
  signalCategory: "productivity",
  kind: "capability",
  source: "producthunt",
  signalStrength: 0.5,
  context: `context for ${id}`,
  ...over,
});

/** A deps double whose model call echoes one valid sketch per requested candidate. */
function echoingDeps(over: Partial<ShallowIdeationDeps> = {}): {
  deps: ShallowIdeationDeps;
  calls: { count: number; batchSizes: number[] };
} {
  const calls = { count: 0, batchSizes: [] as number[] };
  const deps: ShallowIdeationDeps = {
    batchSize: 5,
    callModel: async (batch) => {
      calls.count += 1;
      calls.batchSizes.push(batch.length);
      return JSON.stringify(
        batch.map((c) => ({
          candidateId: c.id,
          line: `a distinctive one-line sketch for ${c.title}`,
          marketGap: 0.5,
        })),
      );
    },
    lookupSaturation: async () => "",
    ...over,
  };
  return { deps, calls };
}

describe("runShallowIdeation", () => {
  it("returns one scored sketch per candidate, sorted by score desc", async () => {
    const { deps } = echoingDeps();
    const candidates = [
      candidate("a", { signalStrength: 0.2 }),
      candidate("b", { signalStrength: 0.9 }),
      candidate("c", { signalStrength: 0.5 }),
    ];
    const scored = await runShallowIdeation(candidates, deps);
    expect(scored).toHaveLength(3);
    expect(scored.map((s) => s.candidate.id)).toEqual(["b", "c", "a"]);
    expect(scored[0]?.score).toBeGreaterThanOrEqual(scored[2]?.score ?? 0);
  });

  it("batches candidates into ceil(n / batchSize) model calls", async () => {
    const { deps, calls } = echoingDeps({ batchSize: 2 });
    const candidates = ["a", "b", "c", "d", "e"].map((id) => candidate(id));
    await runShallowIdeation(candidates, deps);
    expect(calls.count).toBe(3);
    expect(calls.batchSizes).toEqual([2, 2, 1]);
  });

  it("threads the saturation lookup into the novelty term", async () => {
    const { deps } = echoingDeps({
      // Saturate everything: the sketch line repeats the candidate title.
      lookupSaturation: async () => '- "theme a" theme (5 ideas)',
      callModel: async (batch) =>
        JSON.stringify(
          batch.map((c) => ({ candidateId: c.id, line: `theme ${c.id} sketch`, marketGap: 0.5 })),
        ),
    });
    const scored = await runShallowIdeation([candidate("a")], deps);
    // "theme a sketch" overlaps the saturated phrase "theme a" → novelty < 1.
    expect(scored[0]?.components.novelty).toBeLessThan(1);
  });

  it("survives a model batch that returns junk (no sketches for that batch)", async () => {
    const { deps } = echoingDeps({
      batchSize: 1,
      callModel: async (batch) =>
        batch[0]?.id === "b" ? "totally not json" : JSON.stringify(
          batch.map((c) => ({ candidateId: c.id, line: `sketch for ${c.id}`, marketGap: 0.5 })),
        ),
    });
    const scored = await runShallowIdeation([candidate("a"), candidate("b"), candidate("c")], deps);
    // "b" yields no sketch; "a" and "c" survive.
    expect(scored.map((s) => s.candidate.id).sort()).toEqual(["a", "c"]);
  });

  it("returns [] for an empty candidate set without calling the model", async () => {
    const { deps, calls } = echoingDeps();
    expect(await runShallowIdeation([], deps)).toEqual([]);
    expect(calls.count).toBe(0);
  });

  it("never throws when the model call itself rejects (degrades to fewer sketches)", async () => {
    const { deps } = echoingDeps({
      batchSize: 1,
      callModel: async (batch) => {
        if (batch[0]?.id === "b") throw new Error("provider down");
        return JSON.stringify(
          batch.map((c) => ({ candidateId: c.id, line: `sketch for ${c.id}`, marketGap: 0.5 })),
        );
      },
    });
    const scored = await runShallowIdeation([candidate("a"), candidate("b")], deps);
    expect(scored.map((s) => s.candidate.id)).toEqual(["a"]);
  });
});
