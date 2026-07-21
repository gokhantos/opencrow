// Pure formatter for a `KeywordGapProfile` — renders a human-readable
// multi-line summary for agent tool output. No I/O; unit-testable in
// isolation from the network-dependent `scanKeyword` orchestration.

import type { KeywordGapProfile, TopApp } from "./keyword-types";
import { sanitizeScrapedField } from "../../sige/untrusted";

const MAX_TOP_APPS_SHOWN = 5;
// App Store app names are attacker-controlled scraped text (any developer can
// name their app anything). This formatter's string is returned verbatim from
// the `analyze_keyword_gap` tool and replayed into the LLM's conversation, so
// every incumbent name is run through the same scraped-text chokepoint used
// elsewhere before it enters a prompt.
const MAX_APP_NAME_LEN = 200;

function toPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatTopApp(app: TopApp, i: number): string {
  const safeName = sanitizeScrapedField(app.name, MAX_APP_NAME_LEN);
  return `  ${i + 1}. ${safeName} — ${app.reviews.toLocaleString()} reviews, ${app.rating.toFixed(1)}★`;
}

/** Human-readable rendering of a scan's autocomplete hint evidence (Batch D item D1), or `null` when there's no evidence to show. */
function formatHintEvidence(hintBestRank: number | null, hintSeedCount: number | null): string | null {
  if (hintBestRank === null || hintSeedCount === null || hintSeedCount <= 0) return null;
  const seedNoun = hintSeedCount === 1 ? "seed" : "seeds";
  return `  Autocomplete hint: observed as a real typed query, rank ${hintBestRank} (${hintSeedCount} ${seedNoun})`;
}

/**
 * Manually-probed Apple Search Ads `searchPopularity` reading for this
 * keyword (`appstore_search_popularity`, migration 053, `source='asa'`) —
 * see `popularity-store.ts` for why this is a manual-import surface rather
 * than an API sweep. Passed in by the caller (the `analyze_keyword_gap`
 * tool), not looked up here, so this formatter stays DB-free/pure/unit-
 * testable.
 */
export interface VolumeCheck {
  /** Apple's 0..5 `searchPopularity` scale. */
  readonly popularity: number;
  /** Epoch seconds the reading was recorded. */
  readonly checkedAt: number;
}

function formatVolumeCheckLine(volumeCheck: VolumeCheck | null | undefined): string {
  if (!volumeCheck) {
    return "  ASA popularity: unverified (never manually probed)";
  }
  const probedDate = new Date(volumeCheck.checkedAt * 1000).toISOString().slice(0, 10);
  return `  ASA popularity: ${volumeCheck.popularity}/5 (probed ${probedDate})`;
}

export function formatGapProfile(
  p: KeywordGapProfile,
  volumeCheck?: VolumeCheck | null,
): string {
  const incumbents = p.topApps.slice(0, MAX_TOP_APPS_SHOWN).map(formatTopApp).join("\n");

  // The keyword can be seeded from Apple's autocomplete (semi attacker-
  // influenceable), so sanitize it too — parity with the incumbent names and
  // with buildQuote on the autonomous path — before it enters the prompt.
  const safeKeyword = sanitizeScrapedField(p.keyword, MAX_APP_NAME_LEN);

  const hintLine = formatHintEvidence(p.hintBestRank ?? null, p.hintSeedCount ?? null);

  const lines = [
    `Keyword Gap: "${safeKeyword}" (${p.store === "app" ? "App Store (US)" : p.store === "DE" ? "App Store (DE)" : "Google Play"})`,
    `  Competitiveness: ${Math.round(p.competitiveness)}/100`,
    `  Demand: ${p.demand.toFixed(1)} ratings/day`,
    `  Incumbent weakness: ${toPercent(p.incumbentWeakness)}`,
    `  Opportunity: ${toPercent(p.opportunity)}`,
    `  Trend: ${p.trend}`,
    // Batch A budget rescue (2026-07-22) — see keyword-brand.ts's
    // `isBrandNavigationalScan`: warns the reader that this keyword's
    // demand/incumbent-weakness numbers above reflect ONE dominant brand
    // rather than a genuine generic-demand opportunity.
    ...(p.brandNavigational
      ? ["  Note: navigational query — demand reflects one brand, not general demand."]
      : []),
    ...(hintLine ? [hintLine] : []),
    // Batch D item D2: caveat when demand/incumbent-weakness came from a
    // giant-excluded non-matched fallback field rather than a field we
    // actually know serves this keyword — see `lowConfidence`'s doc comment
    // (keyword-types.ts).
    ...(p.lowConfidence
      ? ["  Caveat: no title-matched incumbent — demand estimated from unrelated non-giant apps."]
      : []),
    formatVolumeCheckLine(volumeCheck),
    "",
    incumbents.length > 0
      ? `Top incumbents:\n${incumbents}`
      : "Top incumbents: none found for this keyword.",
  ];

  return lines.join("\n");
}
