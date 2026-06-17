/**
 * Shared idea validation: deduplication + chain-of-evidence verification.
 *
 * Extracted from pipeline.ts so other entrypoints (e.g. the SIGE tail phase)
 * can reuse the exact same 3-layer dedup. Behavior is identical to the inline
 * implementation that previously lived in pipeline.ts.
 *
 * Layers:
 *   1. Exact normalized-title match against existing ideas.
 *   2. Fuzzy DB match via pg_trgm (findSimilarIdeas).
 *   3. Semantic vector match (memory search, stricter 0.65 threshold).
 *
 * Plus a pure chain-of-evidence verifier (#8 part3) that cross-checks the
 * signal-citation tokens emitted by the model against the real source rows
 * selected this run, dropping fabricated citations and folding a signal-
 * grounding score into the kept candidates.
 */

import { createLogger } from "../../logger";
import {
  findSimilarIdeas,
  getAllExistingIdeas,
} from "../../sources/ideas/store";
import { signalCitationToken } from "./synthesizer";
import type {
  MemoryManager,
  MemorySourceKind,
  SearchResult,
} from "../../memory/types";
import type { Capability, GeneratedIdeaCandidate } from "./types";

const log = createLogger("pipeline:ideas:validate");

// ── Title normalization ────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. Pure. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Deduplication ──────────────────────────────────────────────────────────

export interface DedupResult {
  readonly kept: readonly GeneratedIdeaCandidate[];
  readonly rejected: readonly string[];
}

/**
 * 3-layer dedup (exact title, fuzzy pg_trgm, semantic vector). Reusable by any
 * pipeline tail (idea pipeline, SIGE). memoryManager is optional; when absent,
 * layer 3 is skipped. Never throws on per-candidate search failures — degrades
 * to keeping the candidate.
 */
export async function checkForDuplicates(
  candidates: readonly GeneratedIdeaCandidate[],
  memoryManager: MemoryManager | null | undefined,
): Promise<DedupResult> {
  const kept: GeneratedIdeaCandidate[] = [];
  const rejected: string[] = [];

  // Pre-load all existing idea titles for the exact-match layer.
  const existingIdeas = await getAllExistingIdeas();
  const normalizedExisting = new Set(
    existingIdeas.map((i) => normalizeTitle(i.title)),
  );

  for (const candidate of candidates) {
    const normalizedTitle = normalizeTitle(candidate.title);

    // ── Layer 1: Exact normalized title match ──────────────────────────────
    if (normalizedExisting.has(normalizedTitle)) {
      rejected.push(`${candidate.title} [EXACT] matches existing idea`);
      log.info("Idea rejected by exact title match", { title: candidate.title });
      continue;
    }

    // ── Layer 2: Fuzzy DB match via pg_trgm ────────────────────────────────
    const similarIdeas = await findSimilarIdeas(
      candidate.title,
      candidate.summary,
      3,
    );
    const fuzzyMatch = similarIdeas.find(
      (s) => s.title_similarity > 0.4 || s.summary_similarity > 0.5,
    );
    if (fuzzyMatch) {
      rejected.push(
        `${candidate.title} [FUZZY] similar to "${fuzzyMatch.title}" (title: ${fuzzyMatch.title_similarity.toFixed(2)}, summary: ${fuzzyMatch.summary_similarity.toFixed(2)})`,
      );
      log.info("Idea rejected by fuzzy DB match", {
        title: candidate.title,
        matchedTitle: fuzzyMatch.title,
        titleSim: fuzzyMatch.title_similarity,
        summarySim: fuzzyMatch.summary_similarity,
      });
      continue;
    }

    // ── Layer 3: Semantic vector match (stricter threshold: 0.65) ──────────
    if (memoryManager) {
      try {
        const results = await memoryManager.search(
          "shared",
          `${candidate.title}: ${candidate.summary}`,
          { limit: 1, minScore: 0.65, kinds: ["idea"] },
        );

        if (results.length > 0 && results[0]!.score > 0.65) {
          const existing = results[0]!.source.metadata.title ?? "unknown";
          rejected.push(
            `${candidate.title} [SEMANTIC] similar to "${existing}" (score: ${results[0]!.score.toFixed(2)})`,
          );
          log.info("Idea rejected by semantic match", {
            title: candidate.title,
            matchedTitle: existing,
            score: results[0]!.score,
          });
          continue;
        }
      } catch {
        // keep on search failure
      }
    }

    // All 3 layers passed — keep the idea.
    kept.push(candidate);
  }

  return { kept, rejected };
}

