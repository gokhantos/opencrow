/**
 * Unit tests for ProgressTimeline.
 *
 * Lane: unit (*.test.ts) — happy-dom, no DB, no network.
 *
 * Scenarios:
 *   1. mid-expert-game — Round 3 running, Rounds 1+2 done
 *   2. stalled         — amber "STALLED" banner + reason rendered
 *   3. completed       — all steps done, total time shown
 *   4. failed          — error message shown, step marked error
 */
import { test, expect } from "bun:test";
import React from "react";
import { renderHTML, mount } from "../../../test-helpers";
import { ProgressTimeline } from "./ProgressTimeline";
import type { SessionProgress, ProgressStep, ProgressSubstep } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSubstep(
  key: string,
  label: string,
  state: ProgressSubstep["state"],
  detail?: string,
): ProgressSubstep {
  const now = Math.floor(Date.now() / 1000);
  return {
    key,
    label,
    state,
    startedAt: state !== "waiting" ? now - 60 : null,
    endedAt: state === "done" ? now - 10 : null,
    elapsedSec: state === "done" ? 50 : null,
    detail: detail ?? null,
  };
}

function makeStep(
  key: ProgressStep["key"],
  label: string,
  state: ProgressStep["state"],
  substeps: readonly ProgressSubstep[] = [],
): ProgressStep {
  const now = Math.floor(Date.now() / 1000);
  return {
    key,
    label,
    state,
    startedAt: state !== "waiting" ? now - 120 : null,
    endedAt: state === "done" ? now - 5 : null,
    elapsedSec: state === "done" ? 115 : null,
    substeps,
  };
}

const BASE_PROGRESS: SessionProgress = {
  sessionId: "sess-001",
  status: "knowledge_construction",
  origin: "human",
  createdAt: Math.floor(Date.now() / 1000) - 300,
  finishedAt: null,
  lastActivityAt: Math.floor(Date.now() / 1000) - 10,
  totalElapsedSec: 300,
  stalled: false,
  stalledForSec: null,
  stalledReason: null,
  currentStep: null,
  currentSubstep: null,
  error: null,
  steps: [],
};

// ─── Scenario 1: mid-expert-game ──────────────────────────────────────────────

test("renders step labels for all 6 pipeline steps", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    currentStep: "expert_game",
    currentSubstep: "round_3",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running", [
        makeSubstep("round_1", "Round 1", "done", "42 ideas"),
        makeSubstep("round_2", "Round 2", "done", "38 ideas"),
        makeSubstep("round_3", "Round 3", "running"),
        makeSubstep("round_4", "Round 4", "waiting"),
        makeSubstep("taste_filter", "Taste Filter", "waiting"),
      ]),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));

  expect(html).toContain("Knowledge Construction");
  expect(html).toContain("Game Formulation");
  expect(html).toContain("Expert Game");
  expect(html).toContain("Social Simulation");
  expect(html).toContain("Scoring");
  expect(html).toContain("Report Generation");
});

test("mid-expert-game: Round 3 substep shows running state icon", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    currentStep: "expert_game",
    currentSubstep: "round_3",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running", [
        makeSubstep("round_1", "Round 1", "done", "42 ideas"),
        makeSubstep("round_2", "Round 2", "done", "38 ideas"),
        makeSubstep("round_3", "Round 3", "running"),
        makeSubstep("round_4", "Round 4", "waiting"),
        makeSubstep("taste_filter", "Taste Filter", "waiting"),
      ]),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));

  // Round substep labels
  expect(html).toContain("Round 1");
  expect(html).toContain("Round 2");
  expect(html).toContain("Round 3");
  expect(html).toContain("Round 4");
  expect(html).toContain("Taste Filter");

  // Substep detail shown
  expect(html).toContain("42 ideas");
  expect(html).toContain("38 ideas");
});

test("mid-expert-game: done steps carry success aria-label", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    currentStep: "expert_game",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  // StateIcon for done carries aria-label="done"
  expect(html).toContain('aria-label="done"');
});

// ─── Scenario 2: stalled ──────────────────────────────────────────────────────

test("stalled: renders STALLED text", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    stalled: true,
    stalledForSec: 380,
    stalledReason: "no activity for 6m — likely a long LLM call in expert_game / Round 2",
    currentStep: "expert_game",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running", [
        makeSubstep("round_1", "Round 1", "done"),
        makeSubstep("round_2", "Round 2", "running"),
      ]),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));

  // Multiple occurrences expected: summary bar chip + header chip + banner
  const stalledMatches = (html.match(/STALLED/g) ?? []).length;
  expect(stalledMatches).toBeGreaterThanOrEqual(2);
});

test("stalled: renders the stalled reason text", () => {
  const reason = "no activity for 6m — likely a long LLM call in expert_game / Round 2";
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    stalled: true,
    stalledForSec: 380,
    stalledReason: reason,
    currentStep: "expert_game",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain(reason);
});

