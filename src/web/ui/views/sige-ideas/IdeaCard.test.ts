/**
 * Unit tests for IdeaCard component.
 *
 * Lane: unit (*.test.ts) — happy-dom, no DB, no network.
 * Run with: bun run test:unit
 *
 * IdeaCard is purely presentational: it renders a collapsible card for an
 * AggregatedIdea. Local state (expanded) controls the collapse toggle.
 *
 * Scenarios:
 *  1. Collapsed state: renders title, rank, expert score.
 *  2. Non-final idea: "Final" badge is absent when isFinal=false.
 *  3. Final idea: "Final" badge is present when isFinal=true.
 *  4. Clicking the card button expands the detail panel (description visible).
 *  5. Expanded: breakdown is shown when idea.breakdown is non-null.
 *  6. Expanded: breakdown section shows "Not available" when idea.breakdown is null.
 *  7. Expanded: socialScore row only shown when socialScore is non-null.
 *  8. Expanded: fusedScore row only shown when fusedScore is non-null.
 *  9. Clicking expand twice collapses back.
 * 10. aria-expanded toggles correctly.
 * 11. Rank=1 gets distinct styling (accent class).
 * 12. runSeed shown in run chip; null seed shows "Auto <runId>" prefix.
 * 13. "Open run in SIGE" button calls navigateTo("sige").
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";
import React from "react";
import { renderHTML, mount, click } from "../../test-helpers";
import { IdeaCard } from "./IdeaCard";
import type { AggregatedIdea } from "./types";
import type { Tab } from "../../navigation";

// happy-dom does not ship a sessionStorage implementation; polyfill it so that
// IdeaCard.handleOpenRun() can call sessionStorage.setItem without throwing.
beforeAll(() => {
  if (typeof globalThis.sessionStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }
});

// ─── Fixture ─────────────────────────────────────────────────────────────────

const ZERO_BREAKDOWN = {
  diversityBonus: 0,
  buildingBonus: 0,
  surpriseBonus: 0,
  accuracyPenalty: 0,
  memoryReward: 0,
  coalitionStability: 0,
  signalCredibility: 0,
  socialViability: 0,
};

function makeIdea(overrides: Partial<AggregatedIdea> = {}): AggregatedIdea {
  return {
    ideaId: "idea-test-1",
    title: "Decentralised Energy Trading",
    description: "A peer-to-peer renewable energy trading platform.",
    proposedBy: "agent-rational-player",
    round: 2,
    roundType: "divergent_generation",
    expertScore: 0.78,
    socialScore: null,
    fusedScore: null,
    isFinal: false,
    breakdown: null,
    runId: "run-abc123",
    runSeed: "AI tools for climate",
    runOrigin: "human",
    runStatus: "completed",
    runCreatedAt: "2024-03-15T10:00:00Z",
    ...overrides,
  };
}

const noop = () => {};

// ─── 1. Collapsed renders title and rank ─────────────────────────────────────

describe("IdeaCard — collapsed state", () => {
  test("renders the idea title in the collapsed button row", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 1,
        navigateTo: noop,
      }),
    );
    expect(html).toContain("Decentralised Energy Trading");
  });

  test("renders the rank number", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 5,
        navigateTo: noop,
      }),
    );
    expect(html).toContain("5");
  });

  test("renders expertScore formatted to 3 decimal places", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea({ expertScore: 0.78 }),
        rank: 1,
        navigateTo: noop,
      }),
    );
    expect(html).toContain("0.780");
  });

  test("aria-expanded is false when collapsed", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 1,
        navigateTo: noop,
      }),
    );
    expect(html).toContain('aria-expanded="false"');
  });
});

// ─── 2. Non-final idea: no Final badge ───────────────────────────────────────

describe("IdeaCard — non-final idea", () => {
  test("does not render the Final badge when isFinal=false", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea({ isFinal: false }),
        rank: 1,
        navigateTo: noop,
      }),
    );
    // "Final" in the badge has a wrapping element with specific text
    // We look for >Final< to distinguish from other uses of the word
    expect(html).not.toContain(">Final<");
  });
});

// ─── 3. Final idea: Final badge present ──────────────────────────────────────

describe("IdeaCard — final idea", () => {
  test("renders the Final badge when isFinal=true", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea({
          isFinal: true,
          socialScore: 0.65,
          fusedScore: 0.72,
          breakdown: ZERO_BREAKDOWN,
        }),
        rank: 1,
        navigateTo: noop,
      }),
    );
    expect(html).toContain("Final");
  });
});

// ─── 4. Expand: description visible after click ───────────────────────────────

describe("IdeaCard — expand toggle", () => {
  test("description is visible after clicking the card button", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 1,
        navigateTo: noop,
      }),
    );

    // Initially the description should not be in the DOM (only collapsed row is shown)
    const before = container.textContent ?? "";
    // The description text is shown only in expanded panel
    expect(before).not.toContain("A peer-to-peer renewable energy trading platform.");

    // Click the collapse button to expand
    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    expect(btn).not.toBeNull();
    click(btn!);

    expect(container.textContent).toContain("A peer-to-peer renewable energy trading platform.");
    unmount();
  });

  test("aria-expanded becomes true after click", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 1,
        navigateTo: noop,
      }),
    );

    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
    click(btn!);
    expect(btn?.getAttribute("aria-expanded")).toBe("true");
    unmount();
  });

  test("clicking expand twice collapses back — description no longer visible", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 1,
        navigateTo: noop,
      }),
    );

    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    click(btn!); // expand
    click(btn!); // collapse

    expect(container.textContent).not.toContain("A peer-to-peer renewable energy trading platform.");
    unmount();
  });
});

// ─── 5. Expanded: breakdown shown when non-null ───────────────────────────────

describe("IdeaCard — breakdown in expanded view", () => {
  test("renders Incentive Breakdown section when breakdown is non-null", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea({
          isFinal: true,
          socialScore: 0.6,
          fusedScore: 0.7,
          breakdown: { ...ZERO_BREAKDOWN, diversityBonus: 0.3 },
        }),
        rank: 1,
        navigateTo: noop,
      }),
    );

    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    click(btn!);

    expect(container.textContent).toContain("Incentive Breakdown");
    unmount();
  });
});

// ─── 6. Expanded: breakdown shows "Not available" when null ──────────────────

describe("IdeaCard — null breakdown", () => {
  test("shows 'Not available' message for non-final ideas with null breakdown", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea({ isFinal: false, breakdown: null }),
        rank: 2,
        navigateTo: noop,
      }),
    );

    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    click(btn!);

    expect(container.textContent).toContain("Not available");
    unmount();
  });
});

// ─── 7. socialScore row only when non-null ────────────────────────────────────

describe("IdeaCard — socialScore display", () => {
  test("does not render Social score row when socialScore is null", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea({ socialScore: null, fusedScore: null }),
        rank: 1,
        navigateTo: noop,
      }),
    );
    // social score text appears in expanded view — check SSR output
    // In collapsed view it won't appear at all; score bar shows 0 for social
    expect(html).not.toContain("Social</");
  });

  test("renders Social score value when socialScore is present (expand needed)", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea({
          isFinal: true,
          socialScore: 0.63,
          fusedScore: 0.72,
          breakdown: ZERO_BREAKDOWN,
        }),
        rank: 1,
        navigateTo: noop,
      }),
    );

    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    click(btn!);

    expect(container.textContent).toContain("0.630");
    unmount();
  });
});

// ─── 8. fusedScore row only when non-null ────────────────────────────────────

describe("IdeaCard — fusedScore display", () => {
  test("renders fusedScore when present in expanded view", () => {
    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea({
          isFinal: true,
          socialScore: 0.6,
          fusedScore: 0.74,
          breakdown: ZERO_BREAKDOWN,
        }),
        rank: 1,
        navigateTo: noop,
      }),
    );

    const btn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    click(btn!);

    expect(container.textContent).toContain("0.740");
    unmount();
  });
});

// ─── 11. Rank=1 accent class ──────────────────────────────────────────────────

describe("IdeaCard — rank styling", () => {
  test("rank 1 card has bg-accent class on rank bubble", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 1,
        navigateTo: noop,
      }),
    );
    expect(html).toContain("bg-accent");
  });

  test("rank 4+ card does not have primary accent class on rank bubble", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea(),
        rank: 10,
        navigateTo: noop,
      }),
    );
    // bg-bg-2 is the fallback for rank >= 4
    expect(html).toContain("bg-bg-2");
  });
});

// ─── 12. runSeed chip ────────────────────────────────────────────────────────

describe("IdeaCard — run chip label", () => {
  test("shows truncated seed when runSeed is present", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea({ runSeed: "AI tools for climate tech startups" }),
        rank: 1,
        navigateTo: noop,
      }),
    );
    // Seed is truncated at 20 chars: "AI tools for climate…"
    expect(html).toContain("AI tools for climate");
  });

  test("shows Auto prefix with runId when runSeed is null", () => {
    const html = renderHTML(
      React.createElement(IdeaCard, {
        idea: makeIdea({ runSeed: null, runId: "run-abcdef123456" }),
        rank: 1,
        navigateTo: noop,
      }),
    );
    // "Auto " + first 6 chars of runId
    expect(html).toContain("Auto run-ab");
  });
});

// ─── 13. "Open run in SIGE" navigateTo call ──────────────────────────────────

describe("IdeaCard — Open run in SIGE button", () => {
  test("navigateTo('sige') is called when Open run button is clicked", () => {
    const navigateTo = mock((_tab: Tab) => {});

    const { container, unmount } = mount(
      React.createElement(IdeaCard, {
        idea: makeIdea({ runId: "run-nav-test" }),
        rank: 1,
        navigateTo,
      }),
    );

    // Expand to reveal the Open run button
    const expandBtn = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    click(expandBtn!);

    // Find the Open run button by text
    const buttons = Array.from(container.querySelectorAll("button"));
    const openBtn = buttons.find((b) => b.textContent?.includes("Open run in SIGE"));
    expect(openBtn).toBeDefined();
    click(openBtn!);

    expect(navigateTo).toHaveBeenCalledWith("sige");
    unmount();
  });
});
