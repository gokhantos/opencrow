/**
 * Prompt-surface building blocks for the synthesizer generation passes.
 *
 * Holds the static prompt constants (CATEGORY_CONTEXT, SCHLEP_INSTRUCTION,
 * GIANT_RUBRIC_PROMPT), the insight/exemplar/anti-exemplar/outcome-memory
 * section builders, the existing-ideas dedup context, and the small pure helpers
 * the passes share (segment resolution, seed→candidate, signal-id normalization,
 * the GIANT demand-gate + composite clamp).
 *
 * Extracted verbatim from synthesizer.ts as a behavior-preserving structural
 * refactor; the public symbols are re-exported from "./synthesizer".
 */

import type { IdeaCategory } from "../types";
import type {
  TrendData,
  ClusteredPains,
  CapabilityScan,
  Capability,
  GeneratedIdeaCandidate,
} from "./types";
import { getAllExistingIdeas } from "../../sources/ideas/store";
import type { ParsedGiant } from "./giant";
import { inferSegment, type SegmentId } from "./segments";
import type { VerbalizedSeed } from "./generate-wide";
import {
  sanitizeForPrompt,
  signalCitationToken,
  extractSignalIds,
} from "./synthesizer";

// ── Schlep / defensibility instruction (shared by generation + critique) ───
//
// Steers generation toward HARD, UNGLAMOROUS, DEFENSIBLE ideas (the kind that
// score high on the GIANT defensibility / nonObviousness axes) and away from
// the templated "X for Y app" clones that pattern-match a top-ideas list but
// have no moat. Injected into both generation prompts (Pass 2 + single-pass).
export const SCHLEP_INSTRUCTION = `SCHLEP & DEFENSIBILITY (CRITICAL):
- Prefer HARD, UNGLAMOROUS, DEFENSIBLE ideas — the unsexy "schlep" work most builders avoid (gnarly integrations, deep vertical workflows, ops/back-office software, data plumbing). The hard part IS the moat — but it must be a SOFTWARE / DATA / INTEGRATION / WORKFLOW moat, NOT regulation, capital, logistics, or a network effect.
- A fast-follower should NOT be able to copy the core in ~6 months. Reward counter-positioning and accruable advantages (proprietary data, hard-won integrations, deep workflow lock-in).
- PENALIZE templated "X for Y app" clones, thin ChatGPT wrappers, and ideas a weekend hacker reproduces. If it would appear on a generic "top AI app ideas" list, it is too obvious.
- Anchor every idea in an ACUTE problem a nameable user wants solved NOW (a painkiller, not a vitamin) and a DATED "why now" shift — not "AI is hot" hand-waving.`;

