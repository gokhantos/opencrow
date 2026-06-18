/**
 * Pure derivation of SessionProgress from raw DB data.
 *
 * This module is DB-free and side-effect-free so it can be unit-tested without
 * a database. The data-gathering lives in `getSessionProgressRaw` in store.ts;
 * this module receives the result and produces the API contract shape.
 */

import type { SigeSessionStatus } from "./types";
import type { SessionProgressRaw } from "./store";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Number of seconds of inactivity on a non-terminal session before we report
 * it as stalled. Default 5 minutes — tunable at the call site for tests.
 */
export const STALL_THRESHOLD_SEC = 300;

// ─── Output Types ─────────────────────────────────────────────────────────────

export type StepKey =
  | "knowledge_construction"
  | "game_formulation"
  | "expert_game"
  | "social_simulation"
  | "scoring"
  | "report_generation";

export type SubstepState = "waiting" | "running" | "done" | "error";
export type StepState = "waiting" | "running" | "done" | "error";

export interface SubstepProgress {
  readonly key: string;
  readonly label: string;
  readonly state: SubstepState;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly elapsedSec: number | null;
  readonly detail: string | null;
}

export interface StepProgress {
  readonly key: StepKey;
  readonly label: string;
  readonly state: StepState;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly elapsedSec: number | null;
  readonly substeps: readonly SubstepProgress[];
}

export interface SessionProgress {
  readonly sessionId: string;
  readonly status: SigeSessionStatus;
  readonly origin: "human" | "auto";
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly lastActivityAt: number | null;
  readonly totalElapsedSec: number;
  readonly stalled: boolean;
  readonly stalledForSec: number | null;
  readonly stalledReason: string | null;
  readonly currentStep: string | null;
  readonly currentSubstep: string | null;
  readonly error: string | null;
  readonly steps: readonly StepProgress[];
}

// ─── Step Ordering ─────────────────────────────────────────────────────────

const STEP_ORDER: readonly StepKey[] = [
  "knowledge_construction",
  "game_formulation",
  "expert_game",
  "social_simulation",
  "scoring",
  "report_generation",
];

const STEP_LABELS: Readonly<Record<StepKey, string>> = {
  knowledge_construction: "Knowledge Construction",
  game_formulation: "Game Formulation",
  expert_game: "Expert Game",
  social_simulation: "Social Simulation",
  scoring: "Scoring",
  report_generation: "Report Generation",
};

// Status → which step is currently running (non-terminal statuses).
// terminal statuses (completed/failed/cancelled) are handled separately.
const STATUS_TO_STEP: Readonly<Partial<Record<SigeSessionStatus, StepKey>>> = {
  knowledge_construction: "knowledge_construction",
  game_formulation: "game_formulation",
  expert_game: "expert_game",
  social_simulation: "social_simulation",
  scoring: "scoring",
  report_generation: "report_generation",
};

// Step is "done" if the session has advanced past it.
// We define "past" as: the current step's index > this step's index.
// For terminal statuses: all steps leading up to the terminal point are done.
function stepStateFromStatus(
  stepKey: StepKey,
  status: SigeSessionStatus,
): StepState {
  if (status === "failed") return "waiting"; // handled per-step below
  if (status === "cancelled") return "waiting";

  const currentStepKey = STATUS_TO_STEP[status];
  const stepIdx = STEP_ORDER.indexOf(stepKey);
  const currentIdx = currentStepKey !== undefined ? STEP_ORDER.indexOf(currentStepKey) : -1;

  if (status === "completed") return "done";
  if (currentIdx < 0) return "waiting"; // pending

  if (stepIdx < currentIdx) return "done";
  if (stepIdx === currentIdx) return "running";
  return "waiting";
}

// ─── Elapsed helpers ────────────────────────────────────────────────────────

function elapsedSec(startedAt: number | null, endedAt: number | null, nowSec: number): number | null {
  if (startedAt === null) return null;
  const end = endedAt ?? nowSec;
  return Math.max(0, end - startedAt);
}

// ─── Derive Substeps for Expert Game ─────────────────────────────────────────

