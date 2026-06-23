/**
 * Unit tests for the human-path reprobe-enqueue decision logic.
 *
 * The decision in PATCH /pipeline-ideas/:id/stage is:
 *   enqueue iff:
 *     - reprobe.enabled is true
 *     - the stage maps to "validated" (humanStageToVerdict)
 *     - the stored demand_json clears the absence floor (clearsAbsenceFloor)
 *
 * All three guards are pure functions — testable without a DB or HTTP layer.
 * These tests use them directly, covering the exact conditions the route checks.
 *
 * Lane: *.test.ts (unit, no DB).
 */
import { describe, expect, it } from "bun:test";
import type { DemandArtifact } from "./demand";
import { ABSENCE_CONFIDENCE_CAP } from "./demand";
import { clearsAbsenceFloor } from "./deferred-outcome-reprobe";
import { humanStageToVerdict } from "./outcome-memory";

// ─── Shared test fixtures ─────────────────────────────────────────────────────

/** A demand artifact that clears the absence floor (confidence > 0.2). */
const ABOVE_FLOOR: DemandArtifact = {
  score: 3.0,
  confidence: 0.5,
  whitespace: 0.4,
  evidence: [{ kind: "reddit_intent", query: "task queue", count: 4 }],
};

/** A demand artifact AT the absence floor — does NOT clear it (≤ 0.2). */
const AT_FLOOR: DemandArtifact = {
  score: 1.0,
  confidence: ABSENCE_CONFIDENCE_CAP, // exactly 0.2 — NOT > cap
  whitespace: 0.0,
  evidence: [],
};

/** A demand artifact BELOW the absence floor. */
const BELOW_FLOOR: DemandArtifact = {
  score: 0.5,
  confidence: 0.1,
  whitespace: 0.0,
  evidence: [],
};

// ─── Pure helper used as the decision predicate in the route ─────────────────

/**
 * Mirrors the exact route guard:
 *   if (reprobe.enabled && humanStageToVerdict(stage) === "validated")
 *     const baselineDemand = clearsAbsenceFloor(demand_json) ? demand_json : null
 *     if (baselineDemand !== null) → enqueue
 */
function shouldEnqueueHumanReprobe(
  demand: DemandArtifact | null | undefined,
  reprobeEnabled: boolean,
  stage: string,
): boolean {
  if (!reprobeEnabled) return false;
  if (humanStageToVerdict(stage) !== "validated") return false;
  return clearsAbsenceFloor(demand);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("shouldEnqueueHumanReprobe", () => {
  describe("baseline clears the absence floor → enqueue when reprobe enabled + validated", () => {
    it("enqueues when demand confidence clears the floor and reprobe is enabled", () => {
      expect(shouldEnqueueHumanReprobe(ABOVE_FLOOR, true, "validated")).toBe(true);
    });

    it("does NOT enqueue when reprobe is disabled, even with a good baseline", () => {
      expect(shouldEnqueueHumanReprobe(ABOVE_FLOOR, false, "validated")).toBe(false);
    });

    it("does NOT enqueue for archived stage (not a validated verdict)", () => {
      expect(shouldEnqueueHumanReprobe(ABOVE_FLOOR, true, "archived")).toBe(false);
    });

    it("does NOT enqueue for idea stage (restore, not a terminal verdict)", () => {
      expect(shouldEnqueueHumanReprobe(ABOVE_FLOOR, true, "idea")).toBe(false);
    });
  });

  describe("null / absent demand → does NOT enqueue", () => {
    it("returns false when demand_json is null", () => {
      expect(shouldEnqueueHumanReprobe(null, true, "validated")).toBe(false);
    });

    it("returns false when demand_json is undefined", () => {
      expect(shouldEnqueueHumanReprobe(undefined, true, "validated")).toBe(false);
    });
  });

  describe("demand at or below the absence floor → does NOT enqueue", () => {
    it("returns false when confidence is exactly at the absence floor (0.2 is NOT > 0.2)", () => {
      expect(shouldEnqueueHumanReprobe(AT_FLOOR, true, "validated")).toBe(false);
    });

    it("returns false when confidence is below the absence floor", () => {
      expect(shouldEnqueueHumanReprobe(BELOW_FLOOR, true, "validated")).toBe(false);
    });
  });

  describe("reprobe disabled regardless of demand or stage", () => {
    it("returns false when reprobe disabled even with good baseline and validated stage", () => {
      expect(shouldEnqueueHumanReprobe(ABOVE_FLOOR, false, "validated")).toBe(false);
    });

    it("returns false when reprobe disabled and demand is null", () => {
      expect(shouldEnqueueHumanReprobe(null, false, "validated")).toBe(false);
    });
  });
});

// ─── Direct guard tests for clearsAbsenceFloor ───────────────────────────────

describe("clearsAbsenceFloor", () => {
  it("returns true when confidence is strictly above the cap", () => {
    expect(clearsAbsenceFloor(ABOVE_FLOOR)).toBe(true);
  });

  it("returns false when confidence equals the cap (not strictly above)", () => {
    expect(clearsAbsenceFloor(AT_FLOOR)).toBe(false);
  });

  it("returns false when confidence is below the cap", () => {
    expect(clearsAbsenceFloor(BELOW_FLOOR)).toBe(false);
  });

  it("returns false for null", () => {
    expect(clearsAbsenceFloor(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(clearsAbsenceFloor(undefined)).toBe(false);
  });
});
