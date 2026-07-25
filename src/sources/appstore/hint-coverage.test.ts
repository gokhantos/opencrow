import { describe, expect, it } from "bun:test";
import {
  isProbeStale,
  resolveHintCoverage,
  selectProbeTargets,
  summarizeCoverage,
} from "./hint-coverage";
import type { ProbeCandidate } from "./hint-coverage";

const NOW = 1_800_000_000; // epoch seconds
const DAY = 86_400;

describe("resolveHintCoverage", () => {
  it("reports `present` with the observed rank whenever a hint rank exists", () => {
    const coverage = resolveHintCoverage({ bestRank: 0, probedAt: null, prefixCovered: false });
    expect(coverage.state).toBe("present");
    if (coverage.state !== "present") throw new Error("unreachable");
    expect(coverage.bestRank).toBe(0);
  });

  it("treats rank 0 as present (not falsy-absent)", () => {
    // Guards the classic `if (!bestRank)` bug: rank 0 is the STRONGEST
    // signal Apple gives (top suggestion), not a missing one.
    const coverage = resolveHintCoverage({ bestRank: 0, probedAt: NOW, prefixCovered: true });
    expect(coverage.state).toBe("present");
  });

  it("prefers presence over the probe ledger even when the last probe returned nothing", () => {
    const coverage = resolveHintCoverage({ bestRank: 4, probedAt: NOW, prefixCovered: false });
    expect(coverage.state).toBe("present");
    if (coverage.state !== "present") throw new Error("unreachable");
    expect(coverage.probedAt).toBe(NOW);
  });

  it("reports `probed-absent` with `direct` confidence when the keyword itself was probed", () => {
    const coverage = resolveHintCoverage({
      bestRank: null,
      probedAt: NOW - DAY,
      prefixCovered: false,
    });
    expect(coverage.state).toBe("probed-absent");
    if (coverage.state !== "probed-absent") throw new Error("unreachable");
    expect(coverage.confidence).toBe("direct");
    expect(coverage.probedAt).toBe(NOW - DAY);
  });

  it("reports `probed-absent` with `prefix` confidence when only a prefix query was issued", () => {
    // Weaker evidence: some query that could plausibly have surfaced the
    // keyword ran and did not surface it. Real, but not a direct probe — a
    // retirement rule should require `direct`.
    const coverage = resolveHintCoverage({ bestRank: null, probedAt: null, prefixCovered: true });
    expect(coverage.state).toBe("probed-absent");
    if (coverage.state !== "probed-absent") throw new Error("unreachable");
    expect(coverage.confidence).toBe("prefix");
    expect(coverage.probedAt).toBeNull();
  });

  it("prefers `direct` confidence when both a direct probe and prefix coverage exist", () => {
    const coverage = resolveHintCoverage({ bestRank: null, probedAt: NOW, prefixCovered: true });
    expect(coverage.state).toBe("probed-absent");
    if (coverage.state !== "probed-absent") throw new Error("unreachable");
    expect(coverage.confidence).toBe("direct");
  });

  it("reports `never-probed` when there is no presence, no probe and no prefix coverage", () => {
    // THE distinction the whole ledger exists for: absence of data, not
    // absence of demand. A consumer must never read this as zero volume.
    const coverage = resolveHintCoverage({ bestRank: null, probedAt: null, prefixCovered: false });
    expect(coverage.state).toBe("never-probed");
  });
});

describe("isProbeStale", () => {
  it("treats a never-probed keyword as stale (it is the highest-priority work)", () => {
    expect(isProbeStale(null, 30 * DAY, NOW)).toBe(true);
  });

  it("is false inside the re-probe window", () => {
    expect(isProbeStale(NOW - 5 * DAY, 30 * DAY, NOW)).toBe(false);
  });

  it("is true once the re-probe window has elapsed", () => {
    expect(isProbeStale(NOW - 30 * DAY, 30 * DAY, NOW)).toBe(true);
    expect(isProbeStale(NOW - 31 * DAY, 30 * DAY, NOW)).toBe(true);
  });

  it("treats a future timestamp as fresh rather than as an overflowed staleness", () => {
    expect(isProbeStale(NOW + DAY, 30 * DAY, NOW)).toBe(false);
  });
});

