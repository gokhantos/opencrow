/**
 * Isolated tests for OpportunitiesTab.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * (network) and useChart (real ECharts needs a canvas 2D context that
 * happy-dom doesn't provide), which would otherwise throw / hang in a
 * headless render. mock.module leaks across files in a shared process, so
 * this MUST run via `bun run test:isolated` (or directly, as its own file).
 */
import { test, expect, mock, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";

// ─── Mock apiFetch BEFORE importing the component ────────────────────────────

interface MockOpportunityRow {
  readonly id: number;
  readonly keyword: string;
  readonly store: "app" | "play";
  readonly scannedAt: number;
  readonly competitiveness: number;
  readonly demand: number;
  readonly incumbentWeakness: number;
  readonly opportunity: number;
  readonly trend: string;
  readonly topAppReviews: number;
  readonly avgRating: number;
  readonly avgAgeDays: number;
  readonly firstFoundAt: number | null;
  readonly source: string | null;
}

const NOW = Math.floor(Date.now() / 1000);

function makeRow(overrides: Partial<MockOpportunityRow> = {}): MockOpportunityRow {
  return {
    id: 1,
    keyword: "meal planner",
    store: "app",
    scannedAt: NOW,
    competitiveness: 42,
    demand: 12.5,
    incumbentWeakness: 0.6,
    opportunity: 0.72,
    trend: "heating",
    topAppReviews: 5000,
    avgRating: 4.2,
    avgAgeDays: 300,
    firstFoundAt: NOW - 3 * 86400,
    source: "autocomplete",
    ...overrides,
  };
}

const DEFAULT_ROWS: MockOpportunityRow[] = [
  makeRow({ id: 1, keyword: "meal planner", source: "autocomplete" }),
  makeRow({
    id: 2,
    keyword: "habit tracker",
    source: "seed",
    trend: "cooling",
    firstFoundAt: null,
  }),
];

interface MockHistoryPoint {
  readonly scannedAt: number;
  readonly opportunity: number;
  readonly demand: number;
  readonly competitiveness: number;
  readonly incumbentWeakness: number;
  readonly trend: string;
  readonly topApps: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly reviews: number;
    readonly rating: number;
  }>;
}

function makeHistory(): readonly MockHistoryPoint[] {
  // Newest-first, mirroring `ORDER BY scanned_at DESC`.
  return [
    {
      scannedAt: NOW,
      opportunity: 0.72,
      demand: 12.5,
      competitiveness: 42,
      incumbentWeakness: 0.6,
      trend: "heating",
      topApps: [
        { id: "a1", name: "MealMate", reviews: 12000, rating: 4.5 },
        { id: "a2", name: "PlateUp", reviews: 8000, rating: 4.1 },
      ],
    },
    {
      scannedAt: NOW - 7 * 86400,
      opportunity: 0.6,
      demand: 10,
      competitiveness: 40,
      incumbentWeakness: 0.55,
      trend: "stable",
      topApps: [{ id: "a1", name: "MealMate", reviews: 11000, rating: 4.4 }],
    },
    {
      scannedAt: NOW - 14 * 86400,
      opportunity: 0.5,
      demand: 8,
      competitiveness: 38,
      incumbentWeakness: 0.5,
      trend: "new",
      topApps: [{ id: "a1", name: "MealMate", reviews: 9000, rating: 4.3 }],
    },
  ];
}

interface MockApiResponse {
  readonly success: boolean;
  readonly data?: unknown;
}

let rowsToReturn: readonly MockOpportunityRow[] = DEFAULT_ROWS;
let historyPointsToReturn: readonly MockHistoryPoint[] = makeHistory();
let firstFoundAtToReturn: number | null = NOW - 21 * 86400;

function defaultApiFetchImpl(path: string, _opts?: unknown): Promise<MockApiResponse> {
  if (path.startsWith("/api/appstore/opportunities/")) {
    return Promise.resolve({
      success: true,
      data: {
        history: historyPointsToReturn,
        meta: {
          keyword: "meal planner",
          firstFoundAt: firstFoundAtToReturn,
          source: "autocomplete",
        },
      },
    });
  }
  if (path.startsWith("/api/appstore/opportunities")) {
    return Promise.resolve({ success: true, data: rowsToReturn });
  }
  return Promise.reject(new Error(`Unexpected apiFetch call in test: ${path}`));
}

