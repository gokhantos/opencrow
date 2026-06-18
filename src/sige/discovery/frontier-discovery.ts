/**
 * Frontier discovery — the cheap, seedless breadth stage of autonomous SIGE.
 *
 * Runs Round-1 divergent generation over a broad signal corpus, clusters the
 * candidates into coarse "frontiers" via the SAME n-gram theme logic the ideas
 * pipeline uses for saturation (`extractThemesByNgrams`), and scores each
 * frontier by signal strength × novelty (Mem0 recall + saturation suppression).
 * The top frontiers receive the expensive depth game.
 *
 * Fault-tolerance is a hard requirement: every exported function degrades to an
 * empty/neutral result instead of throwing, so enabling autonomous SIGE can
 * never crash the SIGE process.
 *
 * Default-OFF invariant: this module is only reached on the autonomous run path,
 * which is gated behind `smart.sigeAuto.enabled` (default false).
 */

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { extractThemesByNgrams } from "../../pipelines/ideas/pipeline";
import type { CapabilityScan, ClusteredPains, TrendData } from "../../pipelines/ideas/types";
import { getDb } from "../../store/db";
import type { Mem0Client } from "../knowledge/mem0-client";
import { insightForge, quickSearch } from "../memory/retrieval-modes";
import { type DivergentCandidate, generateDivergentIdeas } from "../run";
import type { SigeSessionConfig } from "../types";

const log = createLogger("sige:discovery");

// ─── Constants ──────────────────────────────────────────────────────────────

/** Same 8000-char per-section slice as buildSignalsContext (pipeline.ts). */
const SECTION_SLICE = 8000;
/** Default cap on the broad divergent pool before clustering. */
const DEFAULT_BROAD_POOL_SIZE = 50;
/** Default cap on the number of frontiers emitted by clustering. */
const DEFAULT_MAX_FRONTIERS = 8;
/** A cluster must contain at least this many candidates to stand alone. */
const DEFAULT_MIN_CLUSTER_SIZE = 2;
/** Default rows scanned from generated_ideas for saturation theme extraction. */
const SATURATED_THEMES_LIMIT = 500;

// ─── Exported Interfaces ──────────────────────────────────────────────────────

export interface Frontier {
  readonly id: string;
  /** Human-readable cluster label (most representative theme phrase). */
  readonly theme: string;
  /** Normalized n-gram keys for saturation overlap. */
  readonly themeKeys: readonly string[];
  readonly candidates: readonly DivergentCandidate[];
  /** [0,1] — share of the broad pool this frontier captured. */
  readonly signalStrength: number;
  /** [0,1] — (1 - mem0Score) × (1 - saturationPenalty). */
  readonly novelty: number;
  /** signalStrength × novelty. */
  readonly score: number;
  /** Synthetic enrichedSeed text handed to the depth game for this frontier. */
  readonly seedText: string;
}

export interface BroadCorpus {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext?: string;
}

export interface DiscoveryResult {
  /** Flat broad pool (all Round-1 divergent candidates). */
  readonly candidates: readonly DivergentCandidate[];
  /** Frontiers ranked descending by score. */
  readonly frontiers: readonly Frontier[];
}

export interface FrontierScoringContext {
  readonly userId: string;
  readonly saturatedThemeKeys: readonly string[];
  /** When true, use the deeper (costlier) insightForge novelty probe. */
  readonly deepNovelty?: boolean;
  readonly signal?: AbortSignal;
}