// ── Hard NEVER-GENERATE block (shared by generation + critique) ─────────────
//
// The generation-time half of the "uncompetable for a solo/bootstrapped builder"
// exclusion (the gate in competability.ts is the runtime backstop). Steers the
// model to NEVER PROPOSE ideas whose core REQUIRES regulation/licensing, heavy
// capital, physical logistics/field-ops, or a network-effect cold-start — the
// four moat families a solo builder cannot win in v1. PLUS audience/scope
// exclusions: never target a LOCAL / SMB SERVICE BUSINESS (its owner or
// trade/field workers) — restaurants, salons, clinics, electricians/plumbers/
// HVAC, etc. — and never propose a REGION-LOCKED core (bound to one nation's
// rules/taxes, a local payment rail, a national identity system, or a single
// locale). Deep vertical/ops software for LARGER, non-local industries stays in
// scope, and a globally-applicable idea that merely beachheads in one market
// first is fine (keeps SCHLEP_INSTRUCTION's pro-vertical + the marketShape
// wedge→TAM steer intact). Injected into the generation prompts alongside
// SCHLEP_INSTRUCTION. Exported so a test can assert its presence in the
// assembled prompts.
export const NEVER_GENERATE_BLOCK = `NEVER GENERATE — UNCOMPETABLE FOR A SOLO/BOOTSTRAPPED BUILDER (HARD RULE):
Do NOT propose any idea whose CORE requires any of these moat families. They are out of scope for a solo builder, no matter how acute the pain:
- REGULATED / LICENSED: banking, neobank, lending, insurance, brokerage/securities, money transmission, KYC/AML-bound fintech, healthcare needing HIPAA/FDA/clinical standing, telehealth-as-provider, pharmacy/pharma, legal practice, cannabis, gambling.
- HIGH CAPITAL / CAPEX: hardware, devices, robotics, deep-tech/biotech, subsidized unit economics, content-licensing/streaming catalogs, large upfront inventory or infrastructure.
- PHYSICAL LOGISTICS / FIELD-OPS: food/grocery/parcel delivery, last-mile, courier, fulfillment, warehousing, ride-hail, fleets, on-the-ground service networks.
- NETWORK-EFFECT / COLD-START: two-sided marketplaces worthless until both sides reach critical mass, social networks, dating apps, gig marketplaces — anything with no standalone v1 value.
ALSO NEVER GENERATE — EXCLUDED AUDIENCE (independent of moat; HARD RULE):
- LOCAL / SMB SERVICE-BUSINESS AUDIENCE: Do NOT propose products whose PRIMARY target user is a local or small service business, its owner, or its frontline/field workers. This includes (a) skilled trades & field-service: electricians, plumbers, HVAC technicians, general contractors, landscapers, handymen, auto mechanics, cleaners, movers, field/repair technicians; and (b) local service businesses: restaurants/cafes, bars, salons/barbers/spas, gyms/fitness studios, dental/veterinary/medical clinics, local retail shops, auto shops, real-estate brokerages, and similar owner-operated local services. (Deep vertical / ops software for LARGER, non-local industries remains in scope — this rule excludes only local/SMB service-business targets.)
- REGION-LOCKED CORE: Do NOT propose ideas whose CORE only works in one country/region because it is bound to a specific nation's regulations/taxes, a local payment rail (e.g. UPI, Pix, iDEAL, ACH-only), a national government/identity system, or a single language/locale with no path to others. Prefer GLOBALLY-APPLICABLE ideas. (An idea that is globally applicable but launches in one beachhead market first is FINE — exclude only ideas that CANNOT generalize beyond one region.)
If an idea's ONLY moat is regulatory capture, capital intensity, physical logistics, or a network effect, OR its primary audience is a local/SMB service business or its trade/field workers, OR its core is region-locked to a single country/region, DISCARD it — a solo builder cannot win it in v1.`;

// ── Category Context ─────────────────────────────────────────────────────

