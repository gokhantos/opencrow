/**
 * Unit tests for the PURE graph-outcome-feedback core (no DB, no clock).
 *
 * Covers the critical correctness + security contract: ONLY gold/reprobe verdicts
 * feed the weights (a proxy-only run produces NO events), the aggregate verdict
 * maps to per-seed credit/debit, clamping to ±maxSeedWeight, an empty seed set,
 * temporal decay halving at the half-life, and the UPPERCASE rel-type constants.
 */

import { test, expect, describe } from "bun:test";
import {
  buildSeedOutcomeEvents,
  decaySeedWeight,
  OPPORTUNITY_VALIDATED_REL,
  OPPORTUNITY_KILLED_REL,
  type GraphOutcomeEvent,
  type IdeaVerdict,
} from "./graph-outcome-feedback";

const CONFIG = { validatedWeight: 1, killedWeight: -1, maxSeedWeight: 5 } as const;
const NOW = 1_700_000_000;

function verdict(v: "validated" | "killed", source: string): IdeaVerdict {
  return { verdict: v, verdictSource: source };
}

describe("buildSeedOutcomeEvents — trust filtering (the key fix)", () => {
  test("a proxy-ONLY run produces NO events", () => {
    const map = new Map<string, IdeaVerdict>([
      ["i1", verdict("validated", "proxy:high-giant")],
      ["i2", verdict("validated", "proxy:high-giant")],
    ]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a", "seed b"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events).toEqual([]);
  });

  test("a none/legacy-source run produces NO events", () => {
    const map = new Map<string, IdeaVerdict>([
      ["i1", verdict("validated", "none")],
      ["i2", verdict("killed", "dedup")],
    ]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events).toEqual([]);
  });

  test("gold + reprobe verdicts DO feed the weights", () => {
    const map = new Map<string, IdeaVerdict>([
      ["i1", verdict("validated", "human:dashboard")],
      ["i2", verdict("validated", "reprobe:grew")],
    ]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.verdict).toBe("validated");
  });
});

describe("buildSeedOutcomeEvents — credit assignment", () => {
  test("a validated run CREDITS each of its seeds (+)", () => {
    const map = new Map<string, IdeaVerdict>([["i1", verdict("validated", "human")]]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a", "seed b"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.verdict === "validated" && e.weight === 1)).toBe(true);
    expect(events.map((e) => e.seedName).sort()).toEqual(["seed a", "seed b"]);
  });

  test("a killed run DEBITS each of its seeds (−)", () => {
    const map = new Map<string, IdeaVerdict>([["i1", verdict("killed", "human")]]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.verdict).toBe("killed");
    expect(events[0]!.weight).toBe(-1);
  });

  test("a mixed run NETS the trusted verdicts (2 validated, 1 killed → net +)", () => {
    const map = new Map<string, IdeaVerdict>([
      ["i1", verdict("validated", "human")],
      ["i2", verdict("validated", "reprobe:grew")],
      ["i3", verdict("killed", "human")],
    ]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    // net = +1 +1 -1 = +1 → validated
    expect(events.length).toBe(1);
    expect(events[0]!.verdict).toBe("validated");
    expect(events[0]!.weight).toBe(1);
  });

  test("a net-zero trusted run produces NO events", () => {
    const map = new Map<string, IdeaVerdict>([
      ["i1", verdict("validated", "human")],
      ["i2", verdict("killed", "human")],
    ]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a"],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events).toEqual([]);
  });

  test("clamps the net weight to ±maxSeedWeight", () => {
    const map = new Map<string, IdeaVerdict>();
    for (let i = 0; i < 10; i += 1) map.set(`i${i}`, verdict("validated", "human"));
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a"],
      config: CONFIG, // maxSeedWeight 5
      createdAtSec: NOW,
    });
    // net = +10 → clamped to +5
    expect(events[0]!.weight).toBe(5);
  });

  test("an empty seed set → []", () => {
    const map = new Map<string, IdeaVerdict>([["i1", verdict("validated", "human")]]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: [],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events).toEqual([]);
  });

  test("dedupes repeated seed names", () => {
    const map = new Map<string, IdeaVerdict>([["i1", verdict("validated", "human")]]);
    const events = buildSeedOutcomeEvents({
      runId: "r1",
      verdictMap: map,
      runSeeds: ["seed a", "seed a", " seed a "],
      config: CONFIG,
      createdAtSec: NOW,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.seedName).toBe("seed a");
  });
});

describe("decaySeedWeight", () => {
  test("halves a weight at exactly one half-life", () => {
    const halfLifeDays = 60;
    const oneHalfLifeAgo = NOW - halfLifeDays * 86_400;
    const events: GraphOutcomeEvent[] = [
      { runId: "r1", seedName: "s", verdict: "validated", weight: 4, createdAtSec: oneHalfLifeAgo },
    ];
    const decayed = decaySeedWeight(events, NOW, halfLifeDays);
    expect(decayed).toBeCloseTo(2, 6);
  });

  test("a fresh event is undecayed; sums across events", () => {
    const events: GraphOutcomeEvent[] = [
      { runId: "r1", seedName: "s", verdict: "validated", weight: 3, createdAtSec: NOW },
      { runId: "r2", seedName: "s", verdict: "killed", weight: -1, createdAtSec: NOW },
    ];
    expect(decaySeedWeight(events, NOW, 60)).toBeCloseTo(2, 6);
  });
});

describe("rel-type constants are UPPERCASE canonical", () => {
  test("match the graph vocabulary exactly", () => {
    expect(OPPORTUNITY_VALIDATED_REL).toBe("OPPORTUNITY_VALIDATED");
    expect(OPPORTUNITY_KILLED_REL).toBe("OPPORTUNITY_KILLED");
  });
});
