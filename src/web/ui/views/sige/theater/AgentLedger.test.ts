/**
 * Unit tests for AgentLedger component.
 *
 * Lane: unit (*.test.ts) — happy-dom, no DB, no network.
 *
 * Scenarios:
 *   1. Loading state — skeleton rows rendered with aria-busy.
 *   2. Error state — error message shown with role=alert.
 *   3. Empty state — "No agent actions" message shown.
 *   4. Agent row renders role badge, actionType chip, confidence meter.
 *   5. Score displayed when present; absent when null.
 *   6. Expand toggle reveals reasoning and parsed ideas (interaction).
 *   7. Non-JSON content triggers defensive fallback (no crash, raw shown).
 *   8. TasteFilterPanel rendered when isTasteFilter=true and artifacts have tasteFilter.
 *   9. Agents sorted by createdAt ascending.
 *  10. targetIdeas shown in expanded detail.
 */
import { test, describe, expect } from "bun:test";
import React from "react";
import { renderHTML, mount, click } from "../../../test-helpers";
import { AgentLedger } from "./AgentLedger";
import type { AgentActionRecord, RoundLedger, RoundArtifacts } from "../types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<AgentActionRecord> = {}): AgentActionRecord {
  const base: AgentActionRecord = {
    agentId: "agent-challenger-1",
    role: "challenger",
    round: 1,
    actionType: "propose",
    content: '{"ideas":[{"title":"AI Health Monitor","description":"tracks vitals"}]}',
    confidence: 0.8,
    score: null,
    targetIdeas: [],
    reasoning: "I challenge this idea based on market fit.",
    createdAt: 1718000000,
  };
  return { ...base, ...overrides };
}

function makeLedger(
  round: number,
  actions: readonly AgentActionRecord[],
  artifacts: RoundArtifacts | null = null,
): RoundLedger {
  return { round, actions, artifacts };
}

// ─── Loading state ────────────────────────────────────────────────────────────

describe("AgentLedger — loading state", () => {
  test("renders aria-busy when loading=true", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, { ledgers: [], loading: true, error: null }),
    );
    expect(html).toContain('aria-busy="true"');
  });

  test("renders skeleton placeholder elements when loading", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, { ledgers: [], loading: true, error: null }),
    );
    // Loading skeleton has animate-pulse elements
    expect(html).toContain("animate-pulse");
  });

  test("does not render agent rows when loading", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()])],
        loading: true,
        error: null,
      }),
    );
    // challenger role badge should NOT appear while loading
    expect(html).not.toContain("challenger");
  });
});

// ─── Error state ──────────────────────────────────────────────────────────────

describe("AgentLedger — error state", () => {
  test("renders error message with role=alert when error is set", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [],
        loading: false,
        error: "Network request failed",
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Network request failed");
  });

  test("includes 'Failed to load ledger' prefix in error output", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [],
        loading: false,
        error: "timeout",
      }),
    );
    expect(html).toContain("Failed to load ledger");
  });

  test("does not render agent list when error is set", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()])],
        loading: false,
        error: "Something went wrong",
      }),
    );
    // role="list" for agent list should not be present during error
    expect(html).not.toContain('"list"');
  });
});

// ─── Empty state ───────────────────────────────────────────────────────────────

describe("AgentLedger — empty state", () => {
  test("renders 'No agent actions' message when ledgers array is empty", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, { ledgers: [], loading: false, error: null }),
    );
    expect(html).toContain("No agent actions");
  });

  test("renders empty state when ledgers have no actions", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("No agent actions");
  });
});

// ─── Agent row rendering ───────────────────────────────────────────────────────

describe("AgentLedger — agent row content", () => {
  test("renders role badge for each agent", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ role: "challenger" })])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("challenger");
  });

  test("renders actionType chip", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ actionType: "synthesize" })])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("synthesize");
  });

  test("renders confidence meter with aria attributes", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ confidence: 0.75 })])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain('role="meter"');
    expect(html).toContain("aria-valuenow");
  });

  test("renders agentId as secondary line", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ agentId: "agent-xyz-42" })])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("agent-xyz-42");
  });

  test("aria-label for action list is 'Agent action ledger'", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("Agent action ledger");
  });
});

