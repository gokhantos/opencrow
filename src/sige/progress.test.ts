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

// ─── 7. Inferred running substep: 0 rounds done → round_1 running ────────────
// (b) expert_game running with NO substep data at all → round_1 inferred running.

describe("deriveSessionProgress — inferred running substep (b): 0 rounds done → round_1", () => {
  const sessionCreatedAt = NOW_SEC - 200;
  const lastActivityAt = NOW_SEC - 10;

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "expert_game",
      origin: "human",
      createdAt: sessionCreatedAt,
      finishedAt: null,
      lastActivityAt,
      error: null,
    },
    // No expertRounds, no expertResultRounds, no tasteFilterAt
  });

  it("expert_game step is running", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.state).toBe("running");
  });

  it("round_1 substep is inferred running", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r1 = expertStep?.substeps.find((ss) => ss.key === "round_1");
    expect(r1?.state).toBe("running");
  });

  it("round_1 inferred running has a positive elapsedSec", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r1 = expertStep?.substeps.find((ss) => ss.key === "round_1");
    expect(r1?.elapsedSec).not.toBeNull();
    expect(r1?.elapsedSec!).toBeGreaterThan(0);
  });

  it("round_1 inferred running has startedAt set", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r1 = expertStep?.substeps.find((ss) => ss.key === "round_1");
    expect(r1?.startedAt).not.toBeNull();
  });

  it("round_1 inferred running has endedAt null", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r1 = expertStep?.substeps.find((ss) => ss.key === "round_1");
    expect(r1?.endedAt).toBeNull();
  });

  it("substeps round_2 through round_4 and taste_filter are waiting", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    for (const key of ["round_2", "taste_filter", "round_3", "round_4"]) {
      const ss = expertStep?.substeps.find((s) => s.key === key);
      expect(ss?.state).toBe("waiting");
    }
  });

  it("currentSubstep is round_1", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentSubstep).toBe("round_1");
  });
});

// ─── 8. Inferred running substep (a): 2 rounds done → taste_filter running ───
// (a) expert_game running, round_1+round_2 done (result rows exist), no taste_filter.
// The 3rd substep in order is taste_filter — it should be inferred running.

describe("deriveSessionProgress — inferred running substep (a): 2 rounds done → taste_filter", () => {
  const r1start = NOW_SEC - 400;
  const r1end = NOW_SEC - 350;
  const r2start = NOW_SEC - 340;
  const r2end = NOW_SEC - 280;

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "expert_game",
      origin: "human",
      createdAt: NOW_SEC - 500,
      finishedAt: null,
      lastActivityAt: r2end,
      error: null,
    },
    expertRounds: new Map([
      [1, { minAt: r1start, maxAt: r1end, actionCount: 5 }],
      [2, { minAt: r2start, maxAt: r2end, actionCount: 6 }],
    ]),
    expertResultRounds: new Map([
      [1, { createdAt: r1end }],
      [2, { createdAt: r2end }],
    ]),
    // tasteFilterAt is null — taste filter not yet recorded
  });

  it("round_1 substep is done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_1")?.state).toBe("done");
  });

  it("round_2 substep is done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_2")?.state).toBe("done");
  });

  it("taste_filter substep is inferred running (3rd in order, first non-done)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const tf = expertStep?.substeps.find((ss) => ss.key === "taste_filter");
    expect(tf?.state).toBe("running");
  });

  it("taste_filter inferred running has a positive elapsedSec", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const tf = expertStep?.substeps.find((ss) => ss.key === "taste_filter");
    expect(tf?.elapsedSec).not.toBeNull();
    expect(tf?.elapsedSec!).toBeGreaterThan(0);
  });

  it("taste_filter inferred startedAt is r2end (prior done substep's endedAt)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const tf = expertStep?.substeps.find((ss) => ss.key === "taste_filter");
    // startedAt should be r2end (the endedAt of the previous done substep round_2)
    expect(tf?.startedAt).toBe(r2end);
  });

  it("round_3 and round_4 are waiting", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_3")?.state).toBe("waiting");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_4")?.state).toBe("waiting");
  });

  it("currentSubstep is taste_filter", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentSubstep).toBe("taste_filter");
  });
});

// ─── 9. Inferred running substep (c): round_1+round_2+taste_filter done → round_3 ─