function deriveExpertSubsteps(
  raw: SessionProgressRaw,
  expertGameState: StepState,
  expertStepStartedAt: number | null,
  nowSec: number,
): readonly SubstepProgress[] {
  // Expert game has 4 rounds + taste_filter (between rounds 2 and 3).
  // Substep key order: round_1, round_2, taste_filter, round_3, round_4.
  type SubstepSpec = { key: string; label: string; isTasteFilter?: boolean; round?: number };
  const specs: readonly SubstepSpec[] = [
    { key: "round_1", label: "Round 1: Divergent Generation", round: 1 },
    { key: "round_2", label: "Round 2: Strategic Interaction", round: 2 },
    { key: "taste_filter", label: "Taste Filter", isTasteFilter: true },
    { key: "round_3", label: "Round 3: Evolutionary Tournament", round: 3 },
    { key: "round_4", label: "Round 4: Equilibrium Analysis", round: 4 },
  ];

  if (expertGameState === "waiting") {
    return specs.map((s) => ({
      key: s.key,
      label: s.label,
      state: "waiting",
      startedAt: null,
      endedAt: null,
      elapsedSec: null,
      detail: null,
    }));
  }

  // Build raw substeps first (state based on real DB data only).
  const rawSubsteps = specs.map((spec): SubstepProgress => {
    if (spec.isTasteFilter === true) {
      const tf = raw.tasteFilterAt;
      if (tf === null) {
        // Not reached yet — waiting or done depends on whether round_3 has started.
        const r3 = raw.expertRounds.get(3);
        const state: SubstepState = r3 !== undefined ? "done" : "waiting";
        return { key: spec.key, label: spec.label, state, startedAt: null, endedAt: null, elapsedSec: null, detail: null };
      }
      // Taste filter completed (round 3 started = filter done).
      const r3 = raw.expertRounds.get(3);
      const endedAt = r3?.minAt ?? null;
      return {
        key: spec.key,
        label: spec.label,
        state: "done",
        startedAt: tf,
        endedAt,
        elapsedSec: endedAt !== null ? Math.max(0, endedAt - tf) : null,
        detail: null,
      };
    }

    // Normal round substep.
    const roundNum = spec.round as number;
    const roundData = raw.expertRounds.get(roundNum);
    const resultData = raw.expertResultRounds.get(roundNum);

    if (roundData === undefined) {
      // Not yet started.
      return { key: spec.key, label: spec.label, state: "waiting", startedAt: null, endedAt: null, elapsedSec: null, detail: null };
    }

    // Round has at least one action — either running or done.
    const isDone = resultData !== undefined;
    const startedAt = roundData.minAt;
    const endedAt = isDone ? resultData.createdAt : null;
    const elapsed = elapsedSec(startedAt, endedAt, nowSec);
    const count = raw.expertActionCount.get(roundNum) ?? roundData.actionCount;
    const detail = count > 0 ? `${count} action${count !== 1 ? "s" : ""}` : null;

    return {
      key: spec.key,
      label: spec.label,
      state: isDone ? "done" : "running",
      startedAt,
      endedAt,
      elapsedSec: elapsed,
      detail,
    };
  });

  // ── Infer running substep when parent stage is running ─────────────────────
  //
  // During a live expert_game, rounds only persist when they COMPLETE (via
  // saveAgentAction). So until a round writes its first DB row the substep is
  // "waiting" above. When the parent step is running and NO substep is already
  // "running" (per real data), we infer: the first substep that is NOT "done"
  // is the active one.
  if (expertGameState === "running") {
    const alreadyRunning = rawSubsteps.some((ss) => ss.state === "running");
    if (!alreadyRunning) {
      const firstNonDoneIdx = rawSubsteps.findIndex((ss) => ss.state !== "done");
      if (firstNonDoneIdx !== -1) {
        // Derive startedAt for the inferred running substep.
        // Use the endedAt of the previous done substep, falling back to the
        // expert step's startedAt, then lastActivityAt, then nowSec.
        const prevDoneSubstep = firstNonDoneIdx > 0 ? rawSubsteps[firstNonDoneIdx - 1] : undefined;
        const inferredStartedAt =
          prevDoneSubstep?.endedAt ??
          expertStepStartedAt ??
          raw.session.lastActivityAt ??
          nowSec;

        return rawSubsteps.map((ss, idx): SubstepProgress => {
          if (idx === firstNonDoneIdx) {
            return {
              ...ss,
              state: "running",
              startedAt: inferredStartedAt,
              endedAt: null,
              elapsedSec: Math.max(0, nowSec - inferredStartedAt),
            };
          }
          return ss;
        });
      }
    }
  }

  return rawSubsteps;
}

// ─── Derive Substeps for Social Simulation ───────────────────────────────────

