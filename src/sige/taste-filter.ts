import { chat } from "../agent/chat";
import type { ConversationMessage } from "../agent/types";
import { createLogger } from "../logger";
import type { ScoredIdea } from "./types";

const log = createLogger("sige:taste-filter");

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface TasteFilterResult {
  readonly passed: readonly ScoredIdea[];
  readonly eliminated: readonly EliminatedIdea[];
  readonly filterStats: FilterStats;
}

export interface EliminatedIdea {
  readonly idea: ScoredIdea;
  readonly reason: string;
  readonly failedCriteria: readonly string[];
}

export interface FilterStats {
  readonly totalInput: number;
  readonly totalPassed: number;
  readonly totalEliminated: number;
  readonly avgSpecificityScore: number;
  readonly avgSignalGroundingScore: number;
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface IdeaScores {
  readonly specificity: number;
  readonly signalGrounding: number;
  readonly differentiation: number;
  readonly buildability: number;
}

interface RawIdeaVerdict {
  id?: unknown;
  specificity?: unknown;
  signal_grounding?: unknown;
  differentiation?: unknown;
  buildability?: unknown;
  pass?: unknown;
  reason?: unknown;
  failed_criteria?: unknown;
}

interface RawFilterResponse {
  verdicts?: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a ruthless quality filter for product ideas. Your job is NOT to be encouraging — it's to kill mediocre ideas so only the genuinely promising ones survive. You have extremely high standards.";

const PASS_THRESHOLD = 0.6;
const FLOOR_SCORE = 0.2;
const DEFAULT_MIN_PASS_COUNT = 5;

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildUserPrompt(ideas: readonly ScoredIdea[], enrichedSeed: string): string {
  const ideaList = ideas
    .map((idea, i) => `${i + 1}. ID: ${idea.id}\n   Title: ${idea.title}\n   Description: ${idea.description}`)
    .join("\n\n");

  return `Evaluate product ideas generated from a data briefing. Eliminate the generic, obvious, and vague.

## Data Briefing (cross-reference this when scoring signal_grounding)
${enrichedSeed}

## Ideas to Evaluate
${ideaList}

## Scoring Criteria (0.0–1.0)
- **specificity**: Concrete product (0.9) vs vague category like "An AI tool for X" (0.1)
- **signal_grounding**: Directly addresses data in briefing (0.9) vs generic idea anyone could propose (0.1)
- **differentiation**: Structurally different from what exists (0.8) vs "better version of X" (0.1)
- **buildability**: MVP shippable in 4–8 weeks with existing APIs (0.9) vs needs major partnerships/regulatory approval (0.2)

Pass if average >= 0.6 AND no single score <= 0.2. For failures list which criteria failed and why.

Return ONLY valid JSON:
{
  "verdicts": [
    { "id": "<idea id>", "specificity": 0.0, "signal_grounding": 0.0, "differentiation": 0.0, "buildability": 0.0, "pass": true, "reason": "brief explanation", "failed_criteria": [] }
  ]
}`;
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJson(text: string): RawFilterResponse {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as RawFilterResponse;
  } catch {
    // fall through
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as RawFilterResponse;
    } catch {
      // fall through
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as RawFilterResponse;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Unable to extract JSON from taste filter response. Preview: ${trimmed.slice(0, 300)}`,
  );
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

function toScore(value: unknown): number {
  if (typeof value === "number" && !isNaN(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return 0;
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseVerdict(raw: unknown): { id: string; scores: IdeaScores; pass: boolean; reason: string; failedCriteria: readonly string[] } | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as RawIdeaVerdict;

  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : null;
  if (!id) return null;

  const scores: IdeaScores = {
    specificity: toScore(obj.specificity),
    signalGrounding: toScore(obj.signal_grounding),
    differentiation: toScore(obj.differentiation),
    buildability: toScore(obj.buildability),
  };

  const pass = typeof obj.pass === "boolean" ? obj.pass : false;
  const reason = typeof obj.reason === "string" ? obj.reason : "No reason provided";
  const failedCriteria = toStringArray(obj.failed_criteria);

  return { id, scores, pass, reason, failedCriteria };
}

// ─── Filtering Logic ──────────────────────────────────────────────────────────

function avgScore(scores: IdeaScores): number {
  return (scores.specificity + scores.signalGrounding + scores.differentiation + scores.buildability) / 4;
}

function hasFloorFailure(scores: IdeaScores): boolean {
  return (
    scores.specificity <= FLOOR_SCORE ||
    scores.signalGrounding <= FLOOR_SCORE ||
    scores.differentiation <= FLOOR_SCORE ||
    scores.buildability <= FLOOR_SCORE
  );
}

function floorFailedCriteria(scores: IdeaScores): readonly string[] {
  const failed: string[] = [];
  if (scores.specificity <= FLOOR_SCORE) failed.push("specificity");
  if (scores.signalGrounding <= FLOOR_SCORE) failed.push("signal_grounding");
  if (scores.differentiation <= FLOOR_SCORE) failed.push("differentiation");
  if (scores.buildability <= FLOOR_SCORE) failed.push("buildability");
  return failed;
}

interface ScoredIdeaWithAvg {
  readonly idea: ScoredIdea;
  readonly avg: number;
  readonly scores: IdeaScores;
  readonly passed: boolean;
  readonly reason: string;
  readonly failedCriteria: readonly string[];
}

function applyMinPassCount(
  scoredWithAvg: readonly ScoredIdeaWithAvg[],
  minPassCount: number,
): readonly ScoredIdeaWithAvg[] {
  const passed = scoredWithAvg.filter((s) => s.passed);
  if (passed.length >= minPassCount) return scoredWithAvg;

  // Promote the top N by average score until minPassCount is met
  const failed = scoredWithAvg.filter((s) => !s.passed).slice().sort((a, b) => b.avg - a.avg);
  const needed = minPassCount - passed.length;
  const promoted = new Set(failed.slice(0, needed).map((s) => s.idea.id));

  return scoredWithAvg.map((s) => {
    if (s.passed || !promoted.has(s.idea.id)) return s;
    return { ...s, passed: true, reason: `Promoted to meet minimum pass count (avg: ${s.avg.toFixed(2)})`, failedCriteria: [] };
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function computeStats(
  total: number,
  scoredWithAvg: readonly ScoredIdeaWithAvg[],
): FilterStats {
  const passed = scoredWithAvg.filter((s) => s.passed);
  const eliminated = scoredWithAvg.filter((s) => !s.passed);

  const avgSpecificity =
    scoredWithAvg.length > 0
      ? scoredWithAvg.reduce((sum, s) => sum + s.scores.specificity, 0) / scoredWithAvg.length
      : 0;

  const avgSignalGrounding =
    scoredWithAvg.length > 0
      ? scoredWithAvg.reduce((sum, s) => sum + s.scores.signalGrounding, 0) / scoredWithAvg.length
      : 0;

  return {
    totalInput: total,
    totalPassed: passed.length,
    totalEliminated: eliminated.length,
    avgSpecificityScore: Math.round(avgSpecificity * 100) / 100,
    avgSignalGroundingScore: Math.round(avgSignalGrounding * 100) / 100,
  };
}

// ─── Public: runTasteFilter ───────────────────────────────────────────────────

export async function runTasteFilter(params: {
  readonly ideas: readonly ScoredIdea[];
  readonly enrichedSeed: string;
  readonly model: string;
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba";
  readonly minPassCount?: number;
}): Promise<TasteFilterResult> {
  const { ideas, enrichedSeed, model, provider = "alibaba" } = params;
  const minPassCount = params.minPassCount ?? DEFAULT_MIN_PASS_COUNT;

  log.info("Running taste filter", { ideaCount: ideas.length, model, provider, minPassCount });

  if (ideas.length === 0) {
    return {
      passed: [],
      eliminated: [],
      filterStats: { totalInput: 0, totalPassed: 0, totalEliminated: 0, avgSpecificityScore: 0, avgSignalGroundingScore: 0 },
    };
  }

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: buildUserPrompt(ideas, enrichedSeed),
      timestamp: Date.now(),
    },
  ];

  let responseText: string;
  try {
    const response = await chat(messages, { systemPrompt: SYSTEM_PROMPT, model, provider });
    responseText = response.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("LLM call failed in taste filter", { err });
    throw new Error(`Taste filter LLM call failed: ${msg}`);
  }

  if (!responseText.trim()) {
    throw new Error("Taste filter returned an empty response from the LLM");
  }

  let raw: RawFilterResponse;
  try {
    raw = extractJson(responseText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to parse taste filter JSON", { err, responsePreview: responseText.slice(0, 300) });
    throw new Error(`Failed to parse taste filter JSON: ${msg}`);
  }

  // Build a lookup from the LLM verdicts by idea id
  const verdictMap = new Map<string, { scores: IdeaScores; pass: boolean; reason: string; failedCriteria: readonly string[] }>();
  if (Array.isArray(raw.verdicts)) {
    for (const rawVerdict of raw.verdicts as unknown[]) {
      const parsed = parseVerdict(rawVerdict);
      if (parsed) {
        verdictMap.set(parsed.id, {
          scores: parsed.scores,
          pass: parsed.pass,
          reason: parsed.reason,
          failedCriteria: parsed.failedCriteria,
        });
      }
    }
  }

  // Apply deterministic filtering rules on top of LLM verdicts
  const scoredWithAvg: ScoredIdeaWithAvg[] = ideas.map((idea) => {
    const verdict = verdictMap.get(idea.id);

    if (!verdict) {
      log.warn("No verdict found for idea, marking as eliminated", { ideaId: idea.id });
      return {
        idea,
        avg: 0,
        scores: { specificity: 0, signalGrounding: 0, differentiation: 0, buildability: 0 },
        passed: false,
        reason: "No verdict returned by filter LLM",
        failedCriteria: ["specificity", "signal_grounding", "differentiation", "buildability"],
      };
    }

    const avg = avgScore(verdict.scores);
    const floorFail = hasFloorFailure(verdict.scores);

    let passed: boolean;
    let reason: string;
    let failedCriteria: readonly string[];

    if (floorFail) {
      passed = false;
      failedCriteria = floorFailedCriteria(verdict.scores);
      reason = verdict.reason || `Floor score failure on: ${failedCriteria.join(", ")}`;
    } else if (avg < PASS_THRESHOLD) {
      passed = false;
      failedCriteria = verdict.failedCriteria.length > 0 ? verdict.failedCriteria : ["avg_score_below_threshold"];
      reason = verdict.reason || `Average score ${avg.toFixed(2)} below threshold ${PASS_THRESHOLD}`;
    } else {
      passed = true;
      failedCriteria = [];
      reason = verdict.reason;
    }

    return { idea, avg, scores: verdict.scores, passed, reason, failedCriteria };
  });

  // Enforce minimum pass count
  const finalScored = applyMinPassCount(scoredWithAvg, minPassCount);

  // Separate into passed / eliminated
  const passedSorted = finalScored
    .filter((s) => s.passed)
    .sort((a, b) => b.avg - a.avg)
    .map((s) => s.idea);

  const eliminatedIdeas: EliminatedIdea[] = finalScored
    .filter((s) => !s.passed)
    .map((s) => ({ idea: s.idea, reason: s.reason, failedCriteria: s.failedCriteria }));

  const filterStats = computeStats(ideas.length, finalScored);

  log.info("Taste filter complete", {
    totalInput: filterStats.totalInput,
    totalPassed: filterStats.totalPassed,
    totalEliminated: filterStats.totalEliminated,
    avgSpecificity: filterStats.avgSpecificityScore,
    avgSignalGrounding: filterStats.avgSignalGroundingScore,
  });

  return { passed: passedSorted, eliminated: eliminatedIdeas, filterStats };
}
