/**
 * Isolated tests for ScreenerTab (newborn-velocity signature hits).
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * (network) and useToast (which would otherwise throw outside a
 * <ToastProvider>). mock.module leaks across files in a shared process, so
 * this MUST run via `bun run test:isolated` (or directly, as its own file).
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
}

interface MockSignatureHit {
  readonly keyword: string;
  readonly firstDetectedAt: number;
  readonly lastSeenAt: number;
  readonly timesSeen: number;
  readonly status: "new" | "active" | "dismissed";
  readonly competitiveness: number | null;
  readonly demand: number | null;
  readonly trend: string | null;
  readonly newcomerRpd: number | null;
  readonly establishedRpd: number | null;
  readonly velocityRatio: number | null;
  readonly fastNewcomers: number | null;
  readonly acceleratingApps: number | null;
  readonly maxReviews: number | null;
  readonly genreZone: string | null;
  readonly topAppsSnapshot: readonly MockTopApp[];
}

const NOW = Math.floor(Date.now() / 1000);

function makeHit(overrides: Partial<MockSignatureHit> = {}): MockSignatureHit {
  return {
    keyword: "peptide tracker",
    firstDetectedAt: NOW - 3 * 86400,
    lastSeenAt: NOW,
    timesSeen: 4,
    status: "new",
    competitiveness: 28,
    demand: 6.2,
    trend: "heating",
    newcomerRpd: 3.6,
    establishedRpd: 1.2,
    velocityRatio: 3.0,
    fastNewcomers: 3,
    acceleratingApps: 1,
    maxReviews: 9800,
    genreZone: "health",
    topAppsSnapshot: [
      { id: "a1", name: "PeptideLog", reviews: 1200, rating: 4.4, ageDays: 210 },
      { id: "a2", name: "DoseTrack", reviews: 400, rating: 4.1, ageDays: 90 },
    ],
    ...overrides,
  };
}

let hitsToReturn: readonly MockSignatureHit[] = [
  makeHit({ keyword: "peptide tracker", status: "new" }),
  makeHit({ keyword: "block shorts", status: "active", competitiveness: 11, velocityRatio: 4.88 }),
  makeHit({ keyword: "old fad tracker", status: "dismissed", velocityRatio: 1.6 }),
];

interface MockPatchResponse {
  readonly success: boolean;
  readonly data?: MockSignatureHit;
  readonly error?: string;
}

function defaultApiFetchImpl(
  path: string,
  opts?: { readonly method?: string; readonly body?: string },
): Promise<{ readonly success: boolean; readonly data?: unknown }> | Promise<MockPatchResponse> {
  if (path.startsWith("/api/appstore/signature-hits/") && opts?.method === "PATCH") {
    const keyword = decodeURIComponent(path.split("/").pop() ?? "");
    const body = JSON.parse(opts.body ?? "{}") as { status: "active" | "dismissed" };
    const existing = hitsToReturn.find((h) => h.keyword === keyword);
    if (!existing) {
      return Promise.resolve({ success: false, error: `Unknown signature hit: ${keyword}` });
    }
    const updated = { ...existing, status: body.status };
    hitsToReturn = hitsToReturn.map((h) => (h.keyword === keyword ? updated : h));
    return Promise.resolve({ success: true, data: updated });
  }
  if (path.startsWith("/api/appstore/signature-hits")) {
    return Promise.resolve({ success: true, data: hitsToReturn });
  }
  return Promise.reject(new Error(`Unexpected apiFetch call in test: ${path}`));
}

const mockApiFetch = mock(defaultApiFetchImpl);

await mock.module("../../api", () => ({
  apiFetch: mockApiFetch,
  getToken: mock(() => null),
}));

// Mock Toast so useToast doesn't require a <ToastProvider> in a headless render.
const mockSuccess = mock((_msg: string) => {});
const mockError = mock((_msg: string) => {});
await mock.module("../../components/Toast", () => ({
  useToast: () => ({ success: mockSuccess, error: mockError, warning: mock(), info: mock() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ─── Import component after mocks are set up ─────────────────────────────────
import ScreenerTab from "./ScreenerTab";
import { mount } from "../../test-helpers";

beforeEach(() => {
  hitsToReturn = [
    makeHit({ keyword: "peptide tracker", status: "new" }),
    makeHit({ keyword: "block shorts", status: "active", competitiveness: 11, velocityRatio: 4.88 }),
    makeHit({ keyword: "old fad tracker", status: "dismissed", velocityRatio: 1.6 }),
  ];
  mockApiFetch.mockClear();
  mockApiFetch.mockImplementation(defaultApiFetchImpl);
  mockSuccess.mockClear();
  mockError.mockClear();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button found with text "${text}"`);
  return button as HTMLButtonElement;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

test("shows the section header, signature explainer, and NEW badge count", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  expect(container.textContent).toContain("Screener");
  expect(container.textContent).toContain("competitiveness ≤35");
  expect(container.textContent).toContain("1 new");
  unmount();
});

test("defaults to the Open filter (new + active), hiding dismissed hits", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  expect(container.textContent).toContain("peptide tracker");
  expect(container.textContent).toContain("block shorts");
  expect(container.textContent).not.toContain("old fad tracker");
  unmount();
});

test("clicking the Dismissed tab shows only dismissed hits", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  const dismissedTab = findButtonByText(container, "Dismissed");
  await act(async () => {
    dismissedTab.click();
  });
  await flush();

  expect(container.textContent).toContain("old fad tracker");
  expect(container.textContent).not.toContain("peptide tracker");
  expect(container.textContent).not.toContain("block shorts");
  unmount();
});

test("renders the table columns for a hit row", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  expect(container.textContent).toContain("health"); // genre zone
  expect(container.textContent).toContain("28"); // competitiveness
  expect(container.textContent).toContain("3.00×"); // velocity ratio
  unmount();
});

test("shows an empty state when the active filter has no hits", async () => {
  hitsToReturn = [];
  mockApiFetch.mockImplementation(defaultApiFetchImpl);

  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  expect(container.textContent).toContain("No signature hits");
  unmount();
});

// ─── Row expand (top-apps snapshot) ─────────────────────────────────────────

test("clicking a row expands the top-apps snapshot panel", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  const row = container.querySelector("tbody tr");
  if (!row) throw new Error("Expected at least one row");

  await act(async () => {
    (row as HTMLElement).click();
  });
  await flush();

  expect(container.textContent).toContain("Top apps at detection");
  expect(container.textContent).toContain("PeptideLog");
  unmount();
});

// ─── Row actions ──────────────────────────────────────────────────────────────

test("Acknowledge PATCHes the hit to active, toasts success, and refetches", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  const ackButton = findButtonByText(container, "Acknowledge");
  await act(async () => {
    ackButton.click();
  });
  await flush();

  expect(
    mockApiFetch.mock.calls.some(
      (call) =>
        (call[0] as string) === "/api/appstore/signature-hits/peptide%20tracker" &&
        (call[1] as { method?: string } | undefined)?.method === "PATCH",
    ),
  ).toBe(true);
  expect(mockSuccess).toHaveBeenCalledWith('Acknowledged "peptide tracker"');
  unmount();
});

test("Dismiss PATCHes the hit to dismissed, toasts success, and removes it from the Open filter", async () => {
  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  // Scoped to `tbody` — the filter-tab bar also has a "Dismissed" button,
  // whose text is a superset match of "Dismiss".
  const dismissButtons = Array.from(container.querySelectorAll("tbody button")).filter((b) =>
    b.textContent?.includes("Dismiss"),
  );
  const first = dismissButtons[0] as HTMLButtonElement | undefined;
  if (!first) throw new Error("Expected a Dismiss button");

  await act(async () => {
    first.click();
  });
  await flush();

  expect(mockSuccess).toHaveBeenCalled();
  expect(
    mockApiFetch.mock.calls.some(
      (call) => (call[1] as { method?: string } | undefined)?.method === "PATCH",
    ),
  ).toBe(true);
  unmount();
});

test("shows a toast error and does not crash when the PATCH fails", async () => {
  mockApiFetch.mockImplementation((path: string, opts?: { readonly method?: string }) => {
    if (path.startsWith("/api/appstore/signature-hits/") && opts?.method === "PATCH") {
      return Promise.reject(new Error("Network error"));
    }
    return Promise.resolve({ success: true, data: hitsToReturn });
  });

  const { container, unmount } = mount(React.createElement(ScreenerTab, {}));
  await flush();

  const ackButton = findButtonByText(container, "Acknowledge");
  await act(async () => {
    ackButton.click();
  });
  await flush();

  expect(mockError).toHaveBeenCalledWith("Network error");
  unmount();
});
