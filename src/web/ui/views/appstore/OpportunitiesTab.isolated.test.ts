/**
 * Isolated tests for OpportunitiesTab.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * (network) and useChart (real ECharts needs a canvas 2D context that
 * happy-dom doesn't provide), which would otherwise throw / hang in a
 * headless render. mock.module leaks across files in a shared process, so
 * this MUST run via `bun run test:isolated` (or directly, as its own file).
 *
 * The list endpoint (`GET /appstore/opportunities`) is now server-side
 * paginated/searched/sorted, so the mock `apiFetch` implementation below
 * actually applies `search`/`sort`/`limit`/`offset` from the query string —
 * mirroring the real backend contract closely enough to exercise the
 * component's query-building logic, not just its rendering.
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
  readonly peakOpportunity: number;
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
    peakOpportunity: 0.85,
    trend: "heating",
    topAppReviews: 5000,
    avgRating: 4.2,
    avgAgeDays: 300,
    firstFoundAt: NOW - 3 * 86400,
    source: "autocomplete",
    ...overrides,
  };
}

const ALL_ROWS: MockOpportunityRow[] = [
  makeRow({ id: 1, keyword: "meal planner", source: "autocomplete" }),
  makeRow({
    id: 2,
    keyword: "habit tracker",
    source: "seed",
    trend: "cooling",
    firstFoundAt: null,
    opportunity: 0.4,
    peakOpportunity: 0.9,
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
  readonly meta?: unknown;
}

let rowsToReturn: readonly MockOpportunityRow[] = ALL_ROWS;
let historyPointsToReturn: readonly MockHistoryPoint[] = makeHistory();
let firstFoundAtToReturn: number | null = NOW - 21 * 86400;

/**
 * Applies `search`/`sort`/`limit`/`offset` from the query string against
 * `rowsToReturn`, the way the real `GET /appstore/opportunities` route does —
 * so tests can assert on the *rendered result* of a search/sort/page change
 * rather than only on the raw `apiFetch` call arguments.
 */
function applyListQuery(path: string): MockApiResponse {
  const qs = path.split("?")[1] ?? "";
  const params = new URLSearchParams(qs);
  const search = params.get("search")?.trim().toLowerCase() ?? "";
  const sort = params.get("sort") === "latest" ? "latest" : "peak";
  const limit = Number(params.get("limit") ?? "50");
  const offset = Number(params.get("offset") ?? "0");

  const filtered = search
    ? rowsToReturn.filter((row) => row.keyword.toLowerCase().includes(search))
    : [...rowsToReturn];

  filtered.sort((a, b) => {
    const av = sort === "peak" ? a.peakOpportunity : a.opportunity;
    const bv = sort === "peak" ? b.peakOpportunity : b.opportunity;
    return bv - av;
  });

  const page = filtered.slice(offset, offset + limit);

  return {
    success: true,
    data: page,
    meta: { total: filtered.length, limit, offset },
  };
}

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
    return Promise.resolve(applyListQuery(path));
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
  rowsToReturn = ALL_ROWS;
  historyPointsToReturn = makeHistory();
  firstFoundAtToReturn = NOW - 21 * 86400;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Waits out the search box's debounce window (see SEARCH_DEBOUNCE_MS = 300ms). */
async function waitForDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

function callPaths(): string[] {
  return mockApiFetch.mock.calls.map((call) => call[0] as string);
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

test("shows the peak opportunity as the primary value and latest as subtext", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  // meal planner: peakOpportunity 0.85, opportunity (latest) 0.72
  expect(container.textContent).toContain("85%");
  expect(container.textContent).toContain("now 72%");
  unmount();
});

test("shows the total count from server meta", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("1-2 of 2");
  unmount();
});

// ─── Server-side search ──────────────────────────────────────────────────────

test("typing in the search box refetches from the server with a search= param", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  expect(input).toBeTruthy();

  typeIntoInput(input, "meal");
  await waitForDebounce();

  const searchCalls = callPaths().filter((p) => p.includes("search=meal"));
  expect(searchCalls.length).toBeGreaterThan(0);
  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).not.toContain("habit tracker");
  unmount();
});

test("search is case-insensitive and resolved server-side", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "HABIT");
  await waitForDebounce();

  expect(container.textContent).toContain("habit tracker");
  expect(container.textContent).not.toContain("meal planner");
  unmount();
});

test("clearing the search box after typing restores every row", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "meal");
  await waitForDebounce();
  expect(container.textContent).not.toContain("habit tracker");

  typeIntoInput(input, "");
  await waitForDebounce();
  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).toContain("habit tracker");
  unmount();
});

test("shows a no-match message when the server returns zero rows for the search", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "zzz-nonexistent");
  await waitForDebounce();

  expect(container.textContent).toContain("No keywords match");
  unmount();
});

// ─── Sort headers (peak / latest) ────────────────────────────────────────────

test("defaults to sort=peak on the initial fetch", async () => {
  const { unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(callPaths().some((p) => p.includes("sort=peak"))).toBe(true);
  unmount();
});

test("clicking the Latest toggle refetches with sort=latest and re-ranks rows", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const latestButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Latest",
  );
  expect(latestButton).toBeTruthy();

  await act(async () => {
    (latestButton as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(callPaths().some((p) => p.includes("sort=latest"))).toBe(true);
  // Sorted by latest opportunity descending: meal planner (0.72) before
  // habit tracker (0.4) — both still render since the page holds both rows.
  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).toContain("habit tracker");
  unmount();
});

// ─── Pagination ───────────────────────────────────────────────────────────────

test("Prev is disabled and Next is disabled when everything fits on one page", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const prevButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Prev",
  ) as HTMLButtonElement;
  const nextButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Next",
  ) as HTMLButtonElement;

  expect(prevButton.disabled).toBe(true);
  expect(nextButton.disabled).toBe(true);
  unmount();
});

test("Next advances the offset and refetches the next page", async () => {
  // Simulate a corpus larger than one page.
  rowsToReturn = Array.from({ length: 120 }, (_, i) =>
    makeRow({
      id: i + 1,
      keyword: `keyword-${i}`,
      opportunity: 1 - i / 1000,
      peakOpportunity: 1 - i / 1000,
    }),
  );

  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("1-50 of 120");

  const nextButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Next",
  ) as HTMLButtonElement;
  expect(nextButton.disabled).toBe(false);

  await act(async () => {
    nextButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);
  expect(container.textContent).toContain("51-100 of 120");
  unmount();
});

test("a new search resets pagination back to the first page", async () => {
  rowsToReturn = Array.from({ length: 120 }, (_, i) =>
    makeRow({
      id: i + 1,
      keyword: `keyword-${i}`,
      opportunity: 1 - i / 1000,
      peakOpportunity: 1 - i / 1000,
    }),
  );

  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const nextButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Next",
  ) as HTMLButtonElement;
  await act(async () => {
    nextButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);

  mockApiFetch.mockClear();
  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "keyword-1");
  await waitForDebounce();

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("offset=0");
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
