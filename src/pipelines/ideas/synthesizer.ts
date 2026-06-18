/**
 * Trend-intersection idea synthesizer.
 *
 * 3-pass synthesis approach:
 * 1. Intersection Discovery — find 15-20 non-obvious intersection hypotheses
 * 2. Idea Development — develop top 10 hypotheses into full idea candidates
 * 3. Idea Critique — score each idea on specificity, signal grounding,
 *    differentiation, and buildability; kill weak ones
 *
 * Falls back to single-pass synthesis if Pass 1 fails.
 *
 * This module is the PUBLIC ENTRY POINT for the synthesizer. To keep every file
 * under the 800-line ceiling, the retrieval layer (deepSearch + rerankers +
 * signal-ranking) lives in `./synthesizer-retrieval` and the generation layer
 * (prompt builders + JSON parsers + section builders + the three LLM sub-phases)
 * lives in `./synthesizer-generation`. The small pure helpers below stay HERE so
 * the siblings (and external importers) can pull them from "./synthesizer"
 * without a cycle, and both siblings are re-exported so the public API is
 * unchanged.
 */

import type { SearchResult } from "../../memory/types";
import { createLogger } from "../../logger";
import { loadConfig } from "../../config/loader";
import type {
  TrendData,
  ClusteredPains,
  CapabilityScan,
  GeneratedIdeaCandidate,
  IntersectionHypothesis,
  SynthesisResult,
} from "./types";
import { applyMmr } from "../../memory/mmr";
import type { IdeaCategory } from "../types";
import { selectWithNoveltyReserve } from "./generate-wide";
import {
  critiqueIdeas,
  developIdeas,
  developIdeasWide,
  discoverIntersections,
  singlePassSynthesis,
} from "./synthesizer-generation";

const log = createLogger("pipeline:synthesizer");

// ── Shared helpers ───────────────────────────────────────────────────────