export const CATEGORY_CONTEXT: Record<IdeaCategory, string> = {
  mobile_app: `Generate mobile app ideas for iOS and Android.

WHAT MAKES A GREAT MOBILE APP IDEA:
- Solves a daily friction (something people do 3+ times/week on their phone)
- Has a natural distribution channel (social sharing, word-of-mouth trigger, app store search term)
- Can deliver value in the first 30 seconds of use (no complex onboarding)
- Has a "10x moment" — a specific use case where it's 10x better than the current workaround
- Revenue model works at mobile scale (freemium, subscription, or transaction-based)

NOTE: B2B, vertical, ops/back-office, and devtools ideas are WELCOME when they have a deep, defensible wedge — do not discourage them. A gnarly integration or hard-won data/workflow depth is often the moat, not a reason to avoid.

AVOID: ideas that need a two-sided marketplace to even function (chicken-and-egg with no seed side), thin clones with no defensible wedge.`,

  crypto_project: `Generate crypto/blockchain project ideas (DeFi, infrastructure, tooling, consumer).

WHAT MAKES A GREAT CRYPTO PROJECT IDEA:
- Leverages on-chain properties that can't be replicated off-chain (composability, permissionless access, programmable money, credible neutrality)
- Solves a problem that CURRENT crypto users have (not hypothetical mainstream users)
- Has a clear token utility or business model that doesn't depend on speculation
- Can launch on existing infrastructure (EVM, Solana, etc.) without building a new chain
- Has distribution via existing DeFi protocols, wallets, or communities

AVOID: "Blockchain for X" where X doesn't need a blockchain, ideas that require mass consumer adoption to work, ideas that are just a token wrapper around a centralized service.`,

  ai_app: `Generate AI application ideas powered by LLMs, vision models, or other ML capabilities.

WHAT MAKES A GREAT AI APP IDEA:
- Uses AI for a specific, narrow task where it's demonstrably better than manual work (not "AI-powered everything")
- The AI capability that enables it only became good enough in the last 12 months (why NOW?)
- Has a clear feedback loop — user corrections make it better over time
- Works even when the AI is 80% accurate (the UX handles errors gracefully)
- Can be built on top of existing model APIs (OpenAI, Anthropic, open source) — no custom training needed for v1

AVOID: "ChatGPT wrapper" ideas with no unique data or workflow, ideas where AI accuracy needs to be 99%+ to be useful, ideas that compete directly with foundation model providers.`,

  general: `Generate tech product ideas across any category.

WHAT MAKES A GREAT PRODUCT IDEA:
- Addresses a specific pain point evidenced in the data (not assumed)
- Has identifiable first users who you could reach today
- Can deliver core value with a small team in 4-8 weeks (MVP scope)
- Has a clear "why now" — something changed recently that makes this possible or necessary
- The one-line pitch makes someone say "I need that" not just "that's interesting"

NOTE: Non-consumer-app categories are fully in scope — defensible B2B, devtools, ops, infrastructure, and vertical SaaS ideas are encouraged when they target an acute, deep need. The unglamorous, hard-to-copy idea often wins.

AVOID: two-sided platform plays with no path to seed the first side, ideas where the main value is aggregation without unique insight or defensibility.`,
};

// ── Insights section builder ──────────────────────────────────────────────

/**
 * Build a citation token per capability and a human-legible suffix carrying the
 * `[id:<token>]` (chain-of-evidence #8 part2) and corroboration count (#10).
 *
 * The map is keyed by the lowercased capability title so the insight lines
 * (which only carry titles) can be annotated. Returns an empty map / no-op
 * annotations when chainOfEvidence is off, keeping legacy prompt output stable.
 */
function buildCapabilityEvidence(
  capabilities: CapabilityScan,
  chainOfEvidence: boolean,
): {
  readonly annotate: (title: string, source: string) => string;
  readonly tokenLegend: readonly string[];
} {
  const byTitle = new Map<string, { token: string; corroboration?: number }>();
  const legend: string[] = [];

  capabilities.capabilities.forEach((cap: Capability, index: number) => {
    const token = signalCitationToken(cap.source, index);
    const key = cap.title.toLowerCase().trim();
    if (!byTitle.has(key)) {
      byTitle.set(key, { token, corroboration: cap.corroborationCount });
    }
    if (chainOfEvidence) {
      legend.push(`  [id:${token}] ${sanitizeForPrompt(cap.title)} (${sanitizeForPrompt(cap.source)})`);
    }
  });

  const annotate = (title: string, source: string): string => {
    const entry = byTitle.get(title.toLowerCase().trim());
    const suffixes: string[] = [];
    if (chainOfEvidence) {
      const token = entry?.token ?? signalCitationToken(source, byTitle.size);
      suffixes.push(`[id:${token}]`);
    }
    // #10: emphasize high-corroboration (multi-source) signals.
    const corroboration = entry?.corroboration;
    if (typeof corroboration === "number" && corroboration > 1) {
      suffixes.push(`(corroborated ×${corroboration})`);
    }
    return suffixes.length > 0 ? ` ${suffixes.join(" ")}` : "";
  };

  return { annotate, tokenLegend: legend };
}

