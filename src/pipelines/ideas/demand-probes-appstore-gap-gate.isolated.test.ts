/**
 * Isolated test for the `appstoreGap` probe gate in `selectProbes`
 * (src/pipelines/ideas/demand-probes.ts).
 *
 * `appstoreGapProbe` is registered in `DEFAULT_DEMAND_PROBES` but must only run
 * when the standalone App Store keyword-gap scanner feature is enabled
 * (`appstoreKeywordGap.enabled`) — otherwise it fires a wasted
 * `SELECT ... FROM appstore_keyword_scans` on every demand-grounding run even
 * for installs that never opted into the scanner.
 *
 * Filed as *.isolated.test.ts because it mocks the config loader (`loadConfig`)
 * at the module level, which is process-global and would leak into the other,
 * non-mocked tests in demand-probes.test.ts if it lived there.
 *
 * NOTE: mock.module must replace modules BEFORE they are imported, so this file
 * sets up the stub at the top level and then imports the unit under test.
 */

import { mock, test, expect, describe } from "bun:test";
import type { DemandEvidence, DemandProbe } from "./demand";

// ── config loader: appstoreKeywordGap.enabled is toggled per-test ────────────
let appstoreKeywordGapEnabled = false;

mock.module("../../config/loader", () => ({
  loadConfig: () => ({
    appstoreKeywordGap: { enabled: appstoreKeywordGapEnabled },
  }),
}));

const { enrichDemand } = await import("./demand-probes");
const { ABSENCE_SCORE_CAP } = await import("./demand");

// ── injected (no-DB) probe ────────────────────────────────────────────────────

function recordingProbe(
  name: string,
  evidence: readonly DemandEvidence[],
): DemandProbe & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    name,
    seen,
    async probe(keywords) {
      seen.push([...keywords]);
      return evidence;
    },
  } as DemandProbe & { seen: string[][] };
}

const CANDIDATE = {
  title: "Invoice reconciliation for small agencies",
  summary: "Agencies waste days reconciling invoices manually each month.",
  reasoning: "Manual invoice reconciliation is slow and error-prone.",
};

describe("selectProbes gating: appstoreGap", () => {
  test("does NOT run when appstoreKeywordGap.enabled is false", async () => {
    appstoreKeywordGapEnabled = false;
    const appstoreGap = recordingProbe("appstoreGap", [
      { kind: "appstore_gap", query: "x", count: 5 },
    ]);
    const art = await enrichDemand(CANDIDATE, [appstoreGap], { phSupply: false });
    expect(appstoreGap.seen.length).toBe(0);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
  });

  test("runs when appstoreKeywordGap.enabled is true", async () => {
    appstoreKeywordGapEnabled = true;
    const appstoreGap = recordingProbe("appstoreGap", [
      { kind: "appstore_gap", query: "x", count: 5 },
    ]);
    const art = await enrichDemand(CANDIDATE, [appstoreGap], { phSupply: false });
    expect(appstoreGap.seen.length).toBe(1);
    expect(art.evidence.some((e) => e.kind === "appstore_gap")).toBe(true);
  });
});
