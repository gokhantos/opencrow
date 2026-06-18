/**
 * Unit tests for src/sige/progress.ts — deriveSessionProgress.
 *
 * Pure function: no DB, no network. Tests the key behavioural cases:
 *   1. Fresh pending run (no activity yet)
 *   2. Mid-expert-game: 2 rounds done, round 3 running
 *   3. Stalled run (old lastActivityAt → stalled=true with reason)
 *   4. Terminal: completed (no stall, all done)
 *   5. Terminal: failed (error surfaced, no stall)
 */
import { describe, it, expect } from "bun:test";
import { deriveSessionProgress, STALL_THRESHOLD_SEC } from "./progress";
import type { SessionProgressRaw } from "./store";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const NOW_SEC = 1_700_000_000;
const SESSION_ID = "test-session-123";

function makeRaw(overrides: Partial<SessionProgressRaw> = {}): SessionProgressRaw {
  return {
    session: {
      id: SESSION_ID,
      status: "pending",
      origin: "human",
      createdAt: NOW_SEC - 60,
      finishedAt: null,
      lastActivityAt: null,
      error: null,
    },
    expertRounds: new Map(),
    expertResultRounds: new Map(),
    tasteFilterAt: null,
    socialResultAt: null,
    expertActionCount: new Map(),
    ...overrides,
  };
}

// ─── 1. Fresh pending run ─────────────────────────────────────────────────────

describe("deriveSessionProgress — fresh pending run", () => {
  it("returns status=pending", () => {
    const progress = deriveSessionProgress(makeRaw(), NOW_SEC);
    expect(progress.status).toBe("pending");
  });

  it("all steps are waiting", () => {
    const progress = deriveSessionProgress(makeRaw(), NOW_SEC);
    for (const step of progress.steps) {
      expect(step.state).toBe("waiting");
    }
  });

  it("currentStep and currentSubstep are null", () => {
    const progress = deriveSessionProgress(makeRaw(), NOW_SEC);
    expect(progress.currentStep).toBeNull();
    expect(progress.currentSubstep).toBeNull();
  });

  it("stalled is false (no activity yet — can't report stall without lastActivityAt)", () => {
    const progress = deriveSessionProgress(makeRaw(), NOW_SEC);
    expect(progress.stalled).toBe(false);
    expect(progress.stalledForSec).toBeNull();
    expect(progress.stalledReason).toBeNull();
  });

  it("totalElapsedSec is around session age", () => {
    const progress = deriveSessionProgress(makeRaw(), NOW_SEC);
    expect(progress.totalElapsedSec).toBeGreaterThanOrEqual(0);
  });

  it("sessionId is correct", () => {
    const progress = deriveSessionProgress(makeRaw(), NOW_SEC);
    expect(progress.sessionId).toBe(SESSION_ID);
  });
});

// ─── 2. Mid-expert-game: rounds 1+2 done, round 3 running ────────────────────

describe("deriveSessionProgress — mid-expert-game (2 rounds done, 3 running)", () => {
  const r1start = NOW_SEC - 300;
  const r1end = NOW_SEC - 240;
  const r2start = NOW_SEC - 220;
  const r2end = NOW_SEC - 160;
  const r3start = NOW_SEC - 140;

  const expertRounds = new Map([
    [1, { minAt: r1start, maxAt: r1end, actionCount: 5 }],
    [2, { minAt: r2start, maxAt: r2end, actionCount: 7 }],
    [3, { minAt: r3start, maxAt: r3start + 5, actionCount: 2 }],
  ]);
  const expertResultRounds = new Map([
    [1, { createdAt: r1end }],
    [2, { createdAt: r2end }],
  ]);

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "expert_game",
      origin: "human",
      createdAt: NOW_SEC - 400,
      finishedAt: null,
      lastActivityAt: NOW_SEC - 30,
      error: null,
    },
    expertRounds,
    expertResultRounds,
    tasteFilterAt: r3start, // round 3 started = taste filter done
    socialResultAt: null,
    expertActionCount: new Map([
      [1, 5],
      [2, 7],
      [3, 2],
    ]),
  });

  it("status is expert_game", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.status).toBe("expert_game");
  });

  it("expert_game step is running", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.state).toBe("running");
  });

  it("knowledge_construction and game_formulation are done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const kc = p.steps.find((s) => s.key === "knowledge_construction");
    const gf = p.steps.find((s) => s.key === "game_formulation");
    expect(kc?.state).toBe("done");
    expect(gf?.state).toBe("done");
  });

  it("social_simulation, scoring, report_generation are waiting", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    for (const key of ["social_simulation", "scoring", "report_generation"] as const) {
      const step = p.steps.find((s) => s.key === key);
      expect(step?.state).toBe("waiting");
    }
  });

  it("round_1 substep is done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r1 = expertStep?.substeps.find((ss) => ss.key === "round_1");
    expect(r1?.state).toBe("done");
    expect(r1?.startedAt).toBe(r1start);
    expect(r1?.endedAt).toBe(r1end);
  });

  it("round_2 substep is done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r2 = expertStep?.substeps.find((ss) => ss.key === "round_2");
    expect(r2?.state).toBe("done");
  });

  it("taste_filter substep is done (round 3 started)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const tf = expertStep?.substeps.find((ss) => ss.key === "taste_filter");
    expect(tf?.state).toBe("done");
  });

  it("round_3 substep is running", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r3 = expertStep?.substeps.find((ss) => ss.key === "round_3");
    expect(r3?.state).toBe("running");
  });

  it("round_4 substep is waiting", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r4 = expertStep?.substeps.find((ss) => ss.key === "round_4");
    expect(r4?.state).toBe("waiting");
  });

  it("currentStep is expert_game", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentStep).toBe("expert_game");
  });

  it("currentSubstep is round_3", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentSubstep).toBe("round_3");
  });

  it("stalled is false (lastActivityAt recent)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.stalled).toBe(false);
  });
});