export function buildInsightsSection(
  trends: TrendData,
  pains: ClusteredPains,
  capabilities: CapabilityScan,
  chainOfEvidence = false,
): string {
  const parts: string[] = [];
  const capEvidence = buildCapabilityEvidence(capabilities, chainOfEvidence);

  if (trends.insights) {
    const { underservedSegments, workingPatterns, whiteSpaces } = trends.insights;
    // B6 — sanitize LLM-produced insight fields before embedding them into the
    // second-hop synthesizer prompt so injected instructions cannot propagate.
    const segmentLines = underservedSegments
      .slice(0, 8)
      .map((s) => `  • [${sanitizeForPrompt(s.category)}] ${sanitizeForPrompt(s.gap)} — ${sanitizeForPrompt(s.evidence)}`);
    const patternLines = workingPatterns
      .slice(0, 5)
      .map((p) => `  • ${sanitizeForPrompt(p.pattern)} — ${sanitizeForPrompt(p.evidence)}`);
    const spaceLines = whiteSpaces
      .slice(0, 5)
      .map((w) => `  • ${sanitizeForPrompt(w.description)} (adjacent: ${w.adjacentCategories.map(sanitizeForPrompt).join(", ")}) — ${sanitizeForPrompt(w.reason)}`);

    parts.push(
      "=== LANDSCAPE INSIGHTS ===",
      "Underserved segments:",
      ...segmentLines,
      "Working patterns:",
      ...patternLines,
      "White spaces:",
      ...spaceLines,
    );
  } else {
    parts.push(
      "=== APP LANDSCAPE (raw) ===",
      sanitizeForPrompt(trends.summary || "No landscape data").slice(0, 20000),
    );
  }

  if (pains.insights) {
    const { painThemes, workaroundSignals, loveSignals } = pains.insights;
    // B6 — sanitize LLM-produced insight fields before embedding them into the
    // second-hop synthesizer prompt so injected instructions cannot propagate.
    const themeLines = painThemes
      .slice(0, 8)
      .map((t) => `  • [${t.frequency}] ${sanitizeForPrompt(t.name)}: ${sanitizeForPrompt(t.description)} (apps: ${t.affectedApps.slice(0, 3).map(sanitizeForPrompt).join(", ")})`);
    const workaroundLines = workaroundSignals
      .slice(0, 5)
      .map((w) => `  • ${sanitizeForPrompt(w.description)} — current fix: ${sanitizeForPrompt(w.currentSolution)}`);
    const loveLines = loveSignals
      .slice(0, 5)
      .map((l) => `  • [${sanitizeForPrompt(l.category)}] ${sanitizeForPrompt(l.feature)}: ${sanitizeForPrompt(l.whyUsersLoveIt)}`);

    parts.push(
      "",
      "=== REVIEW INSIGHTS ===",
      "Pain themes:",
      ...themeLines,
      "Workaround signals (jobs-to-be-done):",
      ...workaroundLines,
      "Love signals (what to amplify):",
      ...loveLines,
    );
  } else {
    parts.push(
      "",
      "=== USER REVIEWS (raw) ===",
      sanitizeForPrompt(pains.summary || "No review data").slice(0, 20000),
    );
  }

  if (capabilities.insights) {
    const { genuinelyNew, technologyWaves, painCapabilityLinks } = capabilities.insights;
    // B6 — sanitize LLM-produced insight fields before embedding them into the
    // second-hop synthesizer prompt so injected instructions cannot propagate.
    const capLines = genuinelyNew
      .slice(0, 8)
      .map((c) => `  • [${c.classification}] ${sanitizeForPrompt(c.title)} (${sanitizeForPrompt(c.source)})${capEvidence.annotate(c.title, c.source)}: ${sanitizeForPrompt(c.whyNew)}`);
    const waveLines = technologyWaves
      .slice(0, 5)
      .map((w) => `  • ${sanitizeForPrompt(w.name)}: ${sanitizeForPrompt(w.implication)}`);
    const linkLines = painCapabilityLinks
      .slice(0, 8)
      .map((l) => `  • Pain "${sanitizeForPrompt(l.painTheme)}" × Capability "${sanitizeForPrompt(l.capability)}": ${sanitizeForPrompt(l.connectionReason)}`);

    parts.push(
      "",
      "=== CAPABILITY INSIGHTS ===",
      "Genuinely new capabilities:",
      ...capLines,
      "Technology waves:",
      ...waveLines,
      "Pain × Capability links:",
      ...linkLines,
    );
  } else {
    parts.push(
      "",
      "=== NEW CAPABILITIES (raw) ===",
      sanitizeForPrompt(capabilities.summary || "No capability data").slice(0, 20000),
    );
  }

  // #8 part2: expose the full citation legend so the model can reference signals
  // it did not see annotated inline (e.g. raw-summary fallback paths).
  if (chainOfEvidence && capEvidence.tokenLegend.length > 0) {
    parts.push(
      "",
      "=== SIGNAL CITATIONS (cite these tokens as supporting evidence) ===",
      ...capEvidence.tokenLegend,
    );
  }

  return parts.join("\n");
}

