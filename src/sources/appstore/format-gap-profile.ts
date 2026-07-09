// Pure formatter for a `KeywordGapProfile` — renders a human-readable
// multi-line summary for agent tool output. No I/O; unit-testable in
// isolation from the network-dependent `scanKeyword` orchestration.

import type { KeywordGapProfile, TopApp } from "./keyword-types";

const MAX_TOP_APPS_SHOWN = 5;

function toPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatTopApp(app: TopApp, i: number): string {
  return `  ${i + 1}. ${app.name} — ${app.reviews.toLocaleString()} reviews, ${app.rating.toFixed(1)}★`;
}

export function formatGapProfile(p: KeywordGapProfile): string {
  const incumbents = p.topApps.slice(0, MAX_TOP_APPS_SHOWN).map(formatTopApp).join("\n");

  const lines = [
    `Keyword Gap: "${p.keyword}" (${p.store === "app" ? "App Store" : "Google Play"})`,
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
