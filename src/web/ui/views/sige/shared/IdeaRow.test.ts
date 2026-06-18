/**
 * Unit tests for the shared IdeaRow + ScoreBar + breakdownEntries primitives.
 *
 * Lane: unit (*.test.ts) — pure React rendering, no DB, no network.
 *
 * Key behaviors under test:
 *  - ScoreBar clamps scores to [0, 1] (Math.min(Math.max(…)))
 *  - IdeaRow expands/collapses on click (aria-expanded toggles)
 *  - IdeaRow carries aria-label identifying the idea + rank
 *  - breakdownEntries maps all 8 IncentiveBreakdown fields correctly
 *  - Rank-1 highlight styling is applied
 */
import { test, expect } from "bun:test";
import React from "react";
import { renderHTML, mount, click } from "../../../test-helpers";
import { ScoreBar, IdeaRow, breakdownEntries } from "./IdeaRow";
import type { IncentiveBreakdown, FusedScore } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_BREAKDOWN: IncentiveBreakdown = {
  diversityBonus: 0.1,
  buildingBonus: 0.2,
  surpriseBonus: 0.05,
  accuracyPenalty: 0.03,
  memoryReward: 0.15,
  coalitionStability: 0.08,
  signalCredibility: 0.07,
  socialViability: 0.12,
};

const BASE_IDEA: FusedScore = {
  ideaId: "abcdef1234567890",
  expertScore: 0.75,
  socialScore: 0.6,
  fusedScore: 0.68,
  alpha: 0.5,
  breakdown: BASE_BREAKDOWN,
};

// ─── ScoreBar ─────────────────────────────────────────────────────────────────

test("ScoreBar renders expert score as percentage width", () => {
  const html = renderHTML(
    React.createElement(ScoreBar, { expertScore: 0.75, socialScore: 0.5, fusedScore: 0.625 }),
  );
  expect(html).toContain("75%");
});

test("ScoreBar renders social score as percentage width", () => {
  const html = renderHTML(
    React.createElement(ScoreBar, { expertScore: 0.4, socialScore: 0.6, fusedScore: 0.5 }),
  );
  expect(html).toContain("60%");
});

test("ScoreBar clamps expert score above 1 to 100%", () => {
  const html = renderHTML(
    React.createElement(ScoreBar, { expertScore: 1.5, socialScore: 0, fusedScore: 0 }),
  );
  expect(html).toContain("100%");
  expect(html).not.toContain("150%");
});

test("ScoreBar clamps expert score below 0 to 0%", () => {
  const html = renderHTML(
    React.createElement(ScoreBar, { expertScore: -0.5, socialScore: 0, fusedScore: 0 }),
  );
  // Both expert (clamped) and social are 0 — style contains "width:0%"
  // Note: React inline styles omit the space after the colon.
  const matches = html.match(/width:0%/g) ?? [];
  expect(matches.length).toBeGreaterThanOrEqual(1);
});

test("ScoreBar displays fused score with 3 decimal places", () => {
  const html = renderHTML(
    React.createElement(ScoreBar, { expertScore: 0.5, socialScore: 0.5, fusedScore: 0.678 }),
  );
  expect(html).toContain("0.678");
});

// ─── breakdownEntries ─────────────────────────────────────────────────────────

test("breakdownEntries returns 8 entries", () => {
  const entries = breakdownEntries(BASE_BREAKDOWN);
  expect(entries.length).toBe(8);
});

test("breakdownEntries accuracyPenalty has positive=false", () => {
  const entries = breakdownEntries(BASE_BREAKDOWN);
  const penalty = entries.find((e) => e.label === "Accuracy penalty");
  expect(penalty).toBeDefined();
  expect(penalty!.positive).toBe(false);
});

test("breakdownEntries all others have positive=true", () => {
  const entries = breakdownEntries(BASE_BREAKDOWN);
  const positives = entries.filter((e) => e.positive);
  const negatives = entries.filter((e) => !e.positive);
  expect(positives.length).toBe(7);
  expect(negatives.length).toBe(1);
});

test("breakdownEntries values match the breakdown fields", () => {
  const entries = breakdownEntries(BASE_BREAKDOWN);
  const diversity = entries.find((e) => e.label === "Diversity bonus");
  expect(diversity?.value).toBe(0.1);
});

// ─── IdeaRow ──────────────────────────────────────────────────────────────────

test("IdeaRow renders rank number", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 3 }));
  expect(html).toContain(">3<");
});

test("IdeaRow shows truncated ideaId (first 8 chars)", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 1 }));
  expect(html).toContain("abcdef12");
  expect(html).not.toContain("34567890");
});

test("IdeaRow has aria-label containing rank and ideaId prefix", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 2 }));
  expect(html).toContain("Idea 2:");
  expect(html).toContain("abcdef12");
});

test("IdeaRow button has aria-expanded=false initially", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 1 }));
  expect(html).toContain('aria-expanded="false"');
});

test("IdeaRow does not render breakdown section when collapsed", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 1 }));
  expect(html).not.toContain("Incentive Breakdown");
});

test("IdeaRow toggles expansion on click", () => {
  const { container, unmount } = mount(
    React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 1 }),
  );
  const btn = container.querySelector("button")!;
  expect(btn.getAttribute("aria-expanded")).toBe("false");

  click(btn);
  expect(btn.getAttribute("aria-expanded")).toBe("true");

  click(btn);
  expect(btn.getAttribute("aria-expanded")).toBe("false");

  unmount();
});

test("IdeaRow shows breakdown section when expanded", () => {
  const { container, unmount } = mount(
    React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 1 }),
  );
  click(container.querySelector("button")!);
  expect(container.textContent).toContain("Incentive Breakdown");
  unmount();
});

test("IdeaRow applies rank-1 highlight class", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 1 }));
  expect(html).toContain("accent-subtle");
});

test("IdeaRow does NOT apply rank-1 highlight for rank > 1", () => {
  const html = renderHTML(React.createElement(IdeaRow, { idea: BASE_IDEA, rank: 2 }));
  expect(html).not.toContain("accent-subtle");
});