// ─── 3. Stalled run ───────────────────────────────────────────────────────────

describe("deriveSessionProgress — stalled run", () => {
  const STALE_LAST_ACTIVITY = NOW_SEC - (STALL_THRESHOLD_SEC + 120); // 7 minutes ago

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "expert_game",
      origin: "human",
      createdAt: NOW_SEC - 600,
      finishedAt: null,
      lastActivityAt: STALE_LAST_ACTIVITY,
      error: null,
    },
    expertRounds: new Map([
      [1, { minAt: NOW_SEC - 580, maxAt: NOW_SEC - 530, actionCount: 5 }],
      [2, { minAt: NOW_SEC - 520, maxAt: NOW_SEC - STALE_LAST_ACTIVITY, actionCount: 3 }],
    ]),
    expertResultRounds: new Map([
      [1, { createdAt: NOW_SEC - 530 }],
    ]),
    tasteFilterAt: null,
    socialResultAt: null,
    expertActionCount: new Map([[1, 5], [2, 3]]),
  });

  it("stalled is true", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.stalled).toBe(true);
  });

  it("stalledForSec is greater than threshold", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.stalledForSec).not.toBeNull();
    expect(p.stalledForSec!).toBeGreaterThan(STALL_THRESHOLD_SEC);
  });

  it("stalledReason is a non-empty string mentioning the step", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.stalledReason).not.toBeNull();
    expect(typeof p.stalledReason).toBe("string");
    expect(p.stalledReason!.length).toBeGreaterThan(0);
    // Should mention expert game or a round
    expect(p.stalledReason!).toMatch(/expert/i);
  });

  it("uses custom stallThresholdSec when provided", () => {
    // With a very high threshold, same session is NOT stalled.
    const pHigh = deriveSessionProgress(raw, NOW_SEC, 3600);
    expect(pHigh.stalled).toBe(false);

    // With a very low threshold (1 s), same session IS stalled.
    const pLow = deriveSessionProgress(raw, NOW_SEC, 1);
    expect(pLow.stalled).toBe(true);
  });
});

// ─── 4. Terminal: completed ───────────────────────────────────────────────────

describe("deriveSessionProgress — completed session", () => {
  const finishedAt = NOW_SEC - 10;

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "completed",
      origin: "auto",
      createdAt: NOW_SEC - 1800,
      finishedAt,
      lastActivityAt: finishedAt,
      error: null,
    },
  });

  it("status is completed", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.status).toBe("completed");
  });

  it("all steps are done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    for (const step of p.steps) {
      expect(step.state).toBe("done");
    }
  });

  it("stalled is false for terminal session", () => {
    // Even with very old lastActivityAt, terminal sessions are never stalled.
    const oldActivityRaw = makeRaw({
      session: {
        id: SESSION_ID,
        status: "completed",
        origin: "human",
        createdAt: NOW_SEC - 1800,
        finishedAt,
        lastActivityAt: NOW_SEC - 10000, // very stale
        error: null,
      },
    });
    const p = deriveSessionProgress(oldActivityRaw, NOW_SEC);
    expect(p.stalled).toBe(false);
  });

  it("finishedAt is included in output", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.finishedAt).toBe(finishedAt);
  });

  it("currentStep is null for terminal session", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentStep).toBeNull();
  });

  it("totalElapsedSec uses finishedAt − createdAt", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.totalElapsedSec).toBe(finishedAt - (NOW_SEC - 1800));
  });
});

// ─── 5. Terminal: failed ──────────────────────────────────────────────────────

describe("deriveSessionProgress — failed session", () => {
  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "failed",
      origin: "human",
      createdAt: NOW_SEC - 500,
      finishedAt: null,
      lastActivityAt: NOW_SEC - 400,
      error: "Expert game simulation aborted",
    },
  });

  it("status is failed", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.status).toBe("failed");
  });

  it("error field is surfaced", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.error).toBe("Expert game simulation aborted");
  });

  it("stalled is false (terminal)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.stalled).toBe(false);
  });

  it("steps array has correct length (6 steps)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.steps.length).toBe(6);
  });
});

// ─── 6. Step order and labels ──────────────────────────────────────────────────

describe("deriveSessionProgress — step ordering and labels", () => {
  it("returns steps in canonical pipeline order", () => {
    const p = deriveSessionProgress(makeRaw(), NOW_SEC);
    const keys = p.steps.map((s) => s.key);
    expect(keys).toEqual([
      "knowledge_construction",
      "game_formulation",
      "expert_game",
      "social_simulation",
      "scoring",
      "report_generation",
    ]);
  });

  it("all steps have non-empty labels", () => {
    const p = deriveSessionProgress(makeRaw(), NOW_SEC);
    for (const step of p.steps) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("expert_game has 5 substeps", () => {
    const raw = makeRaw({
      session: {
        id: SESSION_ID,
        status: "expert_game",
        origin: "human",
        createdAt: NOW_SEC - 100,
        finishedAt: null,
        lastActivityAt: NOW_SEC - 5,
        error: null,
      },
    });
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.substeps.length).toBe(5);
  });
});
