/**
 * Isolated tests for ConceptsTab (the "Concepts" view of Keyword Research).
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * (network), mirroring OpportunitiesTab.isolated.test.ts's pattern: mock the
 * narrowest dependency (apiFetch itself) and let the real `usePolledFetch`
 * hook drive the list fetch, so the component's actual query-building logic
 * is exercised, not just its rendering. mock.module leaks across files in a
 * shared process, so this MUST run via `bun run test:isolated` (or directly,
 * as its own file).
 */
import { test, expect, mock, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";

// ─── Mock apiFetch BEFORE importing the component ────────────────────────────

interface MockClusterTopMember {
  readonly keyword: string;
  readonly buildability: number;
  readonly demand: number;
  readonly opportunity: number;
}

interface MockCluster {
  readonly clusterId: number;
  readonly label: string;
  readonly memberCount: number;
  readonly maxBuildability: number;
  readonly maxOpportunity: number;
  readonly avgDemand: number;
  readonly minTopAppReviews: number;
  readonly topMembers: readonly MockClusterTopMember[];
}

interface MockMemberRow {
  readonly keyword: string;
  readonly buildability: number;
  readonly opportunity: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly trend: string;
}

function makeCluster(overrides: Partial<MockCluster> = {}): MockCluster {
  return {
    clusterId: 1,
    label: "meal planner",
    memberCount: 8,
    maxBuildability: 76,
    maxOpportunity: 0.85,
    avgDemand: 9.4,
    minTopAppReviews: 200,
    topMembers: [
      { keyword: "meal planner app", buildability: 76, demand: 12.5, opportunity: 0.85 },
      { keyword: "meal prep planner", buildability: 68, demand: 8.1, opportunity: 0.6 },
    ],
    ...overrides,
  };
}

// buildability 76 -> green/"Strong" band; 34 -> white/"Weak" band (mirrors
// the band thresholds pinned in opportunities-format.test.ts).
const ALL_CLUSTERS: readonly MockCluster[] = [
  makeCluster({ clusterId: 1, label: "meal planner", maxBuildability: 76 }),
  makeCluster({
    clusterId: 2,
    label: "habit tracker",
    memberCount: 5,
    maxBuildability: 34,
    avgDemand: 4.2,
    topMembers: [{ keyword: "habit tracker app", buildability: 34, demand: 4.2, opportunity: 0.3 }],
  }),
];

function memberRowsFor(clusterId: number): readonly MockMemberRow[] {
  if (clusterId === 1) {
    return [
      {
        keyword: "meal planner app",
        buildability: 76,
        opportunity: 0.85,
        competitiveness: 30,
        demand: 12.5,
        incumbentWeakness: 0.6,
        trend: "heating",
      },
      {
        keyword: "meal prep planner",
        buildability: 68,
        opportunity: 0.6,
        competitiveness: 40,
        demand: 8.1,
        incumbentWeakness: 0.4,
        trend: "stable",
      },
    ];
  }
  return [];
}

interface MockApiResponse {
  readonly success: boolean;
  readonly data?: unknown;
  readonly meta?: unknown;
}

let clustersToReturn: readonly MockCluster[] = ALL_CLUSTERS;

function defaultApiFetchImpl(path: string, _opts?: unknown): Promise<MockApiResponse> {
  if (path.startsWith("/api/appstore/opportunity-clusters/")) {
    const idPart = path.split("/api/appstore/opportunity-clusters/")[1]?.split("?")[0] ?? "";
    const clusterId = Number(idPart);
    return Promise.resolve({ success: true, data: memberRowsFor(clusterId) });
  }
  if (path.startsWith("/api/appstore/opportunity-clusters")) {
    return Promise.resolve({
      success: true,
      data: clustersToReturn,
      meta: { total: clustersToReturn.length, limit: 24, offset: 0 },
    });
  }
  return Promise.reject(new Error(`Unexpected apiFetch call in test: ${path}`));
}

const mockApiFetch = mock(defaultApiFetchImpl);

await mock.module("../../api", () => ({
  apiFetch: mockApiFetch,
  getToken: mock(() => null),
}));

// ─── Import component after mocks are set up ─────────────────────────────────
import ConceptsTab from "./ConceptsTab";
import { mount } from "../../test-helpers";

beforeEach(() => {
  mockApiFetch.mockClear();
  mockApiFetch.mockImplementation(defaultApiFetchImpl);
  clustersToReturn = ALL_CLUSTERS;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function callPaths(): string[] {
  return mockApiFetch.mock.calls.map((call) => call[0] as string);
}

function lastCallUrl(): URL {
  const paths = callPaths();
  const last = paths[paths.length - 1];
  if (!last) throw new Error("apiFetch was never called");
  return new URL(`http://x${last}`);
}

function findButtonByAriaLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No button found with aria-label "${label}"`);
  return button as HTMLButtonElement;
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw new Error(`No button found with text "${text}"`);
  return button as HTMLButtonElement;
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

test("renders concept cards with title-cased label, buildability badge, memberCount, and topMember chips", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  expect(container.textContent).toContain("Meal Planner");
  expect(container.textContent).toContain("Habit Tracker");
  expect(container.textContent).toContain("8 keywords");
  expect(container.textContent).toContain("5 keywords");
  expect(container.textContent).toContain("meal planner app");
  expect(container.textContent).toContain("meal prep planner");
  expect(container.textContent).toContain("habit tracker app");

  const strongBadge = container.querySelector('[aria-label="Buildability band: Strong"]');
  expect(strongBadge).toBeTruthy();
  const weakBadge = container.querySelector('[aria-label="Buildability band: Weak"]');
  expect(weakBadge).toBeTruthy();
  unmount();
});

test("shows the total count from server meta", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  expect(container.textContent).toContain("Showing 1–2 of 2");
  unmount();
});

// ─── Query building (default filters + sort) ────────────────────────────────

test("fires the clusters query with the Indie sweet-spot filters and maxBuildability sort by default", async () => {
  const { unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  const url = lastCallUrl();
  expect(url.pathname).toBe("/api/appstore/opportunity-clusters");
  expect(url.searchParams.get("sort")).toBe("maxBuildability");
  expect(url.searchParams.get("dir")).toBe("desc");
  expect(url.searchParams.get("minDemand")).toBe("5");
  expect(url.searchParams.get("maxCompetitiveness")).toBe("45");
  expect(url.searchParams.get("minIncumbentWeakness")).toBe("0.4");
  expect(url.searchParams.get("hideJunk")).toBe("true");
  unmount();
});

test("opens on the Indie sweet-spot preset as the active preset", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  const indieButton = findButtonByText(container, "Indie sweet spot");
  expect(indieButton.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).not.toContain("Custom");
  unmount();
});

test("clicking a sort control (memberCount) switches the cluster-level sort and refetches", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();
  mockApiFetch.mockClear();

  await clickButton(findButtonByAriaLabel(container, "Sort by Keywords"));

  const url = lastCallUrl();
  expect(url.searchParams.get("sort")).toBe("memberCount");
  expect(url.searchParams.get("dir")).toBe("desc");
  unmount();
});

test("clicking the same sort control twice flips direction to ascending", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  await clickButton(findButtonByAriaLabel(container, "Sort by Avg Demand"));
  mockApiFetch.mockClear();
  await clickButton(findButtonByAriaLabel(container, "Sort by Avg Demand"));

  const url = lastCallUrl();
  expect(url.searchParams.get("sort")).toBe("avgDemand");
  expect(url.searchParams.get("dir")).toBe("asc");
  unmount();
});

// ─── Expand / collapse a cluster ─────────────────────────────────────────────

test("expanding a cluster fetches its members and renders the mini member table", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  const cardToggle = findButtonByAriaLabel(container, "Expand Meal Planner");
  await clickButton(cardToggle);

  expect(
    callPaths().some((p) => p.startsWith("/api/appstore/opportunity-clusters/1?")),
  ).toBe(true);

  // Mini opportunities-style member table columns + rows.
  expect(container.textContent).toContain("Competitiveness");
  expect(container.textContent).toContain("Incumbent Weakness");
  const cells = Array.from(container.querySelectorAll("td")).map((td) => td.textContent);
  expect(cells).toContain("meal planner app");
  expect(cells).toContain("meal prep planner");

  unmount();
});

test("collapsing an expanded cluster removes the member table without refetching", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  const cardToggle = findButtonByAriaLabel(container, "Expand Meal Planner");
  await clickButton(cardToggle);
  expect(container.textContent).toContain("Incumbent Weakness");

  const collapseToggle = findButtonByAriaLabel(container, "Collapse Meal Planner");
  await clickButton(collapseToggle);
  expect(container.textContent).not.toContain("Incumbent Weakness");

  unmount();
});

test("re-expanding a previously loaded cluster does not refetch its members", async () => {
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  await clickButton(findButtonByAriaLabel(container, "Expand Meal Planner"));
  await clickButton(findButtonByAriaLabel(container, "Collapse Meal Planner"));

  mockApiFetch.mockClear();
  await clickButton(findButtonByAriaLabel(container, "Expand Meal Planner"));

  expect(
    callPaths().some((p) => p.startsWith("/api/appstore/opportunity-clusters/1")),
  ).toBe(false);
  expect(container.textContent).toContain("Incumbent Weakness");

  unmount();
});

// ─── Empty state ─────────────────────────────────────────────────────────────

test("shows the empty state when no clusters match the filters", async () => {
  clustersToReturn = [];
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  expect(container.textContent).toContain("No concepts match these filters");
  unmount();
});

test("clicking All from the empty state resets to the full corpus (no filters)", async () => {
  clustersToReturn = [];
  const { container, unmount } = mount(React.createElement(ConceptsTab, {}));
  await flush();

  clustersToReturn = ALL_CLUSTERS;
  await clickButton(findButtonByText(container, "All"));

  const url = lastCallUrl();
  expect(url.searchParams.get("hideJunk")).toBe("false");
  expect(url.searchParams.has("minDemand")).toBe(false);
  expect(container.textContent).toContain("Meal Planner");
  unmount();
});
