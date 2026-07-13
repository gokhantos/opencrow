/**
 * Isolated tests for OpportunitiesTab.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * (network) and useChart (real ECharts needs a canvas 2D context that
 * happy-dom doesn't provide), which would otherwise throw / hang in a
 * headless render. mock.module leaks across files in a shared process, so
 * this MUST run via `bun run test:isolated` (or directly, as its own file).
 *
 * The list endpoint (`GET /appstore/opportunities`) is fully server-side
 * paginated/searched/sorted, so the mock `apiFetch` implementation below
 * actually applies `search`/`sort`/`dir`/`limit`/`offset` from the query
 * string — mirroring the real backend contract closely enough to exercise
 * the component's query-building logic, not just its rendering. Every
 * column is a clickable, server-side sort key (no more client-side
 * Peak/Latest toggle, no standalone First Found column).
 */
import { test, expect, mock, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";

// ─── Mock apiFetch BEFORE importing the component ────────────────────────────

interface MockTopApp {
  readonly id: string;
  readonly name: string;
  readonly reviews: number;
  readonly rating: number;
  readonly ageDays: number;
  readonly ratingsPerDay: number;
  readonly titleMatch: boolean;
}

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
  /** Latest-scan incumbent snapshot — powers the new row-expand incumbents panel. */
  readonly topApps: readonly MockTopApp[];
}

/** Mirrors the component's `SortKey` — every column is sortable server-side. */
type SortKey =
  | "keyword"
  | "store"
  | "opportunity"
  | "competitiveness"
  | "demand"
  | "incumbentWeakness"
  | "trend"
  | "topAppReviews"
  | "avgRating"
  | "avgAgeDays";

type SortDir = "asc" | "desc";

const NOW = Math.floor(Date.now() / 1000);

/**
 * Default topApps: demand 12.5 (>= 10, "strong") + incumbentWeakness 0.6
 * (>= 0.4, "weak") on the default row below should read as a "beatable"
 * verdict — see the `keywordVerdict` unit tests further down.
 */
function defaultTopApps(): readonly MockTopApp[] {
  return [
    {
      id: "r1",
      name: "RivalTracker",
      reviews: 1800,
      rating: 3.6,
      ageDays: 400,
      ratingsPerDay: 4.5,
      titleMatch: true,
    },
    {
      id: "r2",
      name: "SecondApp",
      reviews: 900,
      rating: 4.0,
      ageDays: 200,
      ratingsPerDay: 4.5,
      titleMatch: false,
    },
  ];
}

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
    topApps: defaultTopApps(),
    ...overrides,
  };
}

