/**
 * Render smoke tests for theater stage components.
 *
 * Lane: *.test.ts → bun run test:unit (happy-dom)
 *
 * Goal: assert no throw on null/empty/populated artifacts.
 * This is the null-safety regression guard — the prior crash was exactly
 * accessing .length / .map on a null session artifact.
 *
 * We use renderHTML (renderToStaticMarkup) which runs React synchronously
 * on the server side, skipping useEffect/useRef/echarts initialisation.
 * Components that render <ReactFlow> are tested via GameSetupStage and
 * StagePanel (simpler components) because ReactFlow requires full browser
 * globals that happy-dom only partially provides.
 */
import { test, expect, describe } from "bun:test";
import React from "react";
import { renderHTML } from "../../../test-helpers";
import { StagePanel } from "./StagePanel";
import { GameSetupStage } from "./stages/GameSetupStage";
import { ExpertGameStage } from "./stages/ExpertGameStage";
import type { GameFormulation, ExpertGameResult, IncentiveBreakdown } from "../types";
import type { StageStatus } from "./StagePanel";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const EMPTY_BREAKDOWN: IncentiveBreakdown = {
  diversityBonus: 0,
  buildingBonus: 0,
  surpriseBonus: 0,
  accuracyPenalty: 0,
  memoryReward: 0,
  coalitionStability: 0,
  signalCredibility: 0,
  socialViability: 0,
};

const MOCK_GAME_FORMULATION: GameFormulation = {
  gameType: "simultaneous",
  moveSequence: "simultaneous",
  players: [
    {
      id: "p1",
      name: "Rational Player",
      strategySpace: ["cooperate", "defect", "signal"],
      payoffFunction: "max(utility)",
    },
    {
      id: "p2",
      name: "Mechanism Designer",
      strategySpace: ["design", "implement"],
      payoffFunction: "social_welfare",
    },
  ],
};

function makeExpertResult(): ExpertGameResult {
  return {
    rounds: [
      {
        roundNumber: 1,
        roundType: "divergent_generation",
        agentActions: [],
        outcomes: {
          selectedIdeas: [
            {
              id: "idea-abc",
              title: "AI for climate",
              description: "Using AI to tackle climate change",
              proposedBy: "agent-1",
              round: 1,
              expertScore: 0.85,
              incentiveBreakdown: EMPTY_BREAKDOWN,
            },
          ],
          eliminatedIdeas: ["idea-xyz"],
          coalitions: [],
          equilibria: [],
        },
      },
    ],
    equilibria: [
      {
        type: "nash",
        ideas: ["idea-abc"],
        stability: 0.9,
        description: "Nash equilibrium found",
      },
    ],
    metaGameHealth: {
      diversityIndex: 0.7,
      convergenceRate: 0.6,
      noveltyScore: 0.5,
    },
  };
}

// ─── StagePanel ────────────────────────────────────────────────────────────────

describe("StagePanel", () => {
  const statuses: readonly StageStatus[] = ["waiting", "running", "done", "error"];

  for (const status of statuses) {
    test(`renders without throw — status=${status}`, () => {
      expect(() =>
        renderHTML(
          React.createElement(
            StagePanel,
            { index: 1, title: "Test Stage", status },
            React.createElement("p", null, "content"),
          ),
        ),
      ).not.toThrow();
    });
  }

  test("shows stage index number in header", () => {
    const html = renderHTML(
      React.createElement(StagePanel, { index: 3, title: "Expert Game", status: "done" }),
    );
    expect(html).toContain("3");
  });

  test("shows stage title in header", () => {
    const html = renderHTML(
      React.createElement(StagePanel, { index: 2, title: "Knowledge Graph", status: "waiting" }),
    );
    expect(html).toContain("Knowledge Graph");
  });

  test("shows summaryStat when provided and not waiting", () => {
    const html = renderHTML(
      React.createElement(StagePanel, {
        index: 1,
        title: "Stage",
        status: "done",
        summaryStat: "42 entities",
      }),
    );
    expect(html).toContain("42 entities");
  });

  test("hides summaryStat when waiting", () => {
    const html = renderHTML(
      React.createElement(StagePanel, {
        index: 1,
        title: "Stage",
        status: "waiting",
        summaryStat: "42 entities",
      }),
    );
    // summaryStat must not appear while waiting
    expect(html).not.toContain("42 entities");
  });

  test("renders children when not waiting", () => {
    const html = renderHTML(
      React.createElement(
        StagePanel,
        { index: 1, title: "Stage", status: "done" },
        React.createElement("span", { id: "child-marker" }, "test-child"),
      ),
    );
    expect(html).toContain("test-child");
  });

  test("does not render children when waiting (shows skeleton instead)", () => {
    const html = renderHTML(
      React.createElement(
        StagePanel,
        { index: 1, title: "Stage", status: "waiting" },
        React.createElement("span", null, "UNIQUE-MARKER-XYZ"),
      ),
    );
    expect(html).not.toContain("UNIQUE-MARKER-XYZ");
  });

  test("has aria-label with stage index, title, and status", () => {
    const html = renderHTML(
      React.createElement(StagePanel, { index: 2, title: "Game Setup", status: "running" }),
    );
    expect(html).toContain("Stage 2");
    expect(html).toContain("Game Setup");
    expect(html).toContain("running");
  });
});