export interface DiscoverFrontiersOptions {
  readonly broadPoolSize?: number;
  readonly maxDeepFrontiers?: number;
  readonly userId?: string;
  readonly config?: SigeSessionConfig;
  readonly deepNovelty?: boolean;
  readonly saturatedThemeKeys?: readonly string[];
  readonly signal?: AbortSignal;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Build the broad signals context for the divergent generation pass.
 *
 * PURE. Reuses the same `=== HEADING ===` block format and 8000-char per-section
 * slice as `buildSignalsContext` (pipeline.ts), but with NO LLM synthesis and NO
 * seed scoping — the full broad corpus is concatenated directly. This mirrors
 * how the ideas pipeline grounds its own divergent merge (it calls
 * buildSignalsContext directly, not signalsToPromptContext).
 */
export function buildBroadSignalsContext(corpus: BroadCorpus): string {
  const sections: string[] = [];
  const push = (heading: string, body: string | undefined): void => {
    const trimmed = (body ?? "").trim();
    if (trimmed.length > 0) {
      sections.push(`=== ${heading} ===\n${trimmed.slice(0, SECTION_SLICE)}`);
    }
  };
  push("TRENDS", corpus.trends.summary);
  push("PAIN POINTS", corpus.pains.summary);
  push("CAPABILITIES", corpus.capabilities.summary);
  push("DEEP-SEARCH EVIDENCE", corpus.deepSearchContext);
  return sections.join("\n\n");
}

/**
 * Tokenize a candidate title into normalized word tokens (>=3 chars), mirroring
 * the pipeline tokenizer so cluster keys overlap with saturation keys.
 */
function tokenizeTitle(title: string): readonly string[] {
  return title
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 3);
}

/**
 * Cluster broad candidates into frontiers by shared n-gram theme.
 *
 * PURE, deterministic and order-stable. Uses the EXPORTED `extractThemesByNgrams`
 * from the ideas pipeline to derive theme phrases over candidate titles, then
 * assigns each candidate to the first (highest-frequency) theme phrase whose
 * tokens it contains. Candidates matching no shared theme are grouped into a
 * residual "emerging" frontier only when they meet `minClusterSize`.
 *
 * Frontiers are returned WITHOUT novelty/score populated (signalStrength is set
 * from pool share; scoreFrontiers fills novelty + final score). Capped at
 * `maxFrontiers`.
 */
export function clusterIntoFrontiers(
  candidates: readonly DivergentCandidate[],
  opts?: { readonly maxFrontiers?: number; readonly minClusterSize?: number },
): readonly Frontier[] {
  const maxFrontiers = opts?.maxFrontiers ?? DEFAULT_MAX_FRONTIERS;
  const minClusterSize = Math.max(1, opts?.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);

  const usable = candidates.filter((c) => c.title.trim().length > 0);
  if (usable.length === 0) return [];

  // Derive theme phrases (ordered by frequency desc) over candidate titles.
  // extractThemesByNgrams returns formatted lines like:
  //   - "ai notes" theme (3 ideas) — e.g. ...
  // We recover the quoted phrase from each line, preserving its frequency order.
  const themeLines = extractThemesByNgrams(
    usable.map((c) => ({ title: c.title, summary: c.summary })),
  );
  const phrases: string[] = [];
  for (const line of themeLines) {
    const m = line.match(/"([^"]+)" theme/);
    const phrase = m?.[1]?.trim();
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }

  const total = usable.length;
  const assigned = new Set<number>();
  const frontiers: Frontier[] = [];

  for (const phrase of phrases) {
    if (frontiers.length >= maxFrontiers) break;
    const phraseTokens = phrase.split(/\s+/).filter((t) => t.length > 0);
    if (phraseTokens.length === 0) continue;

    const members: DivergentCandidate[] = [];
    for (let i = 0; i < usable.length; i++) {
      if (assigned.has(i)) continue;
      const candidate = usable[i]!;
      const tokens = new Set(tokenizeTitle(candidate.title));
      if (phraseTokens.every((t) => tokens.has(t))) {
        members.push(candidate);
        assigned.add(i);
      }
    }

    if (members.length >= minClusterSize) {
      frontiers.push(buildFrontier(phrase, phraseTokens, members, members.length / total));
    } else {
      // Under-sized: release members back to the residual pool.
      for (let i = 0; i < usable.length; i++) {
        if (members.includes(usable[i]!)) assigned.delete(i);
      }
    }
  }

  // Residual frontier for unclustered candidates (only if it meets the floor).
  if (frontiers.length < maxFrontiers) {
    const residual: DivergentCandidate[] = [];
    for (let i = 0; i < usable.length; i++) {
      if (!assigned.has(i)) residual.push(usable[i]!);
    }
    if (residual.length >= minClusterSize) {
      frontiers.push(buildFrontier("emerging", ["emerging"], residual, residual.length / total));
    }
  }

  return frontiers;
}