function deriveSocialSubsteps(
  raw: SessionProgressRaw,
  socialState: StepState,
  socialStepStartedAt: number | null,
  nowSec: number,
): readonly SubstepProgress[] {
  // Social sim runs N rounds (socialRounds from config, typically 3).
  // We derive existence of rounds from expert action data — social sim doesn't
  // write per-round sige_agent_actions. Instead, a single sige_simulation_results
  // row with layer='social' is written at end. We have no per-round timestamps.
  // We show a single substep "social_simulation" that reflects the overall state.
  if (socialState === "waiting") {
    return [
      { key: "social_round_1", label: "Social Round 1", state: "waiting", startedAt: null, endedAt: null, elapsedSec: null, detail: null },
    ];
  }
  if (socialState === "done") {
    const endedAt = raw.socialResultAt;
    return [
      {
        key: "social_round_1",
        label: "Social Rounds",
        state: "done",
        startedAt: null,
        endedAt,
        elapsedSec: null,
        detail: "completed",
      },
    ];
  }
  // running — infer startedAt so the elapsed timer ticks
  const inferredStartedAt =
    socialStepStartedAt ?? raw.session.lastActivityAt ?? nowSec;
  return [
    {
      key: "social_round_1",
      label: "Social Rounds",
      state: "running",
      startedAt: inferredStartedAt,
      endedAt: null,
      elapsedSec: Math.max(0, nowSec - inferredStartedAt),
      detail: null,
    },
  ];
}

// ─── Step Timing From Status Progression ─────────────────────────────────────

// We don't have per-step start timestamps beyond what we can derive. We use:
// - createdAt as start of knowledge_construction
// - For terminal states: finishedAt as end of report_generation
// - Round timestamps from expert game
// - Social result timestamp
// For steps with no direct timing signal, we fall back to the prior step's
// endedAt or lastActivityAt so that running steps always show a live timer.

function deriveStepTiming(
  stepKey: StepKey,
  stepState: StepState,
  raw: SessionProgressRaw,
  nowSec: number,
  /**
   * The endedAt of the immediately preceding step (if known). Used as a
   * startedAt fallback for running steps that have no direct timing data.
   */
  priorStepEndedAt: number | null,
): { startedAt: number | null; endedAt: number | null; elapsedSec: number | null } {
  if (stepState === "waiting") {
    return { startedAt: null, endedAt: null, elapsedSec: null };
  }

  // For a running step with no direct start marker, fall back to:
  // prior step end → lastActivityAt → nowSec (no visible elapsed but timer starts)
  const runningFallbackStart: number | null =
    priorStepEndedAt ?? raw.session.lastActivityAt ?? null;

  switch (stepKey) {
    case "knowledge_construction": {
      const startedAt = raw.session.createdAt;
      const endedAt = stepState === "done" ? null : null; // no explicit end marker
      return {
        startedAt,
        endedAt,
        elapsedSec: stepState === "running" ? elapsedSec(startedAt, null, nowSec) : null,
      };
    }
    case "game_formulation": {
      // No direct timing — use fallback so running shows a live timer.
      const startedAt = stepState === "running" ? runningFallbackStart : null;
      return {
        startedAt,
        endedAt: null,
        elapsedSec: stepState === "running" ? elapsedSec(startedAt, null, nowSec) : null,
      };
    }
    case "expert_game": {
      const r1 = raw.expertRounds.get(1);
      const r4result = raw.expertResultRounds.get(4);
      // Use real round data if available; fall back to runningFallbackStart
      // so the timer ticks even before round_1 writes its first DB row.
      const startedAt = r1?.minAt ?? (stepState === "running" ? runningFallbackStart : null);
      const endedAt = r4result?.createdAt ?? null;
      return {
        startedAt,
        endedAt,
        elapsedSec: elapsedSec(startedAt, stepState === "done" ? endedAt : null, nowSec),
      };
    }
    case "social_simulation": {
      const endedAt = raw.socialResultAt;
      const startedAt = stepState === "running" ? runningFallbackStart : null;
      return {
        startedAt,
        endedAt,
        elapsedSec: stepState === "running" ? elapsedSec(startedAt, null, nowSec) : null,
      };
    }
    case "scoring":
    case "report_generation": {
      const endedAt =
        stepState === "done" && raw.session.finishedAt !== null ? raw.session.finishedAt : null;
      const startedAt = stepState === "running" ? runningFallbackStart : null;
      return {
        startedAt,
        endedAt,
        elapsedSec: stepState === "running" ? elapsedSec(startedAt, null, nowSec) : null,
      };
    }
  }
}

// ─── Main Pure Derivation ────────────────────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<SigeSessionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Pure function: derive the full SessionProgress from raw data + current time.
 *
 * @param raw    Result of `getSessionProgressRaw` from store.ts.
 * @param nowSec Current epoch seconds (injected so tests are deterministic).
 * @param stallThresholdSec Override the default 300 s stall threshold (for tests).
 */