// ─── Score display ─────────────────────────────────────────────────────────────

describe("AgentLedger — score display", () => {
  test("renders score value when score is not null", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ score: 0.823 })])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("score");
    expect(html).toContain("0.823");
  });

  test("does not render score chip when score is null", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ score: null })])],
        loading: false,
        error: null,
      }),
    );
    // The word "score" is used only in the score chip; if null, should not appear
    expect(html).not.toContain(">score<");
  });
});

// ─── Expand toggle — reasoning and ideas ──────────────────────────────────────

describe("AgentLedger — expand toggle interaction", () => {
  test("expand button has aria-expanded=false initially (collapsed)", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ reasoning: "test reasoning" })])],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain('aria-expanded="false"');
  });

  test("clicking expand shows reasoning text", () => {
    const { container, unmount } = mount(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ reasoning: "detailed reasoning here" })])],
        loading: false,
        error: null,
      }),
    );

    // Find expand button and click it
    const btn = container.querySelector('button[aria-label="Expand detail"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    click(btn!);

    expect(container.textContent).toContain("detailed reasoning here");
    unmount();
  });

  test("clicking expand shows parsed idea titles from JSON content", () => {
    const { container, unmount } = mount(
      React.createElement(AgentLedger, {
        ledgers: [
          makeLedger(1, [
            makeAction({
              content: '{"ideas":[{"title":"Carbon Credits Marketplace","description":"tokenized trading"}]}',
              reasoning: "some reasoning",
            }),
          ]),
        ],
        loading: false,
        error: null,
      }),
    );

    const btn = container.querySelector('button[aria-label="Expand detail"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    click(btn!);

    expect(container.textContent).toContain("Carbon Credits Marketplace");
    unmount();
  });

  test("clicking expand twice collapses the detail (toggle)", () => {
    const { container, unmount } = mount(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ reasoning: "visible when expanded" })])],
        loading: false,
        error: null,
      }),
    );

    const btn = container.querySelector('button[aria-label="Expand detail"]') as HTMLElement | null;
    click(btn!); // expand
    click(container.querySelector('button[aria-label="Collapse detail"]')!); // collapse

    expect(container.textContent).not.toContain("visible when expanded");
    unmount();
  });
});

// ─── Defensive fallback on non-JSON content ────────────────────────────────────

describe("AgentLedger — non-JSON content fallback", () => {
  test("component does not crash when content is malformed JSON", () => {
    expect(() =>
      renderHTML(
        React.createElement(AgentLedger, {
          ledgers: [makeLedger(1, [makeAction({ content: "{ truncated, bad json" })])],
          loading: false,
          error: null,
        }),
      ),
    ).not.toThrow();
  });

  test("truncated non-JSON content renders raw text fallback in expanded view", () => {
    const badContent = "{ broken json that was truncated mid-stream";
    const { container, unmount } = mount(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction({ content: badContent })])],
        loading: false,
        error: null,
      }),
    );

    const btn = container.querySelector('button[aria-label="Expand detail"]') as HTMLElement | null;
    if (btn) {
      click(btn);
      // The raw content fallback truncated to 200 chars is shown
      expect(container.textContent).toContain("{ broken json");
    }
    unmount();
  });
});

// ─── TasteFilterPanel ─────────────────────────────────────────────────────────