export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/`{3,}/g, "'''")
    .replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|prompts?)\b/gi, "[filtered]")
    .replace(/<\/?(?:system|assistant|user|human)>/gi, "[filtered]")
    // Neutralize the review-fence delimiter so content inside a <<<review ... >>>
    // block cannot break out of the fence and inject instructions at the boundary.
    .replace(/<<</g, "‹‹‹")
    .replace(/>>>/g, "›››")
    .slice(0, 80000);
}

export function buildChatOptions(model: string) {
  return {
    systemPrompt: "",
    model,
    provider: "anthropic" as const,
    agentId: "idea-pipeline",
    usageContext: { channel: "pipeline" as const, chatId: "ideas", source: "workflow" as const },
  };
}

export function parseJsonFromResponse<T>(text: string, fallback: T): T {
  const jsonMatch =
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ??
    text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);

  if (!jsonMatch?.[1]) return fallback;

  try {
    return JSON.parse(jsonMatch[1].trim()) as T;
  } catch {
    log.warn("Failed to parse AI response as JSON", {
      preview: text.slice(0, 200),
    });
    return fallback;
  }
}

/**
 * Truncation-tolerant parser for a JSON array of objects. The wide
 * over-generation can emit a response large enough to hit the model's
 * output-token cap, leaving the array unterminated — standard JSON.parse then
 * yields NOTHING and the pool silently collapses. This walks the array body and
 * recovers every COMPLETE top-level element, discarding only an incomplete
 * trailing one. Returns [] when no array is present.
 */
export function parseJsonArrayLenient(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("[");
  if (start === -1) return [];

  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elemStart = -1;

  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0 && elemStart === -1) elemStart = i;
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0 && elemStart === -1) elemStart = i;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (ch === "]" && depth === 0) break; // end of the outer array
      depth--;
      if (depth === 0 && elemStart !== -1) {
        try {
          out.push(JSON.parse(body.slice(elemStart, i + 1)));
        } catch {
          /* skip a malformed element, keep the rest */
        }
        elemStart = -1;
      }
      continue;
    }
  }
  return out;
}

// ── Signal citation tokens (chain-of-evidence #8 part2) ─────────────────

/**
 * Build a stable, prompt-safe citation token for a capability so the model can
 * cite it as `[id:<token>]` and the Pipeline-phase verifier can bind the idea
 * back to its grounding signal. Deterministic per (source, index) within a run.
 *
 * Example: source "producthunt", index 2 → "producthunt_2".
 */
export function signalCitationToken(source: string, index: number): string {
  const safeSource = (source || "src")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "src";
  return `${safeSource}_${index}`;
}

/**
 * Extract emitted `[id:<token>]` citation tokens from a model field value.
 * Returns a deduped, order-preserving list. Accepts either a delimited string
 * or an already-parsed array (the model occasionally emits either shape).
 */
export function extractSignalIds(raw: unknown): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    const cleaned = token.trim().replace(/^\[?id:?/i, "").replace(/\]$/, "").trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") push(item);
    }
    return out;
  }

  if (typeof raw === "string") {
    const tokenMatches = raw.match(/\[id:[^\]]+\]/gi);
    if (tokenMatches) {
      for (const m of tokenMatches) push(m);
      return out;
    }
    for (const part of raw.split(/[,\s]+/)) push(part);
  }
  return out;
}

// ── Public API re-exports (behavior-preserving structural split) ──────────
//
// Retrieval layer: deepSearch + rerankers + signal-ranking + evidence-strength.
export {
  deepSearch,
  evidenceStrengthLabel,
  prioritizeByRanking,
  type DeepSearchOptions,
} from "./synthesizer-retrieval";

// Generation/prompt layer: exemplar blocks, section renderers, GIANT helpers.
export {
  buildValidatedExemplars,
  buildAntiExemplars,
  outcomeMemorySection,
  hasDemandEvidence,
  compositeToQualityScore,
  type ValidatedExemplar,
  type AntiExemplarInput,
} from "./synthesizer-prompts";

// ── Main Synthesis ───────────────────────────────────────────────────────

export async function synthesizeFromTrends(input: {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext: string;
  readonly saturatedThemes: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly model: string;
  /**
   * #5 Positive few-shot block of human-validated ideas (built by the Pipeline
   * phase via buildValidatedExemplars). Optional — backward-compatible; injected
   * only when smart.validatedExemplars is on AND the caller supplies it.
   */
  readonly validatedExemplars?: string;
  /**
   * Phase 4 cold-taste-loop ANTI-EXEMPLAR block: an already-rendered "AVOID these
   * generic archetypes" few-shot (built by the Pipeline phase via taste.ts
   * renderAntiBlock, or synthesizer.buildAntiExemplars). Injected into BOTH the
   * generation prompts and the GIANT critique to steer generation AWAY from the
   * generic / low-GIANT pattern (the higher-leverage genericness lever, and the
   * safer one for mode-collapse). Optional — backward-compatible; injected only
   * when smart.taste.antiExemplars is on AND the caller supplies it. Empty/absent
   * → today's behavior. Keep the count LOW + rotated to preserve novelty.
   */
  readonly antiExemplars?: string;
  /**
   * Phase 1 "generate-wide" SIGE divergent merge (flag-gated, default OFF): extra
   * UNSCORED candidates produced by the SIGE divergent-generation pool that the
   * Pipeline phase folds into the synthesizer pool. They are merged BEFORE Pass 3
   * so they flow through the SAME GIANT critique + novelty-reserve selection as
   * the over-generated candidates (keeping the whole pool evidence-tethered and
   * comparably scored). Optional — backward-compatible; empty/absent → today's
   * behavior. The total pool (over-generated + extra) is capped at
   * smart.generateWide.maxCandidates.
   */
  readonly extraCandidates?: readonly GeneratedIdeaCandidate[];
  /**
   * Step 5 OUTCOME MEMORY block: an already-rendered REINFORCE/AVOID guidance
   * section (built by the Pipeline phase via fetchOutcomeMemoryBlock →
   * buildOutcomeMemoryBlock from past idea verdicts in mem0). The block is
   * already sanitized + fenced. Threaded into the generation prompts (NOT the
   * GIANT critique) as semantic guidance. Optional — backward-compatible;
   * injected only when smart.outcomeMemory.readAtSynthesis is on AND the caller
   * supplies it. Empty/absent → today's behavior.
   */
  readonly outcomeMemory?: string;
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;

  const smart = loadConfig().pipelines.ideas.smart;
  const chainOfEvidence = smart.chainOfEvidence;
  const generateWide = smart.generateWide;
  // Gate the positive few-shot: only inject when the flag is ON.
  const validatedExemplars = smart.validatedExemplars ? input.validatedExemplars ?? "" : "";
  // Gate the NEGATIVE anti-exemplar few-shot (Phase 4 genericness lever): only
  // inject when smart.taste.antiExemplars is on. The Pipeline phase already
  // passes "" when off; gate here too so the path is defended end-to-end.
  const antiExemplars = smart.taste.antiExemplars ? input.antiExemplars ?? "" : "";
  // Step 5 OUTCOME MEMORY (learned REINFORCE/AVOID guidance from past verdicts):
  // re-gate at the synthesis boundary so the path is defended end-to-end. Only
  // inject when smart.outcomeMemory.readAtSynthesis is on; "" → today's behavior.
  const outcomeMemory = smart.outcomeMemory.readAtSynthesis ? input.outcomeMemory ?? "" : "";

  // ── Pass 1: Discover intersections ──────────────────────────────────
  let intersections: readonly IntersectionHypothesis[];

  try {
    intersections = await discoverIntersections(trends, pains, capabilities, model, chainOfEvidence);
  } catch (err) {
    log.error("Pass 1 failed, falling back to single-pass synthesis", { err });
    return singlePassSynthesis({ ...input, validatedExemplars, antiExemplars, outcomeMemory });
  }

  if (intersections.length === 0) {
    log.warn("No intersections found in Pass 1, falling back to single-pass synthesis");
    return singlePassSynthesis({ ...input, validatedExemplars, antiExemplars, outcomeMemory });
  }

  // Deduplicate by capabilitySignal — if 3+ hypotheses cite the same capability, keep only the best
  const capabilityCounts = new Map<string, number>();
  for (const h of intersections) {
    const key = h.capabilitySignal.toLowerCase().trim();
    capabilityCounts.set(key, (capabilityCounts.get(key) ?? 0) + 1);
  }

  const dedupedIntersections = intersections.filter((h) => {
    const key = h.capabilitySignal.toLowerCase().trim();
    const count = capabilityCounts.get(key) ?? 0;
    if (count <= 2) return true;
    // Keep only the highest signalStrength for over-represented capabilities
    const best = intersections
      .filter((x) => x.capabilitySignal.toLowerCase().trim() === key)
      .sort((a, b) => b.signalStrength - a.signalStrength)[0];
    return h === best;
  });

  log.info("Capability dedup complete", {
    before: intersections.length,
    after: dedupedIntersections.length,
  });

  // Take top 10 by signal strength from deduped set
  const topIntersections = [...dedupedIntersections]
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, Math.min(maxIdeas * 2, 10));

  log.info("Pass 1 complete — proceeding to Pass 2", {
    totalIntersections: intersections.length,
    selectedForDevelopment: topIntersections.length,
  });

  // ── Pass 2: Develop ideas from intersections ─────────────────────────
  // Phase 1 "generate-wide": when overGenerate is ON, request a DISTRIBUTION of
  // seeds per intersection (verbalized sampling) + segment spread to WIDEN the
  // pool. Any failure degrades to the legacy single-idea path, then to single-
  // pass — so the optional widening can never break the pipeline.
  let rawCandidates: readonly GeneratedIdeaCandidate[];

  try {
    if (generateWide.overGenerate) {
      try {
        rawCandidates = await developIdeasWide(
          topIntersections,
          category,
          saturatedThemes,
          deepSearchContext,
          model,
          validatedExemplars,
          chainOfEvidence,
          generateWide,
          antiExemplars,
          outcomeMemory,
        );
        if (rawCandidates.length === 0) {
          log.warn(
            "Over-generation produced no candidates, falling back to single-idea developIdeas",
          );
          rawCandidates = await developIdeas(
            topIntersections,
            category,
            saturatedThemes,
            deepSearchContext,
            model,
            validatedExemplars,
            chainOfEvidence,
            antiExemplars,
            outcomeMemory,
          );
        }
      } catch (wideErr) {
        log.warn(
          "Over-generation path failed, falling back to single-idea developIdeas",
          { err: wideErr },
        );
        rawCandidates = await developIdeas(
          topIntersections,
          category,
          saturatedThemes,
          deepSearchContext,
          model,
          validatedExemplars,
          chainOfEvidence,
          antiExemplars,
          outcomeMemory,
        );
      }
    } else {
      rawCandidates = await developIdeas(
        topIntersections,
        category,
        saturatedThemes,
        deepSearchContext,
        model,
        validatedExemplars,
        chainOfEvidence,
        antiExemplars,
        outcomeMemory,
      );
    }
  } catch (err) {
    log.error("Pass 2 failed, falling back to single-pass synthesis", { err });
    return singlePassSynthesis({ ...input, validatedExemplars, antiExemplars, outcomeMemory });
  }

  if (rawCandidates.length === 0) {
    log.warn("No ideas developed in Pass 2, returning empty result");
    return { candidates: [], totalGenerated: 0 };
  }

  // SIGE DIVERGENT MERGE (generate-wide, flag-gated by the Pipeline phase): fold
  // any extra UNSCORED candidates into the pool BEFORE Pass 3 so they flow through
  // the SAME GIANT critique + novelty-reserve selection. Title-dedup against the
  // over-generated set, then cap the merged pool at maxCandidates so cost stays
  // bounded. No-op when the caller supplies none (default path).
  rawCandidates = mergeExtraCandidates(
    rawCandidates,
    input.extraCandidates ?? [],
    generateWide.maxCandidates,
  );

  log.info("Pass 2 complete — proceeding to Pass 3", { count: rawCandidates.length });

  // ── Pass 3: Critique and score ───────────────────────────────────────
  let critiquedCandidates: readonly GeneratedIdeaCandidate[];

  try {
    critiquedCandidates = await critiqueIdeas(
      rawCandidates,
      trends.summary,
      pains.summary,
      capabilities.summary,
      model,
      smart.giant,
      antiExemplars,
    );
  } catch (err) {
    log.error("Pass 3 failed, returning uncritiqued candidates", { err });
    critiquedCandidates = rawCandidates;
  }

  // ── QUICK WIN: sort by quality desc, then MMR diversity before slicing ──
  // Phase 1 "generate-wide": when over-generating, reserve a slice of the final
  // slots for high-novelty / high-originality candidates so the widened pool is
  // not collapsed back to the highest-self-reported-signal lookalikes.
  const finalCandidates = sortAndDiversify(
    critiquedCandidates,
    maxIdeas,
    generateWide.overGenerate,
  );

  return {
    candidates: finalCandidates,
    totalGenerated: rawCandidates.length,
  };
}

/**
 * QUICK WIN — sort + MMR. Sort critiqued candidates by qualityScore desc, then
 * run an intra-batch MMR diversity pass (Jaccard over title+summary) so the
 * top `maxIdeas` are both high-quality AND mutually distinct.
 *
 * Adapts candidates to the existing src/memory/mmr.ts applyMmr via minimal
 * SearchResult-shaped objects ({ chunk: { content: title+summary }, score }).
 * Falls back to a plain quality sort + slice on any error (never throws).
 */
/**
 * Merge extra (SIGE-divergent) candidates into the primary pool, deduping by
 * lowercased title against the primary set, then cap the combined pool at
 * `maxCandidates`. Primary candidates always take precedence on a title clash.
 * Pure + immutable; returns the primary set unchanged when there is nothing to
 * merge. The cap protects total cost (more candidates → more critique tokens).
 */
function mergeExtraCandidates(
  primary: readonly GeneratedIdeaCandidate[],
  extra: readonly GeneratedIdeaCandidate[],
  maxCandidates: number,
): readonly GeneratedIdeaCandidate[] {
  if (extra.length === 0) return primary.slice(0, maxCandidates);

  const seen = new Set(primary.map((c) => c.title.toLowerCase().trim()));
  const merged: GeneratedIdeaCandidate[] = [...primary];
  for (const candidate of extra) {
    const key = candidate.title.toLowerCase().trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }

  log.info("SIGE-divergent merge complete", {
    primary: primary.length,
    extra: extra.length,
    merged: merged.length,
    capped: Math.min(merged.length, maxCandidates),
  });

  return merged.slice(0, maxCandidates);
}

function sortAndDiversify(
  candidates: readonly GeneratedIdeaCandidate[],
  maxIdeas: number,
  reserveNovelty = false,
): readonly GeneratedIdeaCandidate[] {
  if (candidates.length <= 1 || maxIdeas <= 0) {
    return candidates.slice(0, maxIdeas);
  }

  const sorted = [...candidates].sort((a, b) => b.qualityScore - a.qualityScore);
  if (sorted.length <= maxIdeas) return sorted;

  // NOVELTY-RESERVE (generate-wide): reserve final slots for high-surprise /
  // high-originality candidates so the quality sort cannot starve out the
  // surprising ideas the widening produced. This narrows to exactly `maxIdeas`
  // candidates that MUST be kept; the MMR pass below then only REORDERS that set
  // (k === set size cannot drop a reserved member). Pure + total — degrades to
  // the plain quality sort on any issue. When off, MMR runs over the full sort.
  const mmrInput = reserveNovelty
    ? selectWithNoveltyReserve(sorted, maxIdeas)
    : sorted;
  const targetCount = Math.min(maxIdeas, mmrInput.length);

  try {
    // Adapt to SearchResult shape; applyMmr only reads `chunk.content` + `score`
    // and maps back by index, so a minimal structural object is sufficient.
    const adapted = mmrInput.map((c) => ({
      chunk: { content: `${c.title}\n${c.summary}` },
      score: c.qualityScore,
    })) as unknown as readonly SearchResult[];

    const diversified = applyMmr(adapted, 0.7, targetCount);
    const byContent = new Map<string, GeneratedIdeaCandidate>();
    mmrInput.forEach((c) => byContent.set(`${c.title}\n${c.summary}`, c));

    const result: GeneratedIdeaCandidate[] = [];
    for (const r of diversified) {
      const match = byContent.get(r.chunk.content);
      if (match) result.push(match);
    }
    // Safety: if mapping lost entries, fall back to the (novelty-reserved or
    // quality-sorted) slice.
    return result.length === targetCount
      ? result
      : mmrInput.slice(0, maxIdeas);
  } catch (err) {
    log.warn("sort+MMR diversity pass failed, using quality sort", { err });
    return mmrInput.slice(0, maxIdeas);
  }
}
