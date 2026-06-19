/**
 * Pure cross-run idea aggregation for the SIGE system.
 *
 * Given a list of raw DB rows (from `listRecentSessionsForAggregation`),
 * this module parses the JSON columns, de-duplicates ideas by (runId, ideaId)
 * keeping the highest round reached, joins fused scores, applies filters, and
 * returns a sorted, client-ready payload.
 *
 * Everything here is pure: no DB calls, no I/O. Safe to unit-test without a DB.
 */

import type {
  AggregatedIdea,
  RunSummary,
  ExpertGameResult,
  FusedScore,
  RoundType,
  IncentiveBreakdown,
} from "./types";
import type { AggregationSessionRow } from "./store";

// ─── Public Contract ──────────────────────────────────────────────────────────

export interface AggregateOpts {
  /** When true, only ideas with isFinal=true (a fused score) are returned. */
  readonly finalOnly?: boolean;
  /** Restrict to a single run by its session id. */
  readonly runId?: string;
  /**
   * Minimum score threshold. Applied against fusedScore when present,
   * otherwise against expertScore.
   */
  readonly minScore?: number;
}

export interface AggregateResult {
  readonly ideas: readonly AggregatedIdea[];
  /** One entry per unique run that contributed at least one idea (after filtering). */
  readonly runs: readonly RunSummary[];
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Parse a JSON string produced by Bun.sql (which may be null/undefined/empty).
 * Returns the parsed value on success, or `fallback` on any failure.
 * Never throws.
 */
function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Determine the effective score for filtering — fusedScore when present,
 * otherwise expertScore.
 */
function effectiveScore(idea: AggregatedIdea): number {
  return idea.fusedScore ?? idea.expertScore;
}

// ─── Key type for the dedup map ───────────────────────────────────────────────

type DedupeKey = `${string}::${string}`; // `${runId}::${ideaId}`

function dedupeKey(runId: string, ideaId: string): DedupeKey {
  return `${runId}::${ideaId}`;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Aggregate ideas from the provided session rows.
 *
 * Algorithm:
 * 1. For each session row, parse expertResultJson → SimulationRound[].
 * 2. Walk every round's `outcomes.selectedIdeas` (ScoredIdea[]).
 * 3. Track ideas in a Map keyed by (runId, ideaId). On collision, keep
 *    whichever entry has the higher `roundNumber` (and its scores).
 * 4. Build a FusedScore lookup Map keyed by (runId, ideaId) from fusedScoresJson.
 * 5. Merge fused scores → AggregatedIdea[].
 * 6. Apply opts filters.
 * 7. Sort by (fusedScore ?? expertScore) DESC.
 * 8. Derive RunSummary[] from the filtered ideas.
 */
export function aggregateIdeas(
  rows: readonly AggregationSessionRow[],
  opts: AggregateOpts = {},
): AggregateResult {
  // ── Step 1–3: build per-(run, idea) dedup map ────────────────────────────────

  interface DedupeEntry {
    readonly runId: string;
    readonly ideaId: string;
    readonly title: string;
    readonly description: string;
    readonly proposedBy: string;
    readonly round: number;
    readonly roundType: RoundType;
    readonly expertScore: number;
    readonly incentiveBreakdown: IncentiveBreakdown;
    readonly seedInput: string | null;
    readonly origin: string;
    readonly status: string;
    readonly createdAt: Date;
  }

  const dedupeMap = new Map<DedupeKey, DedupeEntry>();

  for (const row of rows) {
    const expertResult = safeParseJson<ExpertGameResult | null>(
      row.expertResultJson,
      null,
    );
    if (!expertResult || !Array.isArray(expertResult.rounds)) continue;

    for (const simRound of expertResult.rounds) {
      if (!simRound || typeof simRound !== "object") continue;

      const roundNumber: number =
        typeof simRound.roundNumber === "number" ? simRound.roundNumber : 0;
      const roundType: RoundType =
        typeof simRound.roundType === "string"
          ? (simRound.roundType as RoundType)
          : "divergent_generation";

      const outcomes = simRound.outcomes;
      if (!outcomes || !Array.isArray(outcomes.selectedIdeas)) continue;

      for (const idea of outcomes.selectedIdeas) {
        if (!idea || typeof idea !== "object") continue;

        const ideaId = typeof idea.id === "string" ? idea.id : undefined;
        if (!ideaId) continue;

        const title = typeof idea.title === "string" ? idea.title : "";
        const description =
          typeof idea.description === "string" ? idea.description : "";
        const proposedBy =
          typeof idea.proposedBy === "string" ? idea.proposedBy : "";
        const expertScore =
          typeof idea.expertScore === "number" ? idea.expertScore : 0;

        // incentiveBreakdown — tolerate missing/malformed, use zero defaults
        const rawBreakdown =
          idea.incentiveBreakdown &&
          typeof idea.incentiveBreakdown === "object"
            ? (idea.incentiveBreakdown as Record<string, unknown>)
            : {};

        const incentiveBreakdown: IncentiveBreakdown = {
          diversityBonus:
            typeof rawBreakdown.diversityBonus === "number"
              ? rawBreakdown.diversityBonus
              : 0,
          buildingBonus:
            typeof rawBreakdown.buildingBonus === "number"
              ? rawBreakdown.buildingBonus
              : 0,
          surpriseBonus:
            typeof rawBreakdown.surpriseBonus === "number"
              ? rawBreakdown.surpriseBonus
              : 0,
          accuracyPenalty:
            typeof rawBreakdown.accuracyPenalty === "number"
              ? rawBreakdown.accuracyPenalty
              : 0,
          memoryReward:
            typeof rawBreakdown.memoryReward === "number"
              ? rawBreakdown.memoryReward
              : 0,
          coalitionStability:
            typeof rawBreakdown.coalitionStability === "number"
              ? rawBreakdown.coalitionStability
              : 0,
          signalCredibility:
            typeof rawBreakdown.signalCredibility === "number"
              ? rawBreakdown.signalCredibility
              : 0,
          socialViability:
            typeof rawBreakdown.socialViability === "number"
              ? rawBreakdown.socialViability
              : 0,
        };

        const key = dedupeKey(row.id, ideaId);
        const existing = dedupeMap.get(key);

        // Keep highest round reached. On equal round keep higher expertScore.
        if (
          !existing ||
          roundNumber > existing.round ||
          (roundNumber === existing.round && expertScore > existing.expertScore)
        ) {
          dedupeMap.set(key, {
            runId: row.id,
            ideaId,
            title,
            description,
            proposedBy,
            round: roundNumber,
            roundType,
            expertScore,
            incentiveBreakdown,
            seedInput: row.seedInput,
            origin: row.origin,
            status: row.status,
            createdAt: row.createdAt,
          });
        }
      }
    }
  }

  // ── Step 4: build fused score lookup Map keyed by (runId, ideaId) ────────────

  // Map<DedupeKey, FusedScore>
  const fusedMap = new Map<DedupeKey, FusedScore>();

  for (const row of rows) {
    const fusedScores = safeParseJson<FusedScore[] | null>(
      row.fusedScoresJson,
      null,
    );
    if (!Array.isArray(fusedScores)) continue;

    for (const fs of fusedScores) {
      if (!fs || typeof fs !== "object") continue;
      const ideaId = typeof fs.ideaId === "string" ? fs.ideaId : undefined;
      if (!ideaId) continue;
      fusedMap.set(dedupeKey(row.id, ideaId), fs as FusedScore);
    }
  }

  // ── Step 5: merge fused scores into AggregatedIdea[] ─────────────────────────

  const allIdeas: AggregatedIdea[] = [];

  for (const entry of dedupeMap.values()) {
    const key = dedupeKey(entry.runId, entry.ideaId);
    const fused = fusedMap.get(key);

    const aggregated: AggregatedIdea = {
      ideaId: entry.ideaId,
      title: entry.title,
      description: entry.description,
      proposedBy: entry.proposedBy,
      round: entry.round,
      roundType: entry.roundType,
      expertScore: entry.expertScore,
      socialScore:
        fused !== undefined && typeof fused.socialScore === "number"
          ? fused.socialScore
          : null,
      fusedScore:
        fused !== undefined && typeof fused.fusedScore === "number"
          ? fused.fusedScore
          : null,
      isFinal: fused !== undefined,
      breakdown: fused !== undefined ? fused.breakdown : null,
      runId: entry.runId,
      runSeed: entry.seedInput,
      runOrigin: entry.origin as AggregatedIdea["runOrigin"],
      runStatus: entry.status as AggregatedIdea["runStatus"],
      runCreatedAt: entry.createdAt,
    };

    allIdeas.push(aggregated);
  }

  // ── Step 6: apply filters ─────────────────────────────────────────────────────

  const filtered = allIdeas.filter((idea) => {
    if (opts.finalOnly === true && !idea.isFinal) return false;
    if (opts.runId !== undefined && idea.runId !== opts.runId) return false;
    if (opts.minScore !== undefined && effectiveScore(idea) < opts.minScore)
      return false;
    return true;
  });

  // ── Step 7: sort by effective score DESC ──────────────────────────────────────

  const sorted = [...filtered].sort(
    (a, b) => effectiveScore(b) - effectiveScore(a),
  );

  // ── Step 8: derive RunSummary[] from filtered ideas ───────────────────────────

  // Count per runId using a Map for O(n) pass
  interface RunCounts {
    ideaCount: number;
    finalCount: number;
    row: AggregationSessionRow;
  }
  const runCounts = new Map<string, RunCounts>();

  // Pre-index rows by id for O(1) lookup
  const rowById = new Map<string, AggregationSessionRow>(
    rows.map((r) => [r.id, r]),
  );

  for (const idea of sorted) {
    const existing = runCounts.get(idea.runId);
    if (existing) {
      existing.ideaCount += 1;
      if (idea.isFinal) existing.finalCount += 1;
    } else {
      const row = rowById.get(idea.runId);
      if (!row) continue;
      runCounts.set(idea.runId, {
        ideaCount: 1,
        finalCount: idea.isFinal ? 1 : 0,
        row,
      });
    }
  }

  // Build RunSummary[] ordered by run createdAt DESC (matching the DB query order)
  const runs: RunSummary[] = Array.from(runCounts.values())
    .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime())
    .map(({ row, ideaCount, finalCount }) => ({
      runId: row.id,
      seed: row.seedInput,
      origin: row.origin as RunSummary["origin"],
      status: row.status as RunSummary["status"],
      createdAt: row.createdAt,
      ideaCount,
      finalCount,
    }));

  return { ideas: sorted, runs };
}