describe("AgentLedger — TasteFilterPanel for taste filter substep", () => {
  test("renders pass/eliminate verdicts when isTasteFilter=true and tasteFilter present", () => {
    const artifacts: RoundArtifacts = {
      tasteFilter: {
        passed: [{ ideaId: "idea-1", title: "Viable Idea" }],
        eliminated: [{ ideaId: "idea-2", title: "Weak Idea" }],
      },
    };
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()], artifacts)],
        loading: false,
        error: null,
        isTasteFilter: true,
      }),
    );
    expect(html).toContain("Taste Filter Verdicts");
    expect(html).toContain("Viable Idea");
    expect(html).toContain("Weak Idea");
    expect(html).toContain("pass");
    expect(html).toContain("eliminate");
  });

  test("does NOT render TasteFilterPanel when isTasteFilter=false", () => {
    const artifacts: RoundArtifacts = {
      tasteFilter: {
        passed: [{ ideaId: "idea-1", title: "Viable Idea" }],
        eliminated: [],
      },
    };
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()], artifacts)],
        loading: false,
        error: null,
        isTasteFilter: false,
      }),
    );
    expect(html).not.toContain("Taste Filter Verdicts");
  });

  test("does NOT render TasteFilterPanel when artifacts tasteFilter is absent", () => {
    const artifacts: RoundArtifacts = { equilibria: [], coalitions: [] };
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()], artifacts)],
        loading: false,
        error: null,
        isTasteFilter: true,
      }),
    );
    expect(html).not.toContain("Taste Filter Verdicts");
  });
});

// ─── OutcomesSummary ──────────────────────────────────────────────────────────

describe("AgentLedger — OutcomesSummary for round artifacts", () => {
  test("renders coalition/equilibria/selected/eliminated counts when present", () => {
    const artifacts: RoundArtifacts = {
      coalitions: [{ id: "c1" }, { id: "c2" }],
      equilibria: [{ id: "e1" }],
      selectedIdeasCount: 69,
      eliminatedIdeasCount: 4,
    };
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(2, [makeAction()], artifacts)],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("Round Outcomes");
    expect(html).toContain("coalitions");
    expect(html).toContain("equilibria");
    expect(html).toContain("selected");
    expect(html).toContain("eliminated");
    expect(html).toContain("69");
  });

  test("renders OutcomesSummary even when isTasteFilter=false (all rounds, not just taste filter)", () => {
    const artifacts: RoundArtifacts = { coalitions: [{ id: "c1" }] };
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(2, [makeAction()], artifacts)],
        loading: false,
        error: null,
        isTasteFilter: false,
      }),
    );
    expect(html).toContain("Round Outcomes");
  });

  test("hides the eliminated chip when eliminatedIdeasCount is 0", () => {
    const artifacts: RoundArtifacts = {
      selectedIdeasCount: 50,
      eliminatedIdeasCount: 0,
    };
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()], artifacts)],
        loading: false,
        error: null,
      }),
    );
    expect(html).toContain("selected");
    expect(html).not.toContain("eliminated");
  });

  test("renders no OutcomesSummary when artifacts are null", () => {
    const html = renderHTML(
      React.createElement(AgentLedger, {
        ledgers: [makeLedger(1, [makeAction()], null)],
        loading: false,
        error: null,
      }),
    );
    expect(html).not.toContain("Round Outcomes");
  });
});

// ─── Ordering ────────────────────────────────────────────────────────────────

describe("AgentLedger — agent sort order", () => {
  test("agents are rendered sorted by createdAt ascending", () => {
    const early = makeAction({ agentId: "agent-early", role: "challenger", createdAt: 1718000000 });
    const late = makeAction({ agentId: "agent-late", role: "defender", createdAt: 1718000099 });

    const html = renderHTML(
      React.createElement(AgentLedger, {
        // Pass late first to verify sort
        ledgers: [makeLedger(1, [late, early])],
        loading: false,
        error: null,
      }),
    );

    const earlyPos = html.indexOf("agent-early");
    const latePos = html.indexOf("agent-late");
    expect(earlyPos).toBeLessThan(latePos);
  });
});

// ─── targetIdeas in expanded detail ───────────────────────────────────────────

describe("AgentLedger — targetIdeas in expanded detail", () => {
  test("targetIdeas chips appear after expand", () => {
    const { container, unmount } = mount(
      React.createElement(AgentLedger, {
        ledgers: [
          makeLedger(1, [
            makeAction({
              targetIdeas: ["idea-uuid-abc", "idea-uuid-xyz"],
              reasoning: "targeting these ideas",
            }),
          ]),
        ],
        loading: false,
        error: null,
      }),
    );

    const btn = container.querySelector('button[aria-label="Expand detail"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    click(btn!);

    expect(container.textContent).toContain("idea-uuid-abc");
    expect(container.textContent).toContain("idea-uuid-xyz");
    unmount();
  });
});