/** Assemble a Frontier with neutral novelty (scoreFrontiers refines it). PURE. */
function buildFrontier(
  theme: string,
  themeKeys: readonly string[],
  members: readonly DivergentCandidate[],
  signalStrength: number,
): Frontier {
  return {
    id: crypto.randomUUID(),
    theme,
    themeKeys,
    candidates: members,
    signalStrength: clamp01(signalStrength),
    novelty: 1,
    score: clamp01(signalStrength),
    seedText: buildFrontierSeedText(theme, members),
  };
}

/**
 * Build the synthetic enrichedSeed text for a frontier's depth game from its
 * theme label and representative candidate titles/summaries. PURE.
 */
function buildFrontierSeedText(theme: string, members: readonly DivergentCandidate[]): string {
  const examples = members
    .slice(0, 8)
    .map((c) => `- ${c.title.trim()}: ${c.summary.trim().slice(0, 200)}`)
    .join("\n");
  return [
    `Strategic frontier: ${theme}`,
    "",
    "Representative early signals from autonomous discovery:",
    examples,
  ].join("\n");
}

/**
 * Pure frontier score = signalStrength × clamp01((1 - mem0Score) ×
 * (1 - saturationPenalty)). Higher mem0 recall (idea already known) and higher
 * saturation both suppress the score. PURE.
 */
export function scoreFrontier(
  frontier: Frontier,
  novelty: { readonly mem0Score: number; readonly saturationPenalty: number },
): number {
  const noveltyFactor = clamp01(
    (1 - clamp01(novelty.mem0Score)) * (1 - clamp01(novelty.saturationPenalty)),
  );
  return clamp01(frontier.signalStrength) * noveltyFactor;
}

/**
 * Saturation penalty in [0,1] = fraction of a frontier's theme tokens that
 * appear in the already-saturated theme keys. PURE.
 */
function saturationPenalty(
  themeKeys: readonly string[],
  saturatedThemeKeys: readonly string[],
): number {
  if (themeKeys.length === 0) return 0;
  const saturated = new Set(saturatedThemeKeys.map((k) => k.toLowerCase()));
  if (saturated.size === 0) return 0;
  let hits = 0;
  for (const key of themeKeys) {
    if (saturated.has(key.toLowerCase())) hits++;
  }
  return clamp01(hits / themeKeys.length);
}

// ─── Mem0-backed scoring ──────────────────────────────────────────────────────

/**
 * Score frontiers by novelty (Mem0 recall + saturation suppression) and return
 * them sorted descending by score.
 *
 * Mem0 failure → neutral novelty=1 (no suppression, safe-broad default): a
 * frontier is never wrongly suppressed just because the memory service is down.
 * Never throws.
 */
export async function scoreFrontiers(
  frontiers: readonly Frontier[],
  mem0: Mem0Client,
  ctx: FrontierScoringContext,
): Promise<readonly Frontier[]> {
  const scored = await Promise.all(
    frontiers.map(async (frontier) => {
      let mem0Score = 0; // 0 = no recall = maximally novel (safe-broad)
      try {
        const probe = ctx.deepNovelty
          ? await insightForge(mem0, ctx.userId, frontier.theme)
          : await quickSearch(mem0, ctx.userId, frontier.theme);
        mem0Score = clamp01(probe.score);
      } catch (err) {
        log.warn("frontier novelty probe failed — neutral novelty", {
          theme: frontier.theme,
          err: getErrorMessage(err),
        });
        mem0Score = 0;
      }

      const penalty = saturationPenalty(frontier.themeKeys, ctx.saturatedThemeKeys);
      const novelty = clamp01((1 - mem0Score) * (1 - penalty));
      const score = scoreFrontier(frontier, {
        mem0Score,
        saturationPenalty: penalty,
      });
      return { ...frontier, novelty, score };
    }),
  );

  return [...scored].sort((a, b) => b.score - a.score);
}