const ALL_ROWS: MockOpportunityRow[] = [
  makeRow({ id: 1, keyword: "meal planner", store: "app" }),
  makeRow({
    id: 2,
    keyword: "habit tracker",
    store: "play",
    source: "seed",
    trend: "cooling",
    firstFoundAt: null,
    opportunity: 0.4,
    peakOpportunity: 0.9,
    topAppReviews: 12000,
    avgRating: 4.8,
    avgAgeDays: 900,
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

/** Generic comparator over a `MockOpportunityRow` field, honoring `dir`. */
function compareBySort(
  a: MockOpportunityRow,
  b: MockOpportunityRow,
  sort: SortKey,
  dir: SortDir,
): number {
  const av = a[sort];
  const bv = b[sort];
  const cmp =
    typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
  return dir === "asc" ? cmp : -cmp;
}

/**
 * Applies `search`/`sort`/`dir`/`limit`/`offset` from the query string
 * against `rowsToReturn`, the way the real `GET /appstore/opportunities`
 * route does — so tests can assert on the *rendered result* of a
 * search/sort/page change rather than only on the raw `apiFetch` call
 * arguments.
 */
function applyListQuery(path: string): MockApiResponse {
  const qs = path.split("?")[1] ?? "";
  const params = new URLSearchParams(qs);
  const search = params.get("search")?.trim().toLowerCase() ?? "";
  const sort = (params.get("sort") as SortKey | null) ?? "opportunity";
  const dir: SortDir = params.get("dir") === "asc" ? "asc" : "desc";
  const limit = Number(params.get("limit") ?? "50");
  const offset = Number(params.get("offset") ?? "0");

  const filtered = search
    ? rowsToReturn.filter((row) => row.keyword.toLowerCase().includes(search))
    : [...rowsToReturn];

  filtered.sort((a, b) => compareBySort(a, b, sort, dir));

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
import OpportunitiesTab, { keywordVerdict } from "./OpportunitiesTab";
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

/** Waits out the filter panel's numeric-input debounce (see FILTER_DEBOUNCE_MS = 400ms). */
async function waitForFilterDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

function callPaths(): string[] {
  return mockApiFetch.mock.calls.map((call) => call[0] as string);
}

/**
 * Sets a `<select>`'s value and fires a native `change` event.
 *
 * Unlike text `<input>`s, react-dom's select change detection listens for a
 * real `change` event rather than going through the polyfilled input-event
 * tracking that {@link typeIntoInput} has to work around — and, in this
 * happy-dom setup, `<select>` elements don't expose the `__reactProps$*` key
 * that `typeIntoInput`'s trick relies on (happy-dom backs `HTMLSelectElement`
 * with an indexed-access object, and arbitrary property assignment onto it is
 * silently dropped). A plain native event is both correct and necessary here.
 */
function selectOption(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function findSortButton(container: HTMLElement, columnLabel: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === `Sort by ${columnLabel}`,
  );
  if (!button) throw new Error(`Sort button not found for column "${columnLabel}"`);
  return button as HTMLButtonElement;
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

test("renders the leaderboard rows plus the new Store/Top App Reviews/Avg Rating/Avg Age columns", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("meal planner");
  expect(container.textContent).toContain("habit tracker");

  // Column headers.
  expect(container.textContent).toContain("Store");
  expect(container.textContent).toContain("Top App Reviews");
  expect(container.textContent).toContain("Avg Rating");
  expect(container.textContent).toContain("Avg Age (days)");

  // Store label mapping: "app" -> "App Store", "play" -> "Play".
  expect(container.textContent).toContain("App Store");
  expect(container.textContent).toContain("Play");

  // At least one formatted value from each new numeric column.
  expect(container.textContent).toContain("5,000"); // meal planner topAppReviews
  expect(container.textContent).toContain("4.2"); // meal planner avgRating
  expect(container.textContent).toContain("300"); // meal planner avgAgeDays
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

test("shows the total count and range from server meta", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("Showing 1–2 of 2");
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

// ─── Server-side sort (clickable column headers) ─────────────────────────────

test("defaults to sort=opportunity, dir=desc with the default limit/offset on the initial fetch", async () => {
  const { unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const firstCall = callPaths()[0] ?? "";
  expect(firstCall).toContain("sort=opportunity");
  expect(firstCall).toContain("dir=desc");
  expect(firstCall).toContain("limit=50");
  expect(firstCall).toContain("offset=0");
  unmount();
});

test("clicking a column header refetches with that column's sort key and dir=desc", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  mockApiFetch.mockClear();
  await clickButton(findSortButton(container, "Demand"));

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("sort=demand");
  expect(lastCall).toContain("dir=desc");
  unmount();
});

test("clicking the already-active column header toggles dir to asc", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  // "Opportunity" is already the active sort column (default dir=desc).
  mockApiFetch.mockClear();
  await clickButton(findSortButton(container, "Opportunity"));

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("sort=opportunity");
  expect(lastCall).toContain("dir=asc");
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

test("Next advances the offset by pageSize and refetches the next page", async () => {
  // Simulate a corpus larger than one page (default pageSize is 50).
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

  expect(container.textContent).toContain("Showing 1–50 of 120");
  expect(container.textContent).toContain("Page 1 of 3");

  const nextButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Next",
  ) as HTMLButtonElement;
  expect(nextButton.disabled).toBe(false);

  await clickButton(nextButton);

  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);
  expect(container.textContent).toContain("Showing 51–100 of 120");
  expect(container.textContent).toContain("Page 2 of 3");
  unmount();
});

test("changing the page size resets to page 0 and refetches with the new limit", async () => {
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
  await clickButton(nextButton);
  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);

  mockApiFetch.mockClear();
  const pageSizeSelect = container.querySelector(
    "select[aria-label='Rows per page']",
  ) as HTMLSelectElement;
  expect(pageSizeSelect).toBeTruthy();

  selectOption(pageSizeSelect, "25");
  await flush();

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("limit=25");
  expect(lastCall).toContain("offset=0");
  expect(container.textContent).toContain("Showing 1–25 of 120");
  expect(container.textContent).toContain("Page 1 of 5");
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
  await clickButton(nextButton);
  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);

  mockApiFetch.mockClear();
  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  typeIntoInput(input, "keyword-1");
  await waitForDebounce();

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("offset=0");
  unmount();
});

// ─── Watchlist star toggle ────────────────────────────────────────────────────

test("clicking the star toggles watchlist state without expanding the row", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const starButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Add meal planner to watchlist",
  ) as HTMLButtonElement;
  expect(starButton).toBeTruthy();
  expect(starButton.textContent).toBe("☆");

  await clickButton(starButton);

  const updatedButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Remove meal planner from watchlist",
  ) as HTMLButtonElement;
  expect(updatedButton).toBeTruthy();
  expect(updatedButton.textContent).toBe("★");

  // The star click uses stopPropagation, so it must not also expand the row.
  expect(container.querySelector("[data-testid='opportunity-trend-chart']")).toBeFalsy();
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

test("shows a friendly empty state when the corpus/filtered result set is empty", async () => {
  rowsToReturn = [];
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  expect(container.textContent).toContain("No keywords match these filters");
  // The empty state offers a one-click way back to the unfiltered corpus.
  const allButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "All",
  );
  expect(allButton).toBeTruthy();
  unmount();
});

// ─── Buildable-keyword filter presets ─────────────────────────────────────────
// See docs/superpowers/specs/2026-07-13-buildable-keyword-filters-design.md.

function findPresetButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  if (!button) throw new Error(`Preset button not found: "${label}"`);
  return button as HTMLButtonElement;
}

test("opens on the Indie sweet-spot preset by default (not the full corpus)", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const firstCall = callPaths()[0] ?? "";
  expect(firstCall).toContain("minDemand=5");
  expect(firstCall).toContain("maxCompetitiveness=45");
  expect(firstCall).toContain("minIncumbentWeakness=0.4");
  expect(firstCall).toContain("hideJunk=true");
  expect(firstCall).toContain("sort=opportunity");
  expect(firstCall).toContain("dir=desc");

  // The preset button itself is highlighted as active.
  const indieButton = findPresetButton(container, "Indie sweet spot");
  expect(indieButton.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).not.toContain("Custom");
  unmount();
});