const mockApiFetch = mock(defaultApiFetchImpl);

await mock.module("../../api", () => ({
  apiFetch: mockApiFetch,
  getToken: mock(() => null),
}));

// Real ECharts needs a canvas 2D rendering context that happy-dom doesn't
// implement; stub the shared useChart hook so the chart container still
// mounts (as an empty div) without touching echarts internals.
const mockUseChart = mock(() => {});
await mock.module("../../lib/useChart", () => ({
  useChart: mockUseChart,
}));

// ─── Import component after mocks are set up ─────────────────────────────────
import OpportunitiesTab from "./OpportunitiesTab";
import { mount, typeIntoInput } from "../../test-helpers";

beforeEach(() => {
  mockApiFetch.mockClear();
  mockApiFetch.mockImplementation(defaultApiFetchImpl);
  mockUseChart.mockClear();
  rowsToReturn = DEFAULT_ROWS;
  historyPointsToReturn = makeHistory();
  firstFoundAtToReturn = NOW - 21 * 86400;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

test("renders the leaderboard with both rows and a First Found column", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).toContain("habit tracker");
  expect(container.textContent).toContain("First Found");
  unmount();
});

test("shows a source badge and relative date for a known firstFoundAt", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("Autocomplete");
  expect(container.textContent).toContain("3d ago");
  unmount();
});

test("renders a dash and an Unknown badge when firstFoundAt is null", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  // "habit tracker" was seeded with firstFoundAt: null, source: "seed".
  expect(container.textContent).toContain("Seed");
  unmount();
});

// ─── Search filter ───────────────────────────────────────────────────────────

test("typing in the search box narrows the visible rows", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  expect(input).toBeTruthy();

  typeIntoInput(input, "meal");

  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).not.toContain("habit tracker");
  unmount();
});

test("search is case-insensitive", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "HABIT");

  expect(container.textContent).toContain("habit tracker");
  expect(container.textContent).not.toContain("meal planner");
  unmount();
});

test("clearing the search box after typing restores every row", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "meal");
  expect(container.textContent).not.toContain("habit tracker");

  typeIntoInput(input, "");
  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).toContain("habit tracker");
  unmount();
});

test("shows a no-match message when the search filter excludes every row", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "zzz-nonexistent");

  expect(container.textContent).toContain("No keywords match");
  unmount();
});

// ─── Row expand → trend chart + detail ──────────────────────────────────────

test("expanding a row fetches history and renders the trend chart container + detail block", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const row = Array.from(container.querySelectorAll("tr")).find((tr) =>
    tr.textContent?.includes("meal planner"),
  );
  expect(row).toBeTruthy();

  await act(async () => {
    (row as HTMLTableRowElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApiFetch).toHaveBeenCalledWith(
    "/api/appstore/opportunities/meal%20planner?limit=30",
    expect.objectContaining({ signal: expect.anything() }),
  );

  expect(container.querySelector("[data-testid='opportunity-trend-chart']")).toBeTruthy();
  // Detail block: first-found relative date + source badge + top incumbent.
  expect(container.textContent).toContain("First found");
  expect(container.textContent).toContain("MealMate");
  unmount();
});

test("collapsing an expanded row hides the trend chart", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const row = Array.from(container.querySelectorAll("tr")).find((tr) =>
    tr.textContent?.includes("meal planner"),
  );

  await act(async () => {
    (row as HTMLTableRowElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector("[data-testid='opportunity-trend-chart']")).toBeTruthy();

  await act(async () => {
    (row as HTMLTableRowElement).click();
    await Promise.resolve();
  });
  expect(container.querySelector("[data-testid='opportunity-trend-chart']")).toBeFalsy();
  unmount();
});

test("renders 'Not enough scan history yet' when history has fewer than 2 points", async () => {
  historyPointsToReturn = [makeHistory()[0]!];
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const row = Array.from(container.querySelectorAll("tr")).find((tr) =>
    tr.textContent?.includes("meal planner"),
  );
  await act(async () => {
    (row as HTMLTableRowElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Not enough scan history yet.");
  unmount();
});

test("shows an empty state when there are no opportunities at all", async () => {
  rowsToReturn = [];
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("No opportunities yet");
  unmount();
});