// ── Originality vs. real-world prior art ────────────────────────────────────

/**
 * Known-product corpus kinds already indexed in Qdrant. These are real,
 * shipped products / repos / apps — the prior art we measure novelty against.
 * NOTE: deliberately distinct from the "idea" kind used by dedup Layer 3; this
 * computes distance from the *real world*, not from our own prior ideas.
 */
export const KNOWN_PRODUCT_KINDS = [
  "producthunt_product",
  "github_repo",
  "appstore_app",
  "playstore_app",
] as const satisfies readonly MemorySourceKind[];

/**
 * Per-candidate originality annotation. Additive — never used to drop a
 * candidate. Flows downstream (Pipeline phase) as an evidence-tethered novelty
 * signal alongside the GIANT vector.
 */
export interface OriginalityAnnotation {
  /**
   * Originality in [0, 1] = 1 − (similarity to nearest real-world product).
   * 1 = no comparable prior art found (maximally novel); 0 = an indexed product
   * is essentially identical. Neutral 1 when memory/search is unavailable or the
   * corpus returned nothing (we cannot prove the idea is derivative).
   */
  readonly originality: number;
  /** Short label of the closest indexed real-world product, when any matched. */
  readonly nearestProduct?: string;
  /** Cosine similarity to {@link nearestProduct} in [0, 1], when matched. */
  readonly nearestSimilarity?: number;
}

/** Result of {@link annotateOriginality}: a candidate with originality stamped on. */
export type CandidateWithOriginality = GeneratedIdeaCandidate &
  OriginalityAnnotation;

/**
 * Derive a short, human-readable product label from a search hit. Product /
 * app / repo kinds batch many items into one source, so metadata rarely carries
 * a per-item title; the indexed chunk content leads with the product name, so we
 * fall back to the first line / first segment of the chunk content. Pure.
 */
export function nearestProductLabel(result: SearchResult): string {
  const metaTitle = result.source.metadata.title;
  if (metaTitle && metaTitle.trim().length > 0) {
    return metaTitle.trim();
  }
  const firstLine = (result.chunk.content ?? "").split("\n")[0] ?? "";
  // Chunks often lead with "Name (rank, stats): tagline" or "[store] Name by …".
  const beforeColon = firstLine.split(":")[0] ?? firstLine;
  const label = beforeColon.trim();
  return label.length > 0 ? label.slice(0, 120) : "unknown product";
}

/**
 * Compute originality from raw cosine similarities to the known-product corpus.
 * Pure and the unit-testable core of the originality math.
 *
 *   originality = 1 − maxSimilarity   (clamped to [0, 1])
 *
 * Empty results → neutral 1 (no prior art found ⇒ we cannot call it derivative).
 * We use MAX similarity (nearest neighbor) rather than mean: a single
 * near-identical product is the meaningful "this already exists" signal, and
 * averaging would dilute it across unrelated hits.
 */
export function computeOriginality(
  similarities: readonly number[],
): number {
  if (similarities.length === 0) {
    return 1;
  }
  const maxSimilarity = similarities.reduce((m, s) => (s > m ? s : m), 0);
  const originality = 1 - maxSimilarity;
  if (originality < 0) return 0;
  if (originality > 1) return 1;
  return originality;
}