test("clicking All clears every filter, sends hideJunk=false, and resets to page 0", async () => {
  rowsToReturn = Array.from({ length: 120 }, (_, i) =>
    makeRow({ id: i + 1, keyword: `keyword-${i}`, opportunity: 1 - i / 1000, peakOpportunity: 1 - i / 1000 }),
  );
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  // Move off page 0 first so the preset click's page-reset is a real assertion.
  const nextButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Next",
  ) as HTMLButtonElement;
  await clickButton(nextButton);
  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);

  mockApiFetch.mockClear();
  await clickButton(findPresetButton(container, "All"));

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("hideJunk=false");
  expect(lastCall).toContain("offset=0");
  expect(lastCall).not.toContain("minDemand=");
  expect(lastCall).not.toContain("maxCompetitiveness=");
  expect(lastCall).not.toContain("minIncumbentWeakness=");
  expect(lastCall).not.toContain("minOpportunity=");
  expect(lastCall).not.toContain("trend=");

  const allButton = findPresetButton(container, "All");
  expect(allButton.getAttribute("aria-pressed")).toBe("true");
  unmount();
});

test("clicking Heating filters by trend=heating, minDemand=3, hideJunk=true", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  mockApiFetch.mockClear();
  await clickButton(findPresetButton(container, "Heating"));

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("trend=heating");
  expect(lastCall).toContain("minDemand=3");
  expect(lastCall).toContain("hideJunk=true");
  expect(lastCall).not.toContain("maxCompetitiveness=");
  expect(lastCall).not.toContain("minIncumbentWeakness=");
  unmount();
});

