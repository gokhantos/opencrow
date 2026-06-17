import { test, expect, describe } from "bun:test";
import {
  enrichDemand,
  externalTrendsProbe,
  DEFAULT_DEMAND_PROBES,
} from "./demand-probes";
import {
  ABSENCE_SCORE_CAP,
  ABSENCE_CONFIDENCE_CAP,
  type DemandEvidence,
  type DemandProbe,
} from "./demand";

// ── injected (no-DB) probes ──────────────────────────────────────────────────

/** A probe that records the keywords it received and returns canned evidence. */
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

// ── enrichDemand: orchestration ──────────────────────────────────────────────

describe("enrichDemand", () => {
  test("extracts keywords from the candidate and passes them to probes", async () => {
    const reddit = recordingProbe("redditIntent", []);
    await enrichDemand(CANDIDATE, [reddit], { fundingSignal: false });
    expect(reddit.seen.length).toBe(1);
    const kws = reddit.seen[0] ?? [];
    expect(kws.length).toBeGreaterThan(0);
    expect(kws).toContain("invoice reconciliation");
  });

  test("aggregates evidence from multiple probes into one artifact", async () => {
    const reddit = recordingProbe("redditIntent", [
      { kind: "reddit_intent", query: "invoice", count: 8 },
    ]);
    const funding = recordingProbe("fundingNews", [
      { kind: "funding_news", query: "invoice", count: 3 },
    ]);
    const art = await enrichDemand(CANDIDATE, [reddit, funding]);
    expect(art.evidence.length).toBe(2);
    expect(art.score).toBeGreaterThan(ABSENCE_SCORE_CAP);
    expect(art.confidence).toBeGreaterThan(ABSENCE_CONFIDENCE_CAP);
  });

  test("returns the ABSENCE artifact when disabled (no neutral score)", async () => {
    const reddit = recordingProbe("redditIntent", [
      { kind: "reddit_intent", query: "x", count: 10 },
    ]);
    const art = await enrichDemand(CANDIDATE, [reddit], { enabled: false });
    expect(reddit.seen.length).toBe(0); // probe never ran
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
    expect(art.confidence).toBeLessThanOrEqual(ABSENCE_CONFIDENCE_CAP);
  });

  test("returns the ABSENCE artifact when no keywords can be extracted", async () => {
    const reddit = recordingProbe("redditIntent", [
      { kind: "reddit_intent", query: "x", count: 10 },
    ]);
    const art = await enrichDemand({ title: "the and or for" }, [reddit]);
    expect(reddit.seen.length).toBe(0);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
  });

  test("a throwing probe is isolated and does not break aggregation", async () => {
    const boom: DemandProbe = {
      name: "boom",
      async probe() {
        throw new Error("db exploded");
      },
    };
    const ok = recordingProbe("redditIntent", [
      { kind: "reddit_intent", query: "invoice", count: 6 },
    ]);
    const art = await enrichDemand(CANDIDATE, [boom, ok]);
    expect(art.evidence.length).toBe(1);
    expect(art.score).toBeGreaterThan(ABSENCE_SCORE_CAP);
  });

  test("selectProbes gating: redditIntent off => not run", async () => {
    const reddit = recordingProbe("redditIntent", [
      { kind: "reddit_intent", query: "x", count: 5 },
    ]);
    const funding = recordingProbe("fundingNews", [
      { kind: "funding_news", query: "x", count: 5 },
    ]);
    const art = await enrichDemand(CANDIDATE, [reddit, funding], {
      redditIntent: false,
    });
    expect(reddit.seen.length).toBe(0);
    expect(funding.seen.length).toBe(1);
    expect(art.evidence.every((e) => e.kind === "funding_news")).toBe(true);
  });

  test("external trends probe only runs when externalTrends is enabled", async () => {
    const ext = recordingProbe("externalTrends", [
      { kind: "search_trend", query: "x", count: 9 },
    ]);
    const off = await enrichDemand(CANDIDATE, [ext], { externalTrends: false });
    expect(ext.seen.length).toBe(0);
    expect(off.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);

    const on = await enrichDemand(CANDIDATE, [ext], { externalTrends: true });
    expect(ext.seen.length).toBe(1);
    expect(on.evidence.length).toBe(1);
  });

  test("threads supplyDensity through to the whitespace computation", async () => {
    const reddit = recordingProbe("redditIntent", [
      { kind: "reddit_intent", query: "x", count: 30 },
    ]);
    const open = await enrichDemand(CANDIDATE, [reddit], { supplyDensity: 0 });
    const crowded = await enrichDemand(CANDIDATE, [reddit], {
      supplyDensity: 0.9,
    });
    expect(crowded.whitespace).toBeLessThan(open.whitespace);
  });
});

// ── externalTrendsProbe (stub) ───────────────────────────────────────────────

describe("externalTrendsProbe", () => {
  test("is a graceful no-op returning [] when flag is off", async () => {
    const out = await externalTrendsProbe.probe(["x"], {
      externalTrends: false,
    });
    expect(out).toEqual([]);
  });

  test("returns [] even when enabled (no vendor wired up, never fabricates)", async () => {
    const out = await externalTrendsProbe.probe(["x"], {
      externalTrends: true,
    });
    expect(out).toEqual([]);
  });
});

// ── default probe set ────────────────────────────────────────────────────────

describe("DEFAULT_DEMAND_PROBES", () => {
  test("includes the reddit-intent, funding-news, and external-trends probes", () => {
    const names = DEFAULT_DEMAND_PROBES.map((p) => p.name).sort();
    expect(names).toEqual(["externalTrends", "fundingNews", "redditIntent"]);
  });
});