describe("deriveSessionProgress — inferred running substep (c): r1+r2+tf done → round_3", () => {
  const r1start = NOW_SEC - 600;
  const r1end = NOW_SEC - 550;
  const r2start = NOW_SEC - 540;
  const r2end = NOW_SEC - 480;
  const tfStart = NOW_SEC - 470;
  // taste_filter is "done" when round_3 has NOT yet started (tasteFilterAt set, r3 absent)
  // BUT we still need round_3 absent from expertRounds for the inferred path.

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "expert_game",
      origin: "human",
      createdAt: NOW_SEC - 700,
      finishedAt: null,
      lastActivityAt: tfStart,
      error: null,
    },
    expertRounds: new Map([
      [1, { minAt: r1start, maxAt: r1end, actionCount: 5 }],
      [2, { minAt: r2start, maxAt: r2end, actionCount: 6 }],
      // round_3 absent — not yet started
    ]),
    expertResultRounds: new Map([
      [1, { createdAt: r1end }],
      [2, { createdAt: r2end }],
    ]),
    tasteFilterAt: tfStart,
    // round_3 absent → taste_filter has no endedAt (r3?.minAt is null)
  });

  it("round_1, round_2, taste_filter are done", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_1")?.state).toBe("done");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_2")?.state).toBe("done");
    expect(expertStep?.substeps.find((ss) => ss.key === "taste_filter")?.state).toBe("done");
  });

  it("round_3 substep is inferred running", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r3 = expertStep?.substeps.find((ss) => ss.key === "round_3");
    expect(r3?.state).toBe("running");
  });

  it("round_3 inferred running has a positive elapsedSec", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    const r3 = expertStep?.substeps.find((ss) => ss.key === "round_3");
    expect(r3?.elapsedSec).not.toBeNull();
    expect(r3?.elapsedSec!).toBeGreaterThan(0);
  });

  it("round_4 is waiting", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    expect(expertStep?.substeps.find((ss) => ss.key === "round_4")?.state).toBe("waiting");
  });

  it("currentSubstep is round_3", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentSubstep).toBe("round_3");
  });
});

// ─── 10. Completed session: no inferred running (regression guard) ────────────
// (d) completed session — all steps done, no substep inferred running.

describe("deriveSessionProgress — inferred running: completed session unchanged (d)", () => {
  const finishedAt = NOW_SEC - 10;

  const raw = makeRaw({
    session: {
      id: SESSION_ID,
      status: "completed",
      origin: "human",
      createdAt: NOW_SEC - 1800,
      finishedAt,
      lastActivityAt: finishedAt,
      error: null,
    },
    expertRounds: new Map([
      [1, { minAt: NOW_SEC - 1600, maxAt: NOW_SEC - 1550, actionCount: 5 }],
      [2, { minAt: NOW_SEC - 1540, maxAt: NOW_SEC - 1480, actionCount: 6 }],
      [3, { minAt: NOW_SEC - 1200, maxAt: NOW_SEC - 1100, actionCount: 7 }],
      [4, { minAt: NOW_SEC - 1090, maxAt: NOW_SEC - 1000, actionCount: 4 }],
    ]),
    expertResultRounds: new Map([
      [1, { createdAt: NOW_SEC - 1550 }],
      [2, { createdAt: NOW_SEC - 1480 }],
      [3, { createdAt: NOW_SEC - 1100 }],
      [4, { createdAt: NOW_SEC - 1000 }],
    ]),
    tasteFilterAt: NOW_SEC - 1210,
    socialResultAt: NOW_SEC - 500,
  });

  it("all expert substeps are done (no inferred running in terminal session)", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    const expertStep = p.steps.find((s) => s.key === "expert_game");
    for (const ss of expertStep?.substeps ?? []) {
      expect(ss.state).toBe("done");
    }
  });

  it("no substep is running", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    for (const step of p.steps) {
      for (const ss of step.substeps) {
        expect(ss.state).not.toBe("running");
      }
    }
  });

  it("currentSubstep is null", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentSubstep).toBeNull();
  });

  it("currentStep is null", () => {
    const p = deriveSessionProgress(raw, NOW_SEC);
    expect(p.currentStep).toBeNull();
  });
});