test("adjusting a filter after selecting a preset switches the active state to Custom", async () => {
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();
  expect(container.textContent).not.toContain("Custom");

  const minDemandInput = container.querySelector(
    "input[aria-label='Min demand']",
  ) as HTMLInputElement;
  expect(minDemandInput).toBeTruthy();
  typeIntoInput(minDemandInput, "7");
  await waitForFilterDebounce();

  expect(container.textContent).toContain("Custom");
  const indieButton = findPresetButton(container, "Indie sweet spot");
  expect(indieButton.getAttribute("aria-pressed")).toBe("false");

  const lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("minDemand=7");
  unmount();
});

test("the trend selector and hideJunk toggle refetch immediately (no debounce) and reset to page 0", async () => {
  rowsToReturn = Array.from({ length: 120 }, (_, i) =>
    makeRow({ id: i + 1, keyword: `keyword-${i}`, opportunity: 1 - i / 1000, peakOpportunity: 1 - i / 1000 }),
  );
  const { container, unmount } = mount(React.createElement(OpportunitiesTab, {}));
  await flush();

  const nextButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Next",
  ) as HTMLButtonElement;
  await clickButton(nextButton);
  expect(callPaths().some((p) => p.includes("offset=50"))).toBe(true);

  mockApiFetch.mockClear();
  const trendSelect = container.querySelector(
    "select[aria-label='Trend filter']",
  ) as HTMLSelectElement;
  expect(trendSelect).toBeTruthy();
  selectOption(trendSelect, "cooling");
  await flush();

  let lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("trend=cooling");
  expect(lastCall).toContain("offset=0");

  mockApiFetch.mockClear();
  // Toggle's aria-label is its `label` prop ("Hide junk") whenever one is
  // supplied — see components/Toggle.tsx.
  const toggleButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Hide junk",
  ) as HTMLButtonElement;
  expect(toggleButton).toBeTruthy();
  await clickButton(toggleButton);

  lastCall = callPaths().at(-1) ?? "";
  expect(lastCall).toContain("hideJunk=false");
  expect(lastCall).toContain("offset=0");
  unmount();
});

// ─── Incumbents panel (row-expand, driven by row.topApps) ────────────────────

test("expanding a row shows top incumbents and a verdict derived from row.topApps", async () => {
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

  // meal planner's default topApps fixture: RivalTracker (1800 reviews,
  // 3.6★, titleMatch true) + SecondApp — plus demand 12.5 / incumbentWeakness
  // 0.6 should read as "beatable".
  expect(container.textContent).toContain("RivalTracker");
  expect(container.textContent).toContain("3.6★");
  expect(container.textContent).toContain("title match");
  expect(container.textContent).toContain("SecondApp");
  expect(container.textContent).toContain("Verdict");
  expect(container.textContent).toContain("beatable");
  unmount();
});

test("keywordVerdict: strong demand + weak incumbents reads as beatable, naming the top app", () => {
  const verdict = keywordVerdict({
    demand: 12.5,
    incumbentWeakness: 0.6,
    topApps: [
      { reviews: 1800, rating: 3.6 },
      { reviews: 900, rating: 4.0 },
    ],
  });
  expect(verdict).toContain("Strong demand");
  expect(verdict).toContain("weak incumbents");
  expect(verdict).toContain("beatable");
  expect(verdict).toContain("1.8K reviews");
  expect(verdict).toContain("3.6★");
});

test("keywordVerdict: moderate demand + strong incumbents reads as tough to unseat", () => {
  const verdict = keywordVerdict({
    demand: 4,
    incumbentWeakness: 0.05,
    topApps: [{ reviews: 50_000, rating: 4.8 }],
  });
  expect(verdict).toContain("Moderate demand");
  expect(verdict).toContain("tough to unseat");
});

test("keywordVerdict: moderate incumbent weakness reads as worth a closer look", () => {
  const verdict = keywordVerdict({
    demand: 6,
    incumbentWeakness: 0.25,
    topApps: [{ reviews: 3000, rating: 4.2 }],
  });
  expect(verdict).toContain("middling");
  expect(verdict).toContain("worth a closer look");
});

test("keywordVerdict: low demand reads as not worth building, regardless of incumbents", () => {
  const verdict = keywordVerdict({ demand: 0.5, incumbentWeakness: 0.6, topApps: [] });
  expect(verdict).toContain("Low demand");
  expect(verdict).toContain("not worth building");
});
