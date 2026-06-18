/**
 * Isolated tests for IntervalConfigPanel.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch,
 * which would otherwise try to reach the network. mock.module leaks across
 * files in a shared process, so this MUST use the isolated suffix.
 */
import { test, expect, mock, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";

// ─── Mock apiFetch BEFORE importing the component ────────────────────────────
const mockApiFetch = mock(async (_url: string, _opts?: unknown) => ({
  data: { intervalMs: 60000, maxItems: 50 },
}));

await mock.module("../api", () => ({
  apiFetch: mockApiFetch,
  getToken: mock(() => null),
}));

// Mock Toast so useToast doesn't explode in a headless env
const mockSuccess = mock((_msg: string) => {});
const mockError = mock((_msg: string) => {});
await mock.module("./Toast", () => ({
  useToast: () => ({ success: mockSuccess, error: mockError }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ─── Import component after mocks are set up ─────────────────────────────────
import { IntervalConfigPanel } from "./IntervalConfigPanel";
import type { IntervalConfigField } from "./IntervalConfigPanel";
import { renderHTML, mount } from "../test-helpers";

const FIELDS: readonly IntervalConfigField[] = [
  { key: "intervalMs", label: "Interval (ms)", desc: "How often to scrape", min: 1000, max: 300000, defaultValue: 60000 },
  { key: "maxItems", label: "Max Items", desc: "Max items per run", min: 1, max: 500, defaultValue: 50 },
];

beforeEach(() => {
  mockApiFetch.mockClear();
  mockSuccess.mockClear();
  mockError.mockClear();
});

// ─── Rendering ─────────────────────────────────────────────────────────────────

test("IntervalConfigPanel renders a toggle button with 'Scraper Config' text", () => {
  const html = renderHTML(
    React.createElement(IntervalConfigPanel, { scraperId: "test", fields: FIELDS }),
  );
  expect(html).toContain("Scraper Config");
});

test("IntervalConfigPanel does NOT show fields before toggle is clicked", () => {
  const html = renderHTML(
    React.createElement(IntervalConfigPanel, { scraperId: "test", fields: FIELDS }),
  );
  expect(html).not.toContain("Interval (ms)");
  expect(html).not.toContain("Max Items");
});

// ─── Toggle open ──────────────────────────────────────────────────────────────

test("IntervalConfigPanel shows 'Loading...' immediately after opening", async () => {
  // Make apiFetch hang indefinitely so we can inspect the loading state
  let resolve!: () => void;
  const hanging = new Promise<{ data: { intervalMs: number; maxItems: number } }>((res) => {
    resolve = () => res({ data: { intervalMs: 60000, maxItems: 50 } });
  });
  mockApiFetch.mockImplementation(async () => hanging);

  const { container, unmount } = mount(
    React.createElement(IntervalConfigPanel, { scraperId: "scraper-1", fields: FIELDS }),
  );

  // Open the panel
  await act(async () => {
    container.querySelector("button")!.click();
  });

  expect(container.textContent).toContain("Loading");

  // Resolve to clean up pending promise
  resolve();
  unmount();
});

test("IntervalConfigPanel shows fields after config loads", async () => {
  mockApiFetch.mockImplementation(async () => ({ data: { intervalMs: 30000, maxItems: 25 } }));

  const { container, unmount } = mount(
    React.createElement(IntervalConfigPanel, { scraperId: "scraper-2", fields: FIELDS }),
  );

  await act(async () => {
    container.querySelector("button")!.click();
    // Let microtasks and the async effect resolve
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Interval (ms)");
  expect(container.textContent).toContain("Max Items");
  unmount();
});

test("IntervalConfigPanel calls apiFetch with correct URL on open", async () => {
  mockApiFetch.mockImplementation(async () => ({ data: { intervalMs: 60000, maxItems: 50 } }));

  const { container, unmount } = mount(
    React.createElement(IntervalConfigPanel, { scraperId: "my-scraper", fields: FIELDS }),
  );

  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApiFetch).toHaveBeenCalledWith("/api/features/scraper-config/my-scraper");
  unmount();
});

test("IntervalConfigPanel only fetches once when re-opened", async () => {
  mockApiFetch.mockImplementation(async () => ({ data: { intervalMs: 60000, maxItems: 50 } }));

  const { container, unmount } = mount(
    React.createElement(IntervalConfigPanel, { scraperId: "scraper-3", fields: FIELDS }),
  );

  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  const callsAfterFirstOpen = mockApiFetch.mock.calls.length;

  // Close then reopen
  act(() => { container.querySelector("button")!.click(); });
  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
  });

  // Should not have fetched again
  expect(mockApiFetch.mock.calls.length).toBe(callsAfterFirstOpen);
  unmount();
});

test("IntervalConfigPanel shows error toast when fetch fails", async () => {
  mockApiFetch.mockImplementation(async () => { throw new Error("Network error"); });

  const { container, unmount } = mount(
    React.createElement(IntervalConfigPanel, { scraperId: "scraper-fail", fields: FIELDS }),
  );

  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockError).toHaveBeenCalledWith("Failed to load config.");
  unmount();
});