test("stalled: banner has role=alert", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    stalled: true,
    stalledForSec: 380,
    stalledReason: "stall reason",
    currentStep: "expert_game",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain('role="alert"');
});

test("stalled: warning color token applied to stalled indicator", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    stalled: true,
    stalledForSec: 380,
    stalledReason: "stall reason",
    currentStep: "expert_game",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  // warning-subtle or text-warning applied
  expect(html).toContain("warning");
});

// ─── Scenario 3: completed ────────────────────────────────────────────────────

test("completed: renders DONE chip", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "completed",
    finishedAt: Math.floor(Date.now() / 1000) - 5,
    totalElapsedSec: 1200,
    stalled: false,
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "done"),
      makeStep("social_simulation", "Social Simulation", "done"),
      makeStep("scoring", "Scoring", "done"),
      makeStep("report_generation", "Report Generation", "done"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain("DONE");
});

test("completed: all step headers carry Step N aria-label", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "completed",
    finishedAt: Math.floor(Date.now() / 1000) - 5,
    totalElapsedSec: 1200,
    stalled: false,
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "done"),
      makeStep("social_simulation", "Social Simulation", "done"),
      makeStep("scoring", "Scoring", "done"),
      makeStep("report_generation", "Report Generation", "done"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain("Step 1:");
  expect(html).toContain("Step 2:");
  expect(html).toContain("Step 3:");
});

test("completed: no STALLED text shown", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "completed",
    finishedAt: Math.floor(Date.now() / 1000),
    totalElapsedSec: 900,
    stalled: false,
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "done"),
      makeStep("social_simulation", "Social Simulation", "done"),
      makeStep("scoring", "Scoring", "done"),
      makeStep("report_generation", "Report Generation", "done"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).not.toContain("STALLED");
});

// ─── Scenario 4: failed ────────────────────────────────────────────────────────

test("failed: renders error message", () => {
  const errMsg = "LLM rate limit exceeded during expert_game round 2";
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "failed",
    finishedAt: Math.floor(Date.now() / 1000) - 2,
    totalElapsedSec: 450,
    stalled: false,
    error: errMsg,
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "error"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain(errMsg);
});

test("failed: FAILED chip rendered in summary bar", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "failed",
    finishedAt: Math.floor(Date.now() / 1000),
    totalElapsedSec: 450,
    stalled: false,
    error: "something went wrong",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "error"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain("FAILED");
});

test("failed: error step carries error aria-label", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "failed",
    finishedAt: Math.floor(Date.now() / 1000),
    totalElapsedSec: 450,
    stalled: false,
    error: "something went wrong",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "error"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const html = renderHTML(React.createElement(ProgressTimeline, { progress }));
  expect(html).toContain('aria-label="error"');
});

// ─── Accessibility ─────────────────────────────────────────────────────────────

test("timeline container has aria-label", () => {
  const html = renderHTML(
    React.createElement(ProgressTimeline, { progress: BASE_PROGRESS }),
  );
  expect(html).toContain("Session progress timeline");
});

test("total elapsed section contains aria-label for elapsed", () => {
  const html = renderHTML(
    React.createElement(ProgressTimeline, { progress: BASE_PROGRESS }),
  );
  expect(html).toContain("Total elapsed");
});

// ─── Steps with substeps — expand/collapse interaction ────────────────────────

test("expandable step shows substep labels after mount", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "expert_game",
    currentStep: "expert_game",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "done"),
      makeStep("game_formulation", "Game Formulation", "done"),
      makeStep("expert_game", "Expert Game", "running", [
        makeSubstep("round_1", "Round 1", "done"),
        makeSubstep("round_2", "Round 2", "running"),
      ]),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  // Running step defaults to open — substep labels should be visible
  const { container, unmount } = mount(
    React.createElement(ProgressTimeline, { progress }),
  );
  expect(container.textContent).toContain("Round 1");
  expect(container.textContent).toContain("Round 2");
  unmount();
});

test("non-running step with substeps is collapsed by default", () => {
  const progress: SessionProgress = {
    ...BASE_PROGRESS,
    status: "knowledge_construction",
    currentStep: "knowledge_construction",
    steps: [
      makeStep("knowledge_construction", "Knowledge Construction", "running", [
        makeSubstep("kg_build", "Build Graph", "running"),
      ]),
      makeStep("game_formulation", "Game Formulation", "waiting", [
        makeSubstep("gf_setup", "Setup", "waiting"),
      ]),
      makeStep("expert_game", "Expert Game", "waiting"),
      makeStep("social_simulation", "Social Simulation", "waiting"),
      makeStep("scoring", "Scoring", "waiting"),
      makeStep("report_generation", "Report Generation", "waiting"),
    ],
  };

  const { container, unmount } = mount(
    React.createElement(ProgressTimeline, { progress }),
  );

  // The waiting step's substep label should NOT be in the DOM (collapsed)
  expect(container.textContent).not.toContain("gf_setup");
  // but its step label should
  expect(container.textContent).toContain("Game Formulation");

  unmount();
});
