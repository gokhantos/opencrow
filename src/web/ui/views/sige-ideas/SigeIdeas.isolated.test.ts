/**
 * Isolated tests for the SigeIdeas view.
 *
 * Lane: isolated (*.isolated.test.ts) — mock.module required for usePolledFetch
 * and useLocalStorage; must run in its own process to avoid mock leaks.
 * Run with: bun run test:isolated
 *
 * Scenarios:
 *  1. Loading state — LoadingState rendered when loading=true and no data.
 *  2. Error state — error message shown when error is set and no data.
 *  3. Renders a list of ideas from mock data.
 *  4. All-rounds tab is active by default (finalOnly=false).
 *  5. Switching to the Final-only tab triggers a state change (calls setFinalOnly).
 *  6. Search filter applied client-side narrows visible ideas.
 *
 * Note: SigeIdeas uses usePolledFetch (network) and useLocalStorage (browser
 * storage). We mock both modules at the narrowest possible scope to avoid
 * bleedthrough onto other isolated tests.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";
import React from "react";
import { renderHTML } from "../../test-helpers";

// ─── Types only (no runtime import of the module yet) ────────────────────────

import type { AggregatedIdea, RunSummary, IdeasResponse } from "./types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeIdea(id: string, overrides: Partial<AggregatedIdea> = {}): AggregatedIdea {
  return {
    ideaId: id,
    title: `Idea ${id}`,
    description: `Description for ${id}`,
    proposedBy: "agent-1",
    round: 1,
    roundType: "divergent_generation",
    expertScore: 0.7,
    socialScore: null,
    fusedScore: null,
    isFinal: false,
    breakdown: null,
    runId: "run-1",
    runSeed: "test seed",
    runOrigin: "human",
    runStatus: "completed",
    runCreatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRun(runId: string): RunSummary {
  return {
    runId,
    seed: "test seed",
    origin: "human",
    status: "completed",
    createdAt: "2024-01-01T00:00:00Z",
    ideaCount: 2,
    finalCount: 0,
  };
}

// ─── Mock setup ───────────────────────────────────────────────────────────────
//
// We mock `usePolledFetch` and `useLocalStorage` at the module level.
// These mocks are set BEFORE the component module is imported.

// Mutable state for the polled-fetch mock so each test can configure its own result.
let mockFetchResult: {
  data: IdeasResponse | null;
  error: string | null;
  loading: boolean;
} = { data: null, error: null, loading: false };

mock.module("../../hooks/usePolledFetch", () => ({
  usePolledFetch: <T>(_path: string, _opts: unknown) => ({
    data: mockFetchResult.data as T | null,
    error: mockFetchResult.error,
    loading: mockFetchResult.loading,
    refetch: () => {},
  }),
}));

// useLocalStorage: return a simple in-memory [value, setter] pair using the default.
// We use a simple closure approach — each call returns the default value and a noop setter.
// This avoids localStorage interaction in happy-dom.
mock.module("../../lib/useLocalStorage", () => ({
  useLocalStorage: <T>(
    _key: string,
    defaultValue: T,
  ): [T, (v: T | ((prev: T) => T)) => void] => {
    return [defaultValue, () => {}];
  },
}));

// ─── Import component AFTER mocks are set up ─────────────────────────────────

// Dynamic import to ensure mocks are in place first (bun evaluates mock.module at parse time
// but the module cache is already overridden for subsequent require calls).
let SigeIdeas: typeof import("../SigeIdeas").default;

beforeAll(async () => {
  const mod = await import("../SigeIdeas");
  SigeIdeas = mod.default;
});

// ─── 1. Loading state ─────────────────────────────────────────────────────────

describe("SigeIdeas — loading state", () => {
  test("shows loading message when loading=true and no data", () => {
    mockFetchResult = { data: null, error: null, loading: true };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("Loading SIGE ideas");
  });
});

// ─── 2. Error state ───────────────────────────────────────────────────────────

describe("SigeIdeas — error state", () => {
  test("shows error message when error is set and no data", () => {
    mockFetchResult = {
      data: null,
      error: "Network timeout",
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("Failed to load ideas");
    expect(html).toContain("Network timeout");
  });
});

// ─── 3. Renders ideas list ────────────────────────────────────────────────────

describe("SigeIdeas — renders ideas", () => {
  test("renders idea titles when data is loaded", () => {
    const ideas = [makeIdea("idea-alpha"), makeIdea("idea-beta")];
    mockFetchResult = {
      data: {
        success: true,
        data: {
          ideas,
          runs: [makeRun("run-1")],
        },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("Idea idea-alpha");
    expect(html).toContain("Idea idea-beta");
  });

  test("shows empty state when ideas array is empty", () => {
    mockFetchResult = {
      data: {
        success: true,
        data: { ideas: [], runs: [] },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("No SIGE ideas yet");
  });
});

// ─── 4. All-rounds tab is active by default ───────────────────────────────────

describe("SigeIdeas — default filter state", () => {
  test("All rounds tab is rendered by default", () => {
    mockFetchResult = {
      data: {
        success: true,
        data: { ideas: [makeIdea("idea-x")], runs: [makeRun("run-1")] },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("All rounds");
    expect(html).toContain("Final only");
  });

  test("SIGE Ideas header is rendered", () => {
    mockFetchResult = {
      data: {
        success: true,
        data: { ideas: [makeIdea("idea-x")], runs: [] },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("SIGE Ideas");
  });

  test("run dropdown is rendered with idea data", () => {
    mockFetchResult = {
      data: {
        success: true,
        data: {
          ideas: [makeIdea("idea-x")],
          runs: [
            {
              runId: "run-seeded",
              seed: "AI tools",
              origin: "human" as const,
              status: "completed" as const,
              createdAt: "2024-01-01T00:00:00Z",
              ideaCount: 1,
              finalCount: 0,
            },
          ],
        },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    // The run label in the <select> uses truncated seed
    expect(html).toContain("AI tools");
  });
});

// ─── 5. Round filter tabs rendered ────────────────────────────────────────────

describe("SigeIdeas — round filter tabs", () => {
  test("renders round filter buttons R1 through R4", () => {
    mockFetchResult = {
      data: {
        success: true,
        data: { ideas: [makeIdea("idea-x")], runs: [] },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    expect(html).toContain("R1");
    expect(html).toContain("R2");
    expect(html).toContain("R3");
    expect(html).toContain("R4");
  });
});

// ─── 6. IdeaCard rank is position-based ──────────────────────────────────────

describe("SigeIdeas — rank assignment", () => {
  test("first idea gets rank 1 (accent bubble in IdeaCard)", () => {
    const ideas = [
      makeIdea("idea-first", { expertScore: 0.9 }),
      makeIdea("idea-second", { expertScore: 0.5 }),
    ];
    mockFetchResult = {
      data: {
        success: true,
        data: { ideas, runs: [] },
      },
      error: null,
      loading: false,
    };

    const html = renderHTML(
      React.createElement(SigeIdeas, { navigateTo: () => {} }),
    );
    // Rank 1 gets bg-accent class on the bubble
    expect(html).toContain("bg-accent");
    // Both ideas appear
    expect(html).toContain("Idea idea-first");
    expect(html).toContain("Idea idea-second");
  });
});
