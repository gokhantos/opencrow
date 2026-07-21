/**
 * APP STORE KEYWORD-GAP DEMAND PROBE — `appstore_gap` evidence from
 * EXISTING `appstore_keyword_scans` rows.
 *
 * The keyword-gap scanner (`src/sources/appstore/**`) already computes, per
 * scanned keyword, a MEASURED supply/demand profile: `demand` (mean
 * ratingsPerDay across the top-ranked apps — real App Store review velocity,
 * not an LLM guess) and `opportunity` (0..1 whitespace = demand vs.
 * competitiveness vs. incumbent weakness). This probe reads the LATEST scan
 * per candidate keyword and, when its `opportunity` clears the configured
 * seed threshold, emits it as `appstore_gap` {@link DemandEvidence} feeding
 * the ideas pipeline's demand-grounding stage — the scan result itself IS the
 * expressed whitespace, so (like `reviewComplaintProbe`'s ≤2★ rating) no
 * separate buyer-intent marker is required.
 *
 * Anti-hallucination contract: `count` is derived from the scan's real
 * `demand` column; `quote` names a real incumbent from the scan's persisted
 * `top_apps` JSON (never invented). Graceful: any DB/config failure -> [] —
 * the demand path is OPTIONAL and must never break the pipeline.
 */

import { loadConfig } from "../../config/loader";
import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { sanitizeScrapedField } from "../../sige/untrusted";
import type { TopApp } from "../../sources/appstore/keyword-types";
import { getDb } from "../../store/db";
import type { DemandEvidence, DemandProbe, DemandProbeOptions } from "./demand";
import {
  asText,
  buildKeywordFilter,
  queryKeywords,
  resolveOpts,
  toCount,
} from "./demand-probe-helpers";

const logger = createLogger("ideas:appstore-gap-probe");

/** Defensively parse the `top_apps` JSONB cell (Bun's driver returns it as a raw string). */
function parseTopApps(value: unknown): readonly TopApp[] {
  if (Array.isArray(value)) return value as TopApp[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as TopApp[]) : [];
  } catch {
    return [];
  }
}

/** Pick the weakest incumbent (lowest rating) among `topApps`, if any. */
function weakestIncumbent(topApps: readonly TopApp[]): TopApp | undefined {
  if (topApps.length === 0) return undefined;
  return topApps.reduce((weakest, app) => (app.rating < weakest.rating ? app : weakest));
}

// Same scraped-text chokepoint applied to the incumbent name in
// format-gap-profile.ts — DemandEvidence.quote can be replayed verbatim into a
// GIANT-critique LLM prompt via buildDemandEvidenceString, so this is
// defense-in-depth against a malicious App Store app name.
const MAX_INCUMBENT_NAME_LEN = 200;

/**
 * Human-readable, auditable quote naming the measured opportunity and (when
 * available) the weakest incumbent app the scan observed. Never invented —
 * every value is read straight off the scan row. Both the keyword (which may be
 * seeded from Apple's search-suggest hints once autocomplete expansion is on)
 * and the incumbent name are semi/attacker-influenceable scraped text, so both
 * are sanitized before interpolation.
 */
function buildQuote(keyword: string, opportunity: number, topApps: readonly TopApp[]): string {
  const safeKeyword = sanitizeScrapedField(keyword, MAX_INCUMBENT_NAME_LEN);
  const base = `${safeKeyword}: opportunity ${opportunity.toFixed(2)}`;
  const incumbent = weakestIncumbent(topApps);
  if (!incumbent) return base;
  const safeName = sanitizeScrapedField(incumbent.name, MAX_INCUMBENT_NAME_LEN);
  return `${base}, weak incumbent ${safeName} (${incumbent.rating.toFixed(1)}★)`;
}

/**
 * Demand probe over `appstore_keyword_scans`: reads the latest scan per
 * candidate keyword (`DISTINCT ON (keyword) ... ORDER BY keyword,
 * scanned_at DESC`), gates on `opportunity >= appstoreKeywordGap
 * .opportunityThresholdForSeed`, and emits one `appstore_gap`
 * {@link DemandEvidence} per qualifying scan.
 */
export const appstoreGapProbe: DemandProbe = {
  name: "appstoreGap",
  async probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]> {
    const kws = queryKeywords(keywords);
    if (kws.length === 0) return [];
    const { windowSec, fuzzy } = resolveOpts(opts);

    try {
      const threshold = loadConfig().appstoreKeywordGap.opportunityThresholdForSeed;
      const db = getDb();
      // Integer-epoch column compared to an epoch int (never NOW()-INTERVAL).
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      const { clause, params } = buildKeywordFilter(["keyword"], kws, 2, fuzzy);
      // Batch D item D3/D2, 2026-07-22: `store = 'app'` keeps a fresher DE
      // (or future Play) scan from shadowing/outranking the US-calibrated
      // reading this probe is meant to read (mirrors `getTopOpportunities`'s
      // own store pin — see keyword-store.ts). `low_confidence = FALSE`
      // excludes scans whose demand/opportunity came from a
      // giant-excluded non-matched fallback field rather than a field we
      // actually know serves this keyword — this probe's evidence feeds an
      // LLM's demand-grounding stage and must never present a low-confidence
      // guess as a real supply/demand gap.
      const sql = `
        SELECT DISTINCT ON (keyword) id, keyword, demand, opportunity, top_apps
        FROM appstore_keyword_scans
        WHERE scanned_at >= $1 AND store = 'app' AND low_confidence = FALSE AND ${clause}
        ORDER BY keyword, scanned_at DESC
      `;
      const rows = (await db.unsafe(sql, [cutoff, ...params])) as Array<Record<string, unknown>>;

      const evidence: DemandEvidence[] = [];
      for (const r of rows) {
        const opportunity = toCount(r.opportunity);
        if (opportunity < threshold) continue; // GATE: only real supply/demand gaps
        const keyword = asText(r.keyword);
        const demand = toCount(r.demand);
        const topApps = parseTopApps(r.top_apps);
        evidence.push({
          kind: "appstore_gap",
          query: keyword,
          count: Math.max(1, Math.round(demand)),
          quote: buildQuote(keyword, opportunity, topApps),
          sourceId: String(r.id),
        });
      }
      return evidence;
    } catch (error) {
      logger.warn("appstoreGapProbe failed; returning no demand evidence", {
        error: getErrorMessage(error),
      });
      return [];
    }
  },
};