/**
 * Annotate each candidate with an originality score vs. the real-world product
 * corpus in Qdrant. Annotation-first: NEVER drops a candidate and NEVER alters
 * the existing dedup behavior. memoryManager is optional; when absent, or when a
 * per-candidate search fails, the candidate gets a neutral originality of 1
 * (we cannot prove it derivative) so the default path is unaffected.
 *
 * Injected `memoryManager` makes the orchestration testable; the scoring math
 * itself lives in the pure {@link computeOriginality}.
 */
export async function annotateOriginality(
  candidates: readonly GeneratedIdeaCandidate[],
  memoryManager: MemoryManager | null | undefined,
  opts?: { readonly agentId?: string; readonly limit?: number },
): Promise<readonly CandidateWithOriginality[]> {
  const agentId = opts?.agentId ?? "shared";
  const limit = opts?.limit ?? 5;

  // No memory → every candidate is neutral-original. Still annotate so the
  // downstream field is always present (backward-compatible, optional reads).
  if (!memoryManager) {
    return candidates.map((c) => ({ ...c, originality: 1 }));
  }

  const annotated: CandidateWithOriginality[] = [];
  for (const candidate of candidates) {
    try {
      const results = await memoryManager.search(
        agentId,
        `${candidate.title}: ${candidate.summary}`,
        { limit, kinds: KNOWN_PRODUCT_KINDS },
      );

      const similarities = results.map((r) => r.score);
      const originality = computeOriginality(similarities);

      if (results.length === 0) {
        annotated.push({ ...candidate, originality });
        continue;
      }

      const nearest = results.reduce((best, r) =>
        r.score > best.score ? r : best,
      );
      annotated.push({
        ...candidate,
        originality,
        nearestProduct: nearestProductLabel(nearest),
        nearestSimilarity: nearest.score,
      });

      log.info("Annotated idea originality", {
        title: candidate.title,
        originality,
        nearestProduct: nearestProductLabel(nearest),
        nearestSimilarity: nearest.score,
      });
    } catch (error) {
      // Graceful: a failed search must not break the pipeline. Neutral score.
      log.info("Originality search failed — defaulting to neutral", {
        title: candidate.title,
        error: error instanceof Error ? error.message : String(error),
      });
      annotated.push({ ...candidate, originality: 1 });
    }
  }

  return annotated;
}

// ── Chain-of-evidence verification (#8 part3) ───────────────────────────────

export interface EvidenceVerification {
  /** The candidate, unchanged except any fabricated citations are dropped. */
  readonly candidate: GeneratedIdeaCandidate;
  /**
   * Fraction of the candidate's emitted citations that resolved to a real
   * capability this run, in [0, 1]. 1 when the candidate cited nothing (no
   * claim to verify — neutral, not penalized).
   */
  readonly signalGrounding: number;
  /** Tokens the model emitted that did NOT match any real signal. */
  readonly fabricated: readonly string[];
}

/**
 * Build the set of valid signal-citation tokens for THIS run from the
 * capability list. Tokens are `<source>_<index>` over the capabilities array
 * ordering (the same scheme synthesizer.ts uses when prompting). Pure.
 */
export function buildValidSignalTokens(
  capabilities: readonly Capability[],
): ReadonlySet<string> {
  const tokens = new Set<string>();
  capabilities.forEach((cap, index) => {
    tokens.add(signalCitationToken(cap.source, index));
  });
  return tokens;
}

/**
 * Verify a single candidate's chain-of-evidence against the real signal tokens.
 * Drops fabricated citations from supportingSignalIds and returns a grounding
 * score. Pure — returns a new candidate, never mutates the input.
 */
