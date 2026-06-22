/**
 * Unit tests for deferred-outcome-reprobe.ts — the PURE re-probe classifier.
 *
 *   - grew / flat / decayed boundaries against the configured deltas.
 *   - absence-floor guard on EITHER side → "inconclusive" (no superseding verdict).
 *   - verdict + verdictSource mapping for each non-inconclusive label.
 */

import { describe, test, expect } from "bun:test";
import { ABSENCE_CONFIDENCE_CAP, type DemandArtifact } from "./demand";
import {
  clearsAbsenceFloor,
  reprobeLabelFromDelta,
  type ReprobeDeltaOptions,
} from "./deferred-outcome-reprobe";

const OPTS: ReprobeDeltaOptions = { scoreDeltaGrew: 0.75, scoreDeltaDecayed: -0.75 };

/** A demand artifact that CLEARS the absence floor (confidence above the cap). */
function real(score: number, confidence = 0.8): DemandArtifact {
  return { score, confidence, whitespace: 0.5, evidence: [] };
}

/** A demand artifact AT the absence floor (confidence at the cap). */
function absent(score = 1): DemandArtifact {
  return { score, confidence: ABSENCE_CONFIDENCE_CAP, whitespace: 0, evidence: [] };
}

describe("clearsAbsenceFloor", () => {
  test("confidence strictly above the cap clears", () => {
    expect(clearsAbsenceFloor(real(3, ABSENCE_CONFIDENCE_CAP + 0.01))).toBe(true);
  });
  test("confidence AT the cap does NOT clear", () => {
    expect(clearsAbsenceFloor(absent())).toBe(false);
  });
  test("null / undefined never clear", () => {
    expect(clearsAbsenceFloor(null)).toBe(false);
    expect(clearsAbsenceFloor(undefined)).toBe(false);
  });
});

describe("reprobeLabelFromDelta — label boundaries", () => {
  test("grew at exactly scoreDeltaGrew (inclusive)", () => {
    const c = reprobeLabelFromDelta(real(2.0), real(2.75), OPTS);
    expect(c.label).toBe("grew");
    expect(c.scoreDelta).toBeCloseTo(0.75, 5);
  });

  test("grew above scoreDeltaGrew", () => {
    expect(reprobeLabelFromDelta(real(1.0), real(4.0), OPTS).label).toBe("grew");
  });

  test("just below scoreDeltaGrew is flat", () => {
    expect(reprobeLabelFromDelta(real(2.0), real(2.74), OPTS).label).toBe("flat");
  });

  test("decayed at exactly scoreDeltaDecayed (inclusive)", () => {
    const c = reprobeLabelFromDelta(real(3.0), real(2.25), OPTS);
    expect(c.label).toBe("decayed");
    expect(c.scoreDelta).toBeCloseTo(-0.75, 5);
  });

  test("just above scoreDeltaDecayed is flat", () => {
    expect(reprobeLabelFromDelta(real(3.0), real(2.27), OPTS).label).toBe("flat");
  });

  test("zero delta is flat", () => {
    expect(reprobeLabelFromDelta(real(2.5), real(2.5), OPTS).label).toBe("flat");
  });
});

describe("reprobeLabelFromDelta — absence-floor guard", () => {
  test("baseline at floor → inconclusive (no superseding verdict)", () => {
    const c = reprobeLabelFromDelta(absent(1), real(4.0), OPTS);
    expect(c.label).toBe("inconclusive");
    expect(c.verdict).toBeNull();
    expect(c.verdictSource).toBeNull();
    // scoreDelta is still computed for the audit row.
    expect(c.scoreDelta).toBeCloseTo(3.0, 5);
  });

  test("current at floor → inconclusive", () => {
    const c = reprobeLabelFromDelta(real(4.0), absent(1), OPTS);
    expect(c.label).toBe("inconclusive");
    expect(c.verdict).toBeNull();
  });

  test("both at floor → inconclusive", () => {
    expect(reprobeLabelFromDelta(absent(), absent(), OPTS).label).toBe("inconclusive");
  });

  test("null baseline (human path) → inconclusive", () => {
    const c = reprobeLabelFromDelta(null, real(4.0), OPTS);
    expect(c.label).toBe("inconclusive");
    expect(c.verdict).toBeNull();
  });
});

describe("reprobeLabelFromDelta — verdict + verdictSource mapping", () => {
  test("grew → validated / reprobe:grew", () => {
    const c = reprobeLabelFromDelta(real(1.0), real(3.0), OPTS);
    expect(c.verdict).toBe("validated");
    expect(c.verdictSource).toBe("reprobe:grew");
  });

  test("decayed → archived / reprobe:decayed", () => {
    const c = reprobeLabelFromDelta(real(4.0), real(2.0), OPTS);
    expect(c.verdict).toBe("archived");
    expect(c.verdictSource).toBe("reprobe:decayed");
  });

  test("flat → stored-pending / reprobe:flat", () => {
    const c = reprobeLabelFromDelta(real(2.5), real(2.5), OPTS);
    expect(c.verdict).toBe("stored-pending");
    expect(c.verdictSource).toBe("reprobe:flat");
  });
});