// ── Existing Ideas Context (dedup at LLM level) ─────────────────────────

export async function buildExistingIdeasContext(): Promise<string> {
  try {
    const existing = await getAllExistingIdeas();
    if (existing.length === 0) return "";

    const lines = existing.slice(0, 200).map(
      (idea) => `- [${sanitizeForPrompt(idea.category)}] ${sanitizeForPrompt(idea.title)}: ${sanitizeForPrompt(idea.summary.slice(0, 100))}`,
    );

    return `\n\n=== EXISTING IDEAS (DO NOT generate anything similar to these — strict dedup) ===\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── Validated-exemplar few-shot (#5) ─────────────────────────────────────

/** Minimal shape of a human-validated idea used as a positive few-shot example. */
export interface ValidatedExemplar {
  readonly title: string;
  readonly summary: string;
  readonly category?: string;
}

/**
 * #5 VALIDATED-EXEMPLAR FEW-SHOT: build a positive few-shot block from ideas
 * that humans validated, symmetric to the negative saturation block. Injected
 * into Pass 2 / single-pass prompts so the model produces "more like these".
 *
 * Returns "" when there are no exemplars, so callers can inject unconditionally.
 * The block is pure formatting — gating happens at the call site via
 * smart.validatedExemplars (the Pipeline phase passes "" when the flag is off).
 */
export function buildValidatedExemplars(
  exemplars: readonly ValidatedExemplar[],
  max = 6,
): string {
  if (exemplars.length === 0) return "";

  const lines = exemplars.slice(0, max).map((ex) => {
    const category = ex.category ? `[${sanitizeForPrompt(ex.category)}] ` : "";
    return `  • ${category}${sanitizeForPrompt(ex.title)}: ${sanitizeForPrompt(ex.summary.slice(0, 160))}`;
  });

  return [
    "",
    "=== HUMAN-VALIDATED IDEAS (produce MORE like these — same quality bar, NOT duplicates) ===",
    "These ideas passed human review. Match their specificity, grounding, and concreteness.",
    "Do NOT copy them; generate fundamentally new ideas that share their rigor.",
    ...lines,
  ].join("\n");
}

/**
 * Render the positive validated-exemplar block at a saturatedSection seam.
 * Empty string in → empty string out (legacy prompt unchanged).
 */
export function validatedExemplarSection(validatedExemplars: string): string {
  return validatedExemplars ? `\n${validatedExemplars}` : "";
}

// ── Anti-exemplar few-shot (Phase 4 cold-taste-loop — genericness lever) ────
//
// SYMMETRIC to buildValidatedExemplars, but NEGATIVE: an "AVOID these generic
// archetypes" block built from low-GIANT / known-generic ideas (templated
// "X for Y app", low novelty + defensibility, vague "AI-powered <noun>" shells).
// This is the HIGHER-LEVERAGE half of the genericness fix and the SAFER one for
// mode-collapse — negatives steer generation AWAY from a pattern rather than
// pulling it TOWARD a small set of seeds. Injected into BOTH the generation
// prompts (Pass 2 / wide / single-pass) AND the GIANT critique so the critic
// also penalizes the avoided archetypes.
//
// Counts are kept LOW (the Pipeline phase selects via taste.exemplarCount,
// default 4, and ROTATES the slice across runs) to preserve novelty — the
// eval-harness novelty metric is the gate.

/**
 * Minimal shape of a negative archetype used as an anti-exemplar. `reason` is
 * the human-legible "why this is generic/weak" string surfaced in the AVOID
 * block so the model learns the PATTERN to avoid, not just the instance.
 */
export interface AntiExemplarInput {
  readonly title: string;
  readonly summary: string;
  readonly category?: string;
  /** Why this was flagged (generic-archetype reason and/or low-GIANT). */
  readonly reason?: string;
}

/**
 * Build a NEGATIVE few-shot block from generic / low-GIANT ideas, symmetric to
 * buildValidatedExemplars. Output is kept SHORT (titles + a one-line why-bad)
 * and counts LOW to avoid mode-collapse; the caller is expected to pass a small,
 * rotated slice (taste.exemplarCount, default 4).
 *
 * Returns "" when there are no anti-exemplars, so callers can inject
 * unconditionally. Pure formatting — gating happens at the call site via
 * smart.taste.antiExemplars (the Pipeline phase passes "" when the flag is off).
 *
 * Format matches taste.renderAntiBlock so EITHER path produces the same
 * "AVOID these generic archetypes" block (pick ONE at the call site to avoid
 * double-injection).
 */
export function buildAntiExemplars(
  antiExemplars: readonly AntiExemplarInput[],
  max = 4,
): string {
  if (antiExemplars.length === 0) return "";

  const lines = antiExemplars.slice(0, max).map((ex) => {
    const category = ex.category ? `[${sanitizeForPrompt(ex.category)}] ` : "";
    const why = ex.reason ? ` — ${sanitizeForPrompt(ex.reason)}` : "";
    return `  ✗ ${category}${sanitizeForPrompt(ex.title)}: ${sanitizeForPrompt(
      ex.summary.slice(0, 120),
    )}${why}`;
  });

  return [
    "",
    "=== AVOID these generic archetypes that scored POORLY (do NOT generate anything like them) ===",
    "These are undifferentiated shells — templated 'X for Y', vague 'AI-powered <noun>', no acute problem.",
    "Steer AWAY from this entire pattern, not just these exact titles.",
    ...lines,
  ].join("\n");
}

/**
 * Render the negative anti-exemplar block at a saturatedSection seam, symmetric
 * to validatedExemplarSection. Empty string in → empty string out (legacy prompt
 * unchanged). The Pipeline phase passes "" when smart.taste.antiExemplars is off.
 */
export function antiExemplarSection(antiExemplars: string): string {
  return antiExemplars ? `\n${antiExemplars}` : "";
}

/**
 * Render the OUTCOME MEMORY block (learned REINFORCE/AVOID guidance from past
 * idea verdicts) at the antiSection seam. Empty string in → empty string out
 * (legacy prompt unchanged). The block produced by buildOutcomeMemoryBlock is
 * ALREADY sanitized (sanitizeScrapedField) and fenced (wrapUntrusted) per memory
 * — do NOT double-sanitize here, just thread it through.
 */
export function outcomeMemorySection(outcomeMemory: string): string {
  return outcomeMemory ? `\n${outcomeMemory}` : "";
}

// ── Signal-id normalization + segment helpers (Pass 2 / wide) ───────────────

/**
 * Normalize a candidate's emitted `supportingSignalIds` into a clean string[]
 * regardless of whether the model returned a string or array. Immutable.
 */
export function normalizeSignalIds(
  candidate: GeneratedIdeaCandidate,
): GeneratedIdeaCandidate {
  const ids = extractSignalIds(
    (candidate as { supportingSignalIds?: unknown }).supportingSignalIds,
  );
  if (ids.length === 0) {
    // Drop a possibly-malformed field rather than carry junk forward.
    const { supportingSignalIds: _omit, ...rest } = candidate as GeneratedIdeaCandidate & {
      supportingSignalIds?: unknown;
    };
    return rest;
  }
  return { ...candidate, supportingSignalIds: ids };
}

const SEGMENT_IDS_SET: ReadonlySet<string> = new Set([
  "consumer",
  "b2b_saas",
  "devtools",
  "fintech",
  "healthcare",
  "vertical_ops",
  "marketplace",
  "infrastructure",
  "ai_native",
]);

/**
 * Coerce a free-text/unknown segment value emitted by the model into a known
 * SegmentId, inferring from the idea text when the emitted value is missing or
 * not a recognized id. Pure.
 */
function resolveSegment(
  emitted: unknown,
  candidate: GeneratedIdeaCandidate,
): SegmentId {
  if (typeof emitted === "string") {
    const normalized = emitted.toLowerCase().trim().replace(/[\s-]+/g, "_");
    const match = SEGMENT_IDS_SET.has(normalized)
      ? (normalized as SegmentId)
      : null;
    if (match) return match;
  }
  return inferSegment(
    `${candidate.category} ${candidate.title} ${candidate.summary}`,
  );
}

/**
 * Turn a parsed VerbalizedSeed into a GeneratedIdeaCandidate, carrying the
 * verbalized probability (diversity prior) and a resolved segment tag. Tolerant
 * of missing fields (the critique/normalize passes backfill / validate). Pure.
 */
export function seedToCandidate(
  seed: VerbalizedSeed,
  category: IdeaCategory,
  multiSegment: boolean,
  chainOfEvidence: boolean,
): GeneratedIdeaCandidate {
  const idea = seed.idea;
  const str = (v: unknown, fallback = ""): string =>
    typeof v === "string" ? v : fallback;
  const arr = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const base: GeneratedIdeaCandidate = {
    title: str(idea.title),
    summary: str(idea.summary),
    reasoning: str(idea.reasoning),
    designDescription: str(idea.designDescription),
    monetizationDetail: str(idea.monetizationDetail),
    sourceLinks: Array.isArray(idea.sourceLinks)
      ? (idea.sourceLinks as GeneratedIdeaCandidate["sourceLinks"])
      : [],
    sourcesUsed: str(idea.sourcesUsed),
    category: str(idea.category, category),
    qualityScore:
      typeof idea.qualityScore === "number" ? idea.qualityScore : 0,
    targetAudience: str(idea.targetAudience),
    keyFeatures: arr(idea.keyFeatures),
    revenueModel: str(idea.revenueModel),
    trendIntersection: str(idea.trendIntersection),
    verbalizedProb: seed.probability,
  };

  const withSignals = chainOfEvidence
    ? normalizeSignalIds({
        ...base,
        supportingSignalIds: (idea as { supportingSignalIds?: unknown })
          .supportingSignalIds as readonly string[] | undefined,
      })
    : base;

  if (!multiSegment) return withSignals;
  return { ...withSignals, segment: resolveSegment(idea.segment, withSignals) };
}

// ── GIANT critique prompt + scoring helpers ─────────────────────────────────

/** Strong per-axis anchors for the GIANT critique prompt (high vs low). */
export const GIANT_RUBRIC_PROMPT = `Score each idea against THE GIANT RUBRIC — 9 axes, each 0..5. Be ruthless; reserve 4-5 for genuine outliers. Reward HARD, UNGLAMOROUS, DEFENSIBLE ideas; penalize templated "X for Y app" clones.

1. acuteProblem (0..5) — Is this a PAINKILLER a nameable user wants v1 NOW, backed by complaint-cluster size/recency? HIGH(5): a specific user is bleeding from this today and hacking a workaround. LOW(0-1): a "nice to have" vitamin, no one is actively hurting. SCORE <=1 IS A HARD GATE — reject-worthy.
2. whyNow (0..5) — Is there >=1 DATED, source-bound enabling shift (technological/regulatory/behavioral/economic) that makes this possible/necessary NOW? HIGH(5): a concrete dated shift you can cite. LOW(0-1): "AI is hot" hand-waving, nothing recent actually changed. SCORE <=1 IS A HARD GATE.
3. demand (0..5) — MUST cite a real demand artifact (search-volume delta, job-posting count, funding round, waitlist size, "looking for a tool that..." posts). HIGH(5): a quantified, cited artifact. LOW(<=2): no cited artifact — if you cannot cite one, score this <=2. Never free-score demand on vibes.
4. monetization (0..5) — Is there a CREDIBLE who-pays + how-much + path to revenue (a nameable buyer, concrete pricing, a path to ARR)? HIGH(5): a specific buyer with budget and a believable price point. LOW(0-1): free-only, "ads/enterprise/tokens someday", or no nameable buyer. SCORE <=1 IS A HARD GATE.
5. feasibility (0..5) — Is this BUILDABLE & shippable by a small team using APIs/data/compute that EXIST TODAY? HIGH(5): all pieces are available right now. LOW(0-1): needs private app-data exports (DoorDash/Uber/bank order history), impractical on-device compute (e.g. running an LLM locally on a phone), or integrations/data access that don't exist. SCORE <=1 IS A HARD GATE.
6. nonObviousness (0..5) — How far is this from the known-product corpus AND its in-batch siblings? HIGH(5): unsexy-but-defensible, would NOT show up on a "top AI app ideas" list. LOW(0-1): an obvious template ("Notion for X", "Uber for Y", "ChatGPT wrapper for Z").
7. defensibility (0..5) — Is there a moat a fast-follower CANNOT copy in ~6 months (counter-positioning, accruable advantage, hard-won data/integration)? HIGH(5): a structural advantage. LOW(0-1): a thin UI a weekend hacker reproduces.
8. marketShape (0..5) — Is there a deep BEACHHEAD user with an acute need plus a named path to a large TAM (a well, not a hole)? HIGH(5): narrow wedge → big market. LOW(0-1): a shallow hole with no expansion path.
9. founderFit (0..5) — Execution difficulty judged AGAINST THE IDEA'S ARCHETYPE (not uniformly). A hard-fact idea SHOULD be hard; reward ideas whose difficulty matches a defensible archetype rather than easy-but-trivial.

Also tag ARCHETYPE: "hair-on-fire" (acute pain, sell aspirin today) | "hard-fact" (a non-obvious truth about the world) | "future-vision" (bet on where things are going).
Provide a structured whyNow array of dated, source-bound enabling shifts.
Provide painSeverity = the acuteProblem axis value (0..5), for fast pain filtering.`;

/**
 * Whether the parsed GIANT carries a cited demand artifact, so the demand
 * evidence-gate can decide whether to cap the demand axis. Heuristic + tolerant:
 * a demand artifact is present when the demand evidence citation is non-empty OR
 * any whyNow shift is bound to a real signal id. Errs toward NOT capping only
 * when there is concrete evidence — un-evidenced demand stays capped (the GIANT
 * default). Pure.
 */
export function hasDemandEvidence(parsed: Pick<ParsedGiant, "evidence" | "whyNow">): boolean {
  const demandEvidence = parsed.evidence.demand?.trim() ?? "";
  if (demandEvidence.length > 0) return true;
  return parsed.whyNow.some(
    (shift) =>
      typeof shift.boundSignalId === "string" &&
      shift.boundSignalId.trim().length > 0,
  );
}

/**
 * Map a GIANT composite (0..5, weighted geometric mean) onto the legacy
 * qualityScore scale (the rest of the pipeline reads qualityScore for sort /
 * MMR / persistence). The composite IS a 0..5 scale already, so this is an
 * identity clamp into [0, 5] — kept as a named seam so the derivation is
 * explicit and testable. Pure.
 */
export function compositeToQualityScore(composite: number): number {
  if (!Number.isFinite(composite)) return 0;
  return Math.min(5, Math.max(0, composite));
}