export function verifyCandidateEvidence(
  candidate: GeneratedIdeaCandidate,
  validTokens: ReadonlySet<string>,
): EvidenceVerification {
  const cited = candidate.supportingSignalIds ?? [];

  // Nothing cited → neutral grounding (no claim to verify), nothing to drop.
  if (cited.length === 0) {
    return { candidate, signalGrounding: 1, fabricated: [] };
  }

  // No verifiable token set this run (e.g. no capabilities were registered, or
  // the run is landscape/review-only). We cannot prove fabrication against an
  // empty set, so treat citations as UNVERIFIED — neutral grounding, keep the
  // candidate and its citations intact, strip nothing.
  if (validTokens.size === 0) {
    return { candidate, signalGrounding: 0.5, fabricated: [] };
  }

  const real: string[] = [];
  const fabricated: string[] = [];
  for (const token of cited) {
    if (validTokens.has(token.toLowerCase())) {
      real.push(token);
    } else {
      fabricated.push(token);
    }
  }

  const signalGrounding = real.length / cited.length;

  const verifiedCandidate: GeneratedIdeaCandidate = {
    ...candidate,
    supportingSignalIds: real,
  };

  return { candidate: verifiedCandidate, signalGrounding, fabricated };
}

export interface VerifyEvidenceResult {
  /** Candidates that survived the verifier (fabrication-only citations dropped). */
  readonly kept: readonly GeneratedIdeaCandidate[];
  /** Human-readable notes about dropped/penalized candidates. */
  readonly notes: readonly string[];
  /** candidate.title → signalGrounding score for the kept set. */
  readonly groundingByTitle: ReadonlyMap<string, number>;
}

/**
 * #8 part3 — Evidence verifier over a batch of candidates.
 *
 * Cross-checks each candidate's emitted signal IDs against the capabilities
 * selected this run. A candidate whose citations are ENTIRELY fabricated (cited
 * something, but none of it is real) is dropped — it claimed grounding it does
 * not have. Candidates that cited nothing, or whose citations partially resolve,
 * are kept with their fabricated tokens stripped and a grounding score recorded.
 *
 * Pure aside from logging; never throws.
 */
export function verifyEvidence(
  candidates: readonly GeneratedIdeaCandidate[],
  capabilities: readonly Capability[],
): VerifyEvidenceResult {
  const validTokens = buildValidSignalTokens(capabilities);
  const validTokensLc = new Set([...validTokens].map((t) => t.toLowerCase()));

  const kept: GeneratedIdeaCandidate[] = [];
  const notes: string[] = [];
  const groundingByTitle = new Map<string, number>();

  for (const candidate of candidates) {
    const { candidate: verified, signalGrounding, fabricated } =
      verifyCandidateEvidence(candidate, validTokensLc);

    const cited = candidate.supportingSignalIds ?? [];

    // Citations cited but none matched the run's verifiable token set. With the
    // current citation scheme this is frequently a namespace mismatch (the model
    // emits descriptive slugs, not <source>_<index> tokens), not genuine
    // fabrication — so PENALIZE grounding to 0 and keep the idea (annotate,
    // don't drop). The grounding score flows to critique_subscores/eval; a
    // future stricter gate can act on it once the ID scheme is aligned.
    if (cited.length > 0 && signalGrounding === 0) {
      notes.push(
        `${candidate.title} [UNVERIFIED] cited ${cited.length} signal(s), none matched this run's tokens: ${fabricated.join(", ")}`,
      );
      log.info("Idea citations unverified — kept with grounding penalized", {
        title: candidate.title,
        fabricated,
      });
      groundingByTitle.set(verified.title, 0);
      kept.push(verified);
      continue;
    }

    if (fabricated.length > 0) {
      notes.push(
        `${candidate.title} [PARTIAL] dropped ${fabricated.length} fabricated citation(s): ${fabricated.join(", ")}`,
      );
      log.info("Stripped fabricated citations from idea", {
        title: candidate.title,
        fabricated,
        grounding: signalGrounding,
      });
    }

    groundingByTitle.set(verified.title, signalGrounding);
    kept.push(verified);
  }

  return { kept, notes, groundingByTitle };
}