describe("selectProbeTargets", () => {
  const candidates: readonly ProbeCandidate[] = [
    { keyword: "screen time", lastProbedAt: NOW - 2 * DAY },
    { keyword: "peptide tracker", lastProbedAt: null },
    { keyword: "card grading", lastProbedAt: NOW - 90 * DAY },
    { keyword: "block shorts", lastProbedAt: null },
    { keyword: "habit tracker", lastProbedAt: NOW - 40 * DAY },
  ];

  it("puts never-probed keywords first, in input order", () => {
    const targets = selectProbeTargets(candidates, {
      limit: 2,
      reprobeAfterSec: 30 * DAY,
      nowSec: NOW,
    });
    expect(targets).toEqual(["peptide tracker", "block shorts"]);
  });

  it("then takes the stalest probed keywords, oldest first", () => {
    const targets = selectProbeTargets(candidates, {
      limit: 10,
      reprobeAfterSec: 30 * DAY,
      nowSec: NOW,
    });
    expect(targets).toEqual([
      "peptide tracker",
      "block shorts",
      "card grading",
      "habit tracker",
    ]);
  });

  it("drops keywords probed inside the re-probe window", () => {
    const targets = selectProbeTargets(candidates, {
      limit: 10,
      reprobeAfterSec: 30 * DAY,
      nowSec: NOW,
    });
    // Probed 2 days ago, window is 30 days — not due, so no request is spent.
    expect(targets).not.toContain("screen time");
  });

  it("respects the limit", () => {
    const targets = selectProbeTargets(candidates, {
      limit: 3,
      reprobeAfterSec: 30 * DAY,
      nowSec: NOW,
    });
    expect(targets).toHaveLength(3);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(selectProbeTargets(candidates, { limit: 0, reprobeAfterSec: DAY, nowSec: NOW })).toEqual(
      [],
    );
    expect(selectProbeTargets(candidates, { limit: -5, reprobeAfterSec: DAY, nowSec: NOW })).toEqual(
      [],
    );
  });

  it("dedups repeated keywords so one request is never spent twice in a pass", () => {
    const targets = selectProbeTargets(
      [
        { keyword: "peptide tracker", lastProbedAt: null },
        { keyword: "peptide tracker", lastProbedAt: NOW - 90 * DAY },
      ],
      { limit: 10, reprobeAfterSec: 30 * DAY, nowSec: NOW },
    );
    expect(targets).toEqual(["peptide tracker"]);
  });

  it("skips blank keywords rather than issuing an empty query", () => {
    const targets = selectProbeTargets(
      [
        { keyword: "   ", lastProbedAt: null },
        { keyword: "", lastProbedAt: null },
        { keyword: "peptide tracker", lastProbedAt: null },
      ],
      { limit: 10, reprobeAfterSec: 30 * DAY, nowSec: NOW },
    );
    expect(targets).toEqual(["peptide tracker"]);
  });

  it("does not mutate its input", () => {
    const input: readonly ProbeCandidate[] = [
      { keyword: "b", lastProbedAt: NOW - 90 * DAY },
      { keyword: "a", lastProbedAt: null },
    ];
    const snapshot = input.map((c) => c.keyword);
    selectProbeTargets(input, { limit: 10, reprobeAfterSec: DAY, nowSec: NOW });
    expect(input.map((c) => c.keyword)).toEqual(snapshot);
  });
});

describe("summarizeCoverage", () => {
  it("counts each tri-state bucket", () => {
    const summary = summarizeCoverage([
      { state: "present", bestRank: 0, probedAt: null },
      { state: "present", bestRank: 7, probedAt: NOW },
      { state: "probed-absent", probedAt: NOW, confidence: "direct" },
      { state: "probed-absent", probedAt: null, confidence: "prefix" },
      { state: "never-probed" },
    ]);
    expect(summary).toEqual({
      present: 2,
      probedAbsentDirect: 1,
      probedAbsentPrefix: 1,
      neverProbed: 1,
    });
  });

  it("returns an all-zero summary for an empty input", () => {
    expect(summarizeCoverage([])).toEqual({
      present: 0,
      probedAbsentDirect: 0,
      probedAbsentPrefix: 0,
      neverProbed: 0,
    });
  });
});