export function deriveSessionProgress(
  raw: SessionProgressRaw,
  nowSec: number,
  stallThresholdSec: number = STALL_THRESHOLD_SEC,
): SessionProgress {
  const { session } = raw;
  const isTerminal = TERMINAL_STATUSES.has(session.status);
  const isErrored = session.status === "failed";

  // ── Stall detection ─────────────────────────────────────────────────────────
  const lastActivityAt = session.lastActivityAt;
  let stalled = false;
  let stalledForSec: number | null = null;
  let stalledReason: string | null = null;

  if (!isTerminal && lastActivityAt !== null) {
    const idleSec = nowSec - lastActivityAt;
    if (idleSec > stallThresholdSec) {
      stalled = true;
      stalledForSec = idleSec;
    }
  }

  // ── Build step list ─────────────────────────────────────────────────────────
  //
  // For failed sessions we do best-effort: look at which rounds completed (via
  // expertRounds / expertResultRounds) to infer the last good step, then mark
  // steps before it as "done", the probable last step as "error", and later
  // steps as "waiting". If no round data exists we mark all as "waiting".
  const failedAtStepKey: StepKey | null = (() => {
    if (!isErrored) return null;
    // If social result exists → failed at scoring or report_generation
    if (raw.socialResultAt !== null) return "scoring";
    // If round 4 result exists → expert game done, failed at social_simulation
    if (raw.expertResultRounds.get(4) !== undefined) return "social_simulation";
    // If any expert actions exist → failed during expert_game
    if (raw.expertRounds.size > 0) return "expert_game";
    // Otherwise failed early
    return "knowledge_construction";
  })();

  // Build steps sequentially so each step can receive the prior step's endedAt
  // as a timing fallback (for running steps with no direct start marker).
  const steps: StepProgress[] = [];
  let priorStepEndedAt: number | null = null;

  for (const stepKey of STEP_ORDER) {
    let state: StepState = stepStateFromStatus(stepKey, session.status);

    // For failed sessions: use the inferred failed-at step.
    if (isErrored && failedAtStepKey !== null) {
      const stepIdx = STEP_ORDER.indexOf(stepKey);
      const failedIdx = STEP_ORDER.indexOf(failedAtStepKey);
      if (stepIdx < failedIdx) state = "done";
      else if (stepIdx === failedIdx) state = "error";
      else state = "waiting";
    }

    const timing = deriveStepTiming(stepKey, state, raw, nowSec, priorStepEndedAt);
    let substeps: readonly SubstepProgress[] = [];

    if (stepKey === "expert_game") {
      substeps = deriveExpertSubsteps(raw, state, timing.startedAt, nowSec);
    } else if (stepKey === "social_simulation") {
      substeps = deriveSocialSubsteps(raw, state, timing.startedAt, nowSec);
    }

    steps.push({
      key: stepKey,
      label: STEP_LABELS[stepKey],
      state,
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
      elapsedSec: timing.elapsedSec,
      substeps,
    });

    // Carry forward endedAt so the next step can use it as a startedAt fallback.
    // For done steps that have a real endedAt, use it; otherwise keep the prior.
    if (state === "done" && timing.endedAt !== null) {
      priorStepEndedAt = timing.endedAt;
    } else if (state === "done" && timing.startedAt !== null) {
      // No explicit end marker but step is done — best we can do is keep prior.
      // Don't overwrite with null.
    }
  }

  // ── Current step / substep ──────────────────────────────────────────────────
  const runningStep = steps.find((s) => s.state === "running") ?? null;
  const currentStep = runningStep?.key ?? null;

  let currentSubstep: string | null = null;
  if (runningStep !== null) {
    const runningSubstep = runningStep.substeps.find((ss) => ss.state === "running") ?? null;
    currentSubstep = runningSubstep?.key ?? null;
  }

  // ── Stall reason ────────────────────────────────────────────────────────────
  if (stalled) {
    const idleMin = stalledForSec !== null ? Math.floor(stalledForSec / 60) : 0;
    const stepLabel = runningStep?.label ?? "unknown step";
    const substepLabel = currentSubstep !== null
      ? runningStep?.substeps.find((ss) => ss.key === currentSubstep)?.label ?? currentSubstep
      : null;
    const where = substepLabel !== null ? `${stepLabel} / ${substepLabel}` : stepLabel;
    stalledReason = `no activity for ${idleMin}m — likely a long LLM call in ${where}`;
  }

  // ── Total elapsed ───────────────────────────────────────────────────────────
  const totalElapsedSec = Math.max(
    0,
    (session.finishedAt ?? nowSec) - session.createdAt,
  );

  return {
    sessionId: session.id,
    status: session.status,
    origin: session.origin,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt,
    lastActivityAt,
    totalElapsedSec,
    stalled,
    stalledForSec,
    stalledReason,
    currentStep,
    currentSubstep,
    error: session.error,
    steps,
  };
}
