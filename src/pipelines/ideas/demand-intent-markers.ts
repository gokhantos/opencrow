/**
 * Phase 2 — DEMAND-SIDE GROUNDING: intent markers + curated synonyms (PURE DATA).
 *
 * Two focused, dependency-free data exports shared by the demand probes
 * (reddit / HN / X) and the fuzzy matcher in ./demand.ts:
 *
 *   - {@link DEMAND_INTENT_MARKERS} — buyer-intent phrasings. A scraped row only
 *     counts as STRONG buyer-intent when it pairs a candidate keyword WITH one of
 *     these markers (the keyword co-occurrence gate is what keeps precision; the
 *     markers stay topical-when-paired). Used by reddit/HN/X intent probes.
 *
 *   - {@link DEMAND_SYNONYM_GROUPS} / {@link demandSynonymsFor} — a NARROW,
 *     hand-curated synonym map so an idea worded differently than the corpus
 *     ("payroll" ↔ "wages", "invoicing" ↔ "billing") can still match a real row.
 *     Deliberately small and topical — broad/loose synonyms would re-open the
 *     false-positive hole the relevance gate exists to close.
 *
 * NO imports from ./demand.ts (so there is no import cycle): this module is the
 * leaf data layer; demand.ts imports FROM here.
 */

// ── Intent markers (Lever 1/2) ────────────────────────────────────────────────

/**
 * Buyer-INTENT phrases. A row qualifies as STRONG demand only when it pairs a
 * candidate keyword WITH one of these markers — that pairing separates "people
 * discussing X" from "people who WANT a tool for X". Expanded beyond the original
 * ~18 "is there a tool" phrasings to cover the question / frustration /
 * manual-workaround / willingness forms that real niche & B2B pain actually uses
 * (a B2B practitioner rarely phrases their pain as "is there an app for X").
 *
 * Curated to stay topical ONLY WHEN PAIRED WITH A KEYWORD — the keyword
 * co-occurrence relevance gate is what keeps these from matching generic chatter.
 * All lowercase; matching is done case-insensitively by the probes.
 */
export const DEMAND_INTENT_MARKERS: readonly string[] = [
  // ── direct "looking for a tool" forms (original set) ──
  "looking for a tool",
  "looking for an app",
  "looking for a way",
  "looking for software",
  "is there a tool",
  "is there an app",
  "is there a way",
  "is there anything",
  "is there software",
  "i wish there was",
  "i wish there were",
  "anyone know of",
  "anyone know a",
  "does anyone know",
  "recommend a tool",
  "recommend an app",
  "willing to pay",
  "would pay for",
  "shut up and take my money",
  "alternative to",
  "any alternatives",
  // ── question forms (how others solve it) ──
  "how do you",
  "how do you all",
  "how do you guys",
  "how does everyone",
  "what do you use for",
  "what do you use to",
  "what are you using",
  "best way to",
  "any recommendations",
  "anyone using",
  "anyone else using",
  // ── frustration forms (the pain itself) ──
  "frustrated with",
  "so frustrating",
  "sick of",
  "tired of",
  "fed up with",
  "hate that",
  "i hate having to",
  "pain in the",
  "such a pain",
  "biggest pain",
  "driving me crazy",
  // ── manual-workaround forms (no good tool exists) ──
  "by hand",
  "manually",
  "stuck with spreadsheets",
  "google sheet",
  "google sheets",
  "copy paste",
  "copy and paste",
  "copy-paste",
  "no good tool",
  "nothing out there",
  "no decent",
  "there's nothing",
  // ── willingness-to-pay forms ──
  "happy to pay",
  "take my money",
  "gladly pay",
  "id pay for",
];

// ── Curated synonym map (Lever 3) ─────────────────────────────────────────────

/**
 * Narrow, hand-curated synonym GROUPS. Every term in a group is treated as an
 * accepted variant of every other term in the group by {@link demandSynonymsFor}
 * (used by `matchesKeyword` in ./demand.ts). Groups are intentionally TIGHT and
 * domain-precise — only true near-synonyms a niche/B2B idea would interchange,
 * never broad umbrellas (e.g. "scheduling" is NOT synonymous with "management").
 *
 * Terms are stored as plain lowercase tokens/phrases. The matcher stems each
 * side before comparing, so "scheduling"/"scheduler" already collapse via stems;
 * a synonym group is for terms that do NOT share a stem ("payroll" ↔ "wages").
 *
 * Multi-word group members ("shift planning") are matched as phrases by the
 * matcher's word-boundary phrase path.
 */
export const DEMAND_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["scheduling", "scheduler", "shift planning", "rostering", "rota"],
  ["invoicing", "billing", "invoice"],
  ["payroll", "wages", "paycheck", "paystub"],
  ["onboarding", "new hire setup"],
  ["bookkeeping", "accounting"],
  ["appointment", "booking", "reservation"],
  ["inventory", "stock control"],
  ["timesheet", "time tracking", "time logging"],
  ["crm", "customer relationship management"],
  ["helpdesk", "ticketing", "support desk"],
];

/**
 * Build the term → accepted-variants index from {@link DEMAND_SYNONYM_GROUPS}.
 * Each term maps to the OTHER members of its group(s). Built once at module load
 * (pure, deterministic). A term may appear in multiple groups; its variant set is
 * the union of those groups (minus itself).
 */
const SYNONYM_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, Set<string>>();
  for (const group of DEMAND_SYNONYM_GROUPS) {
    for (const term of group) {
      const key = term.toLowerCase();
      const set = index.get(key) ?? new Set<string>();
      for (const other of group) {
        const variant = other.toLowerCase();
        if (variant !== key) set.add(variant);
      }
      index.set(key, set);
    }
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, v] of index) out.set(k, [...v]);
  return out;
})();

/**
 * Curated synonym variants for `term` (lowercased phrase or token), or [] when
 * the term has no curated synonyms. PURE: no IO, deterministic, stable order.
 */
export function demandSynonymsFor(term: string): readonly string[] {
  return SYNONYM_INDEX.get(term.trim().toLowerCase()) ?? [];
}