/**
 * Read distinct n-gram theme keys from the recent `generated_ideas` corpus, so
 * frontier scoring can suppress already-saturated themes. Reuses the SAME
 * `extractThemesByNgrams` logic the pipeline uses (no parallel n-gram copy).
 *
 * Returns the bare quoted phrases (e.g. "ai notes"), NOT the formatted lines.
 * Returns [] on any error or empty table. Never throws.
 */
export async function extractSaturatedThemeKeys(
  limit: number = SATURATED_THEMES_LIMIT,
): Promise<readonly string[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT title, summary FROM generated_ideas
      WHERE pipeline_run_id IS NOT NULL
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as Array<{ title: string; summary: string }>;

    if (rows.length === 0) return [];

    const themeLines = extractThemesByNgrams(rows);
    const keys: string[] = [];
    for (const line of themeLines) {
      const m = line.match(/"([^"]+)" theme/);
      const phrase = m?.[1]?.trim();
      if (phrase && !keys.includes(phrase)) keys.push(phrase);
    }
    return keys;
  } catch (err) {
    log.warn("extractSaturatedThemeKeys failed — returning no saturated themes", {
      err: getErrorMessage(err),
    });
    return [];
  }
}

// ─── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Run the full cheap breadth stage: broad divergent generation → clustering →
 * novelty scoring. Returns the flat candidate pool plus frontiers ranked
 * descending by score.
 *
 * Fully fault-tolerant: any failure (LLM, Mem0, DB) is caught and yields an
 * empty {@link DiscoveryResult} so the caller can short-circuit cleanly. Never
 * throws.
 */
export async function discoverFrontiers(
  corpus: BroadCorpus,
  mem0: Mem0Client,
  opts: DiscoverFrontiersOptions = {},
): Promise<DiscoveryResult> {
  try {
    const broadPoolSize = opts.broadPoolSize ?? DEFAULT_BROAD_POOL_SIZE;
    const userId = opts.userId ?? "sige-global";

    const signalsContext = buildBroadSignalsContext(corpus);

    // generateDivergentIdeas is itself fault-tolerant (returns [] on failure).
    // Forward the configured mem0 client: without it the divergent path falls
    // back to an unreachable localhost Mem0 and silently generates the entire
    // broad pool against an EMPTY knowledge graph (degraded frontiers → the
    // run short-circuits as a no-op "completed").
    const candidates = await generateDivergentIdeas(signalsContext, {
      maxCandidates: broadPoolSize,
      userId,
      mem0,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const broadPool = candidates.slice(0, broadPoolSize);
    if (broadPool.length === 0) {
      log.info("discoverFrontiers: empty broad pool — no frontiers");
      return { candidates: [], frontiers: [] };
    }

    // Generate a small headroom above maxDeepFrontiers so scoreFrontiers has
    // enough candidates to rank before we slice to the caller's limit.
    // Cap at DEFAULT_MAX_FRONTIERS (8) as an absolute ceiling.
    // Previously: Math.max(maxDeepFrontiers, 8) — that forced 8× Mem0 probes
    // when maxDeepFrontiers=1, which is 8× the intended cost.
    const requestedDepth = opts.maxDeepFrontiers ?? 1;
    const clusterCap = Math.min(Math.max(requestedDepth, 3), DEFAULT_MAX_FRONTIERS);

    const clustered = clusterIntoFrontiers(broadPool, {
      maxFrontiers: clusterCap,
    });

    const saturatedThemeKeys = opts.saturatedThemeKeys ?? (await extractSaturatedThemeKeys());

    const frontiers = await scoreFrontiers(clustered, mem0, {
      userId,
      saturatedThemeKeys,
      ...(opts.deepNovelty !== undefined ? { deepNovelty: opts.deepNovelty } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    log.info("discoverFrontiers complete", {
      broadPool: broadPool.length,
      frontiers: frontiers.length,
    });

    return { candidates: broadPool, frontiers };
  } catch (err) {
    log.warn("discoverFrontiers failed — returning empty discovery result", {
      err: getErrorMessage(err),
    });
    return { candidates: [], frontiers: [] };
  }
}