// ─── GameSetupStage ────────────────────────────────────────────────────────────

describe("GameSetupStage", () => {
  test("renders without throw — null artifact + waiting status", () => {
    expect(() =>
      renderHTML(
        React.createElement(GameSetupStage, { gameFormulation: null, status: "waiting" }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — null artifact + running status", () => {
    expect(() =>
      renderHTML(
        React.createElement(GameSetupStage, { gameFormulation: null, status: "running" }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — null artifact + done status", () => {
    expect(() =>
      renderHTML(
        React.createElement(GameSetupStage, { gameFormulation: null, status: "done" }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — populated artifact + done status", () => {
    expect(() =>
      renderHTML(
        React.createElement(GameSetupStage, {
          gameFormulation: MOCK_GAME_FORMULATION,
          status: "done",
        }),
      ),
    ).not.toThrow();
  });

  test("shows in-progress message when running with no artifact", () => {
    const html = renderHTML(
      React.createElement(GameSetupStage, { gameFormulation: null, status: "running" }),
    );
    expect(html.toLowerCase()).toContain("formulating");
  });

  test("shows unavailable message when done with no artifact", () => {
    const html = renderHTML(
      React.createElement(GameSetupStage, { gameFormulation: null, status: "done" }),
    );
    expect(html.toLowerCase()).toContain("no game formulation");
  });

  test("shows game type badge when populated", () => {
    const html = renderHTML(
      React.createElement(GameSetupStage, {
        gameFormulation: MOCK_GAME_FORMULATION,
        status: "done",
      }),
    );
    expect(html.toLowerCase()).toContain("simultaneous");
  });

  test("shows player names when populated", () => {
    const html = renderHTML(
      React.createElement(GameSetupStage, {
        gameFormulation: MOCK_GAME_FORMULATION,
        status: "done",
      }),
    );
    expect(html).toContain("Rational Player");
    expect(html).toContain("Mechanism Designer");
  });

  test("renders without throw — empty players array", () => {
    const formulation: GameFormulation = {
      gameType: "simultaneous",
      moveSequence: "simultaneous",
      players: [],
    };
    expect(() =>
      renderHTML(
        React.createElement(GameSetupStage, { gameFormulation: formulation, status: "done" }),
      ),
    ).not.toThrow();
  });
});

// ─── ExpertGameStage ──────────────────────────────────────────────────────────

describe("ExpertGameStage", () => {
  test("renders without throw — null artifact + waiting status", () => {
    expect(() =>
      renderHTML(
        React.createElement(ExpertGameStage, { expertResult: null, status: "waiting" }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — null artifact + running status", () => {
    expect(() =>
      renderHTML(
        React.createElement(ExpertGameStage, { expertResult: null, status: "running" }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — null artifact + done status", () => {
    expect(() =>
      renderHTML(
        React.createElement(ExpertGameStage, { expertResult: null, status: "done" }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — populated artifact + done status", () => {
    expect(() =>
      renderHTML(
        React.createElement(ExpertGameStage, {
          expertResult: makeExpertResult(),
          status: "done",
        }),
      ),
    ).not.toThrow();
  });

  test("renders without throw — undefined artifact (null-safety regression)", () => {
    expect(() =>
      renderHTML(
        React.createElement(ExpertGameStage, { expertResult: undefined, status: "done" }),
      ),
    ).not.toThrow();
  });

  test("shows in-progress message when running with no artifact", () => {
    const html = renderHTML(
      React.createElement(ExpertGameStage, { expertResult: null, status: "running" }),
    );
    expect(html.toLowerCase()).toContain("expert game in progress");
  });

  test("shows unavailable message when done with no artifact", () => {
    const html = renderHTML(
      React.createElement(ExpertGameStage, { expertResult: null, status: "done" }),
    );
    expect(html.toLowerCase()).toContain("no expert game data");
  });

  test("shows round number when artifact present", () => {
    const html = renderHTML(
      React.createElement(ExpertGameStage, {
        expertResult: makeExpertResult(),
        status: "done",
      }),
    );
    // Should show "Round 1 / 1" or similar
    expect(html).toContain("Round");
  });

  test("renders without throw — expertResult with empty rounds", () => {
    const result: ExpertGameResult = {
      rounds: [],
      equilibria: [],
      metaGameHealth: { diversityIndex: 0, convergenceRate: 0, noveltyScore: 0 },
    };
    expect(() =>
      renderHTML(
        React.createElement(ExpertGameStage, { expertResult: result, status: "done" }),
      ),
    ).not.toThrow();
  });
});
