/**
 * Segment taxonomy for the ideas pipeline (Phase 1 "generate-wide").
 *
 * The synthesizer historically generated a single idea per trend intersection,
 * which — combined with an app-store-trend bias — collapsed the candidate pool
 * into ~100% "consumer mobile app" mode. Selectors downstream cannot rescue
 * diversity that was never generated.
 *
 * This module defines a small, opinionated taxonomy of distinct OPPORTUNITY
 * SPACES (who buys / why it is a separate market), a quota helper to force the
 * over-generated pool to SPREAD across those spaces, and a pure heuristic to
 * TAG an existing candidate with its most likely segment.
 *
 * Everything here is PURE and dependency-free (no DB, clock, rng, or LLM) so it
 * is deterministic and fully unit-testable.
 */

// ── Taxonomy ─────────────────────────────────────────────────────────────────

/** The canonical segment ids, in a stable (broad → infra) order. */
export const SEGMENT_IDS = [
  "consumer",
  "b2b_saas",
  "devtools",
  "fintech",
  "healthcare",
  "vertical_ops",
  "marketplace",
  "infrastructure",
  "ai_native",
] as const;

export type SegmentId = (typeof SEGMENT_IDS)[number];

/** Static descriptor for one segment: who the buyer is + why it is distinct. */
export interface Segment {
  readonly id: SegmentId;
  readonly label: string;
  /** Who pulls out the wallet — the economic buyer / user persona. */
  readonly buyer: string;
  /** Why this is a distinct opportunity space (not just a re-skin). */
  readonly description: string;
  /**
   * Lowercased keyword stems used by {@link inferSegment} to tag free text.
   * Order does not matter; matching is substring-based and case-insensitive.
   */
  readonly keywords: readonly string[];
}

/**
 * The default segment taxonomy. Deliberately small (9 spaces) and biased toward
 * spaces with real willingness-to-pay so the pool is not all ad-supported
 * consumer apps. `consumer` is FIRST so it remains the graceful fallback, but it
 * is just one of nine — that is the whole point.
 */
