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

export function formatGapProfile(p: KeywordGapProfile): string {
  const incumbents = p.topApps.slice(0, MAX_TOP_APPS_SHOWN).map(formatTopApp).join("\n");

  // The keyword can be seeded from Apple's autocomplete (semi attacker-
  // influenceable), so sanitize it too — parity with the incumbent names and
  // with buildQuote on the autonomous path — before it enters the prompt.
  const safeKeyword = sanitizeScrapedField(p.keyword, MAX_APP_NAME_LEN);

  const lines = [
    `Keyword Gap: "${safeKeyword}" (${p.store === "app" ? "App Store (US)" : p.store === "DE" ? "App Store (DE)" : "Google Play"})`,
    `  Competitiveness: ${Math.round(p.competitiveness)}/100`,
    `  Demand: ${p.demand.toFixed(1)} ratings/day`,
    `  Incumbent weakness: ${toPercent(p.incumbentWeakness)}`,
    `  Opportunity: ${toPercent(p.opportunity)}`,
    `  Trend: ${p.trend}`,
    "",
    incumbents.length > 0
      ? `Top incumbents:\n${incumbents}`
      : "Top incumbents: none found for this keyword.",
  ];

  return lines.join("\n");
}