export const SEGMENTS: readonly Segment[] = [
  {
    id: "consumer",
    label: "Consumer",
    buyer: "An individual end-user paying (or watching ads) for themselves.",
    description:
      "Direct-to-individual apps for everyday life — habits, social, media, " +
      "personal productivity. Distinct because acquisition is viral/paid and " +
      "monetization is subscription/ads, not seats or contracts.",
    keywords: [
      "consumer",
      "personal",
      "habit",
      "fitness",
      "wellness",
      "social",
      "dating",
      "photo",
      "lifestyle",
      "journal",
      "mobile app",
      "everyday",
    ],
  },
  {
    id: "b2b_saas",
    label: "B2B SaaS",
    buyer: "A business team lead / department owner buying seats.",
    description:
      "Horizontal software sold per-seat to teams (CRM, project, support, " +
      "marketing ops). Distinct because the buyer is an org, sales motion is " +
      "self-serve→sales-assisted, and retention is workflow lock-in.",
    keywords: [
      "b2b",
      "saas",
      "team",
      "workspace",
      "crm",
      "dashboard",
      "workflow",
      "collaboration",
      "enterprise",
      "seats",
      "back office",
      "productivity suite",
    ],
  },
  {
    id: "devtools",
    label: "Developer Tools",
    buyer: "An engineer or platform team adopting bottom-up.",
    description:
      "Tools developers adopt themselves — SDKs, CLIs, CI, observability, IDE " +
      "extensions. Distinct because adoption is bottom-up, evaluation is " +
      "technical, and the funnel runs through docs/OSS not marketing.",
    keywords: [
      "developer",
      "devtool",
      "sdk",
      "cli",
      "api",
      "library",
      "framework",
      "ci/cd",
      "observability",
      "debugging",
      "ide",
      "open source",
      "code",
    ],
  },
  {
    id: "fintech",
    label: "Fintech",
    buyer: "A consumer or business moving / managing money.",
    description:
      "Money movement, lending, accounting, payments, treasury, compliance. " +
      "Distinct because of regulation, trust, and interchange/float economics " +
      "that gate who can even build it.",
    keywords: [
      "fintech",
      "payment",
      "banking",
      "lending",
      "invoice",
      "accounting",
      "payroll",
      "treasury",
      "tax",
      "crypto",
      "wallet",
      "compliance",
      "fraud",
    ],
  },
  {
    id: "healthcare",
    label: "Healthcare",
    buyer: "A clinic, payer, or care provider (sometimes the patient).",
    description:
      "Clinical workflows, telehealth, patient engagement, medical billing. " +
      "Distinct because of HIPAA/regulation, long sales cycles, and " +
      "reimbursement-driven economics no generic app touches.",
    keywords: [
      "health",
      "healthcare",
      "clinic",
      "patient",
      "medical",
      "telehealth",
      "therapy",
      "ehr",
      "hipaa",
      "diagnosis",
      "care",
      "pharma",
    ],
  },
  {
    id: "vertical_ops",
    label: "Vertical Operations",
    buyer: "An operator in a specific industry (trades, logistics, hospitality).",
    description:
      "Industry-specific operational software — field service, restaurants, " +
      "construction, logistics, legal. Distinct because the wedge is deep " +
      "domain workflow that horizontal SaaS will never specialize into.",
    keywords: [
      "vertical",
      "field service",
      "construction",
      "logistics",
      "restaurant",
      "hospitality",
      "trucking",
      "legal",
      "manufacturing",
      "agriculture",
      "real estate",
      "scheduling",
      "dispatch",
    ],
  },
  {
    id: "marketplace",
    label: "Marketplace",
    buyer: "Two sides (supply + demand) the platform must seed simultaneously.",
    description:
      "Two-sided platforms matching supply and demand with a take-rate. " +
      "Distinct because of the cold-start / liquidity problem and " +
      "network-effect defensibility, not a single-buyer funnel.",
    keywords: [
      "marketplace",
      "two-sided",
      "platform",
      "matching",
      "gig",
      "supply",
      "demand",
      "listing",
      "booking",
      "rental",
      "freelance",
      "take rate",
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    buyer: "A platform/SRE team buying primitives the product is built on.",
    description:
      "Lower-level primitives — databases, queues, auth, edge, data pipelines. " +
      "Distinct because the buyer is technical, switching cost is high, and " +
      "value is reliability/scale rather than a UI.",
    keywords: [
      "infrastructure",
      "database",
      "queue",
      "auth",
      "edge",
      "pipeline",
      "data platform",
      "kubernetes",
      "networking",
      "storage",
      "serverless",
      "etl",
      "streaming",
    ],
  },
  {
    id: "ai_native",
    label: "AI-Native",
    buyer: "A team adopting an agent/model-first product as a new line item.",
    description:
      "Products that only exist because of recent model capability — agents, " +
      "copilots, generation, retrieval. Distinct because the why-now is the " +
      "capability shift itself and economics are inference-cost shaped.",
    keywords: [
      "ai",
      "llm",
      "agent",
      "copilot",
      "generative",
      "rag",
      "embedding",
      "model",
      "prompt",
      "fine-tune",
      "ai-native",
      "machine learning",
      "neural",
    ],
  },
] as const;

/** Fast lookup of a segment by id. */
export const SEGMENT_BY_ID: Readonly<Record<SegmentId, Segment>> =
  Object.freeze(
    SEGMENTS.reduce(
      (acc, seg) => ({ ...acc, [seg.id]: seg }),
      {} as Record<SegmentId, Segment>,
    ),
  );

/** The graceful-fallback segment when nothing matches. */
export const DEFAULT_SEGMENT_ID: SegmentId = "consumer";

// ── Quota distribution ───────────────────────────────────────────────────────

/** A target count of seeds to generate for one segment. */
export interface SegmentQuota {
  readonly segmentId: SegmentId;
  readonly count: number;
}

/**
 * Distribute a target number of seeds across segments to FORCE spread, so the
 * over-generated pool cannot collapse onto one space.
 *
 * Uses the largest-remainder (Hare) method over an even share so the counts sum
 * EXACTLY to `targetCount` and the distribution is as flat as possible: each
 * segment gets floor(target / n), and the leftover units go to the segments
 * with the largest fractional remainder (ties broken by taxonomy order, i.e.
 * the order of `segmentIds`). PURE + deterministic.
 *
 * @param targetCount total seeds to allocate (clamped to >= 0; non-integers floored)
 * @param segmentIds  which segments to spread across (defaults to all of them)
 */
export function segmentQuota(
  targetCount: number,
  segmentIds: readonly SegmentId[] = SEGMENT_IDS,
): readonly SegmentQuota[] {
  const ids = segmentIds.length > 0 ? segmentIds : SEGMENT_IDS;
  const target = Math.max(0, Math.floor(targetCount));
  const n = ids.length;

  if (target === 0) {
    return ids.map((segmentId) => ({ segmentId, count: 0 }));
  }

  const base = Math.floor(target / n);
  let remainder = target - base * n; // units still to hand out (0..n-1)

  // Hand the leftover one-at-a-time in taxonomy order. With an even share the
  // fractional remainders are identical, so order IS the deterministic
  // tie-break — front segments (consumer/b2b_saas/...) get the extra unit.
  return ids.map((segmentId) => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return { segmentId, count: base + extra };
  });
}

// ── Inference ────────────────────────────────────────────────────────────────

/** A scored {@link inferSegment} result. */
export interface SegmentMatch {
  readonly segmentId: SegmentId;
  /** Count of keyword hits that produced this match (0 => fallback). */
  readonly score: number;
}

/**
 * Heuristically tag free text (a candidate's category + title + summary) with
 * its most likely segment by counting keyword hits.
 *
 * Deterministic: on a tie the segment that appears FIRST in {@link SEGMENTS}
 * wins, and zero matches falls back to {@link DEFAULT_SEGMENT_ID}. Returns the
 * full match (id + score) so callers can tell a real signal from a fallback
 * (score === 0).
 */
export function inferSegmentMatch(text: string): SegmentMatch {
  const haystack = (text ?? "").toLowerCase();

  let best: SegmentMatch = { segmentId: DEFAULT_SEGMENT_ID, score: 0 };

  for (const seg of SEGMENTS) {
    let score = 0;
    for (const kw of seg.keywords) {
      if (kw.length > 0 && haystack.includes(kw)) score += 1;
    }
    // Strict ">" keeps the FIRST (taxonomy-order) segment on ties.
    if (score > best.score) {
      best = { segmentId: seg.id, score };
    }
  }

  return best;
}

/**
 * Convenience wrapper returning just the inferred {@link SegmentId} (fallback to
 * {@link DEFAULT_SEGMENT_ID} when nothing matches).
 */
export function inferSegment(text: string): SegmentId {
  return inferSegmentMatch(text).segmentId;
}
