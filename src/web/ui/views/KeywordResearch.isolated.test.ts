/**
 * Isolated tests for the KeywordResearch view.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * and useToast, which would otherwise hit the network / throw outside a
 * <ToastProvider>. mock.module leaks across files in a shared process, so
 * this MUST run via `bun run test:isolated` (or directly, as its own file).
 */
import { test, expect, mock, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";

// ─── Mock apiFetch BEFORE importing the component ────────────────────────────
//
// Dispatch by path: OpportunitiesTab (rendered inside KeywordResearch) fetches
// `/api/appstore/opportunities`, ConceptsTab (the "Concepts" toggle target)
// fetches `/api/appstore/opportunity-clusters`, and the "Generate ideas"
// button POSTs to `/api/pipelines/mobile-app-ideas/run`.
interface MockApiResponse {
  readonly success: boolean;
  readonly data?: readonly unknown[];
  readonly meta?: { readonly total: number; readonly limit: number; readonly offset: number };
  readonly message?: string;
  readonly runId?: string;
}

function defaultApiFetchImpl(path: string, _opts?: unknown): Promise<MockApiResponse> {
  if (path.startsWith("/api/appstore/opportunity-clusters")) {
    return Promise.resolve({ success: true, data: [], meta: { total: 0, limit: 24, offset: 0 } });
  }
  if (path.startsWith("/api/appstore/opportunities")) {
    return Promise.resolve({ success: true, data: [] });
  }
  if (path.startsWith("/api/pipelines/")) {
    return Promise.resolve({ success: true, message: "Pipeline started", runId: "run-abc123" });
  }
  return Promise.reject(new Error(`Unexpected apiFetch call in test: ${path}`));
}

const mockApiFetch = mock(defaultApiFetchImpl);

await mock.module("../api", () => ({
  apiFetch: mockApiFetch,
  getToken: mock(() => null),
}));

// Mock Toast so useToast doesn't require a <ToastProvider> in a headless render.
const mockSuccess = mock((_msg: string) => {});
const mockError = mock((_msg: string) => {});
await mock.module("../components/Toast", () => ({
  useToast: () => ({ success: mockSuccess, error: mockError, warning: mock(), info: mock() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ─── Import component after mocks are set up ─────────────────────────────────
import KeywordResearch from "./KeywordResearch";
import { renderHTML, mount } from "../test-helpers";

beforeEach(() => {
  mockApiFetch.mockClear();
  mockApiFetch.mockImplementation(defaultApiFetchImpl);
  mockSuccess.mockClear();
  mockError.mockClear();
});

// ─── Rendering ─────────────────────────────────────────────────────────────────

test("KeywordResearch renders the page title and generate-ideas button", () => {
  const html = renderHTML(React.createElement(KeywordResearch, {}));
  expect(html).toContain("Keyword Research");
  expect(html).toContain("Generate ideas from these keywords");
});

test("KeywordResearch shows an empty state when there are no opportunities", async () => {
  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("No opportunities yet");
  unmount();
});

// ─── Generate ideas button ──────────────────────────────────────────────────

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button found with text "${text}"`);
  return button as HTMLButtonElement;
}

test("clicking the generate-ideas button POSTs to the mobile-app-ideas pipeline", async () => {
  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const button = findButtonByText(container, "Generate ideas from these keywords");
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApiFetch).toHaveBeenCalledWith("/api/pipelines/mobile-app-ideas/run", {
    method: "POST",
  });
  unmount();
});

test("disables the button while the request is in flight", async () => {
  let resolve!: () => void;
  const hanging = new Promise<MockApiResponse>((res) => {
    resolve = () => res({ success: true, message: "Pipeline started", runId: "run-pending" });
  });
  mockApiFetch.mockImplementation((path: string): Promise<MockApiResponse> => {
    if (path.startsWith("/api/appstore/opportunities")) {
      return Promise.resolve({ success: true, data: [] });
    }
    return hanging;
  });

  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const button = findButtonByText(container, "Generate ideas");
  act(() => {
    button.click();
  });

  expect(button.disabled).toBe(true);

  await act(async () => {
    resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  unmount();
});

test("shows a success banner with the run id and calls toast.success", async () => {
  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const button = findButtonByText(container, "Generate ideas from these keywords");
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("run-abc123");
  expect(mockSuccess).toHaveBeenCalledWith("Idea generation started (run run-abc123)");
  unmount();
});

test("shows an error banner and calls toast.error when the request fails", async () => {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/appstore/opportunities")) return { success: true, data: [] };
    throw new Error("Network error");
  });

  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const button = findButtonByText(container, "Generate ideas from these keywords");
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Network error");
  expect(mockError).toHaveBeenCalledWith("Network error");
  unmount();
});

test("navigateTo is called when 'View Pipeline Ideas' is clicked after success", async () => {
  const navigateTo = mock((_tab: string) => {});
  const { container, unmount } = mount(
    React.createElement(KeywordResearch, { navigateTo }),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const button = findButtonByText(container, "Generate ideas from these keywords");
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  const link = findButtonByText(container, "View Pipeline Ideas");
  act(() => {
    link.click();
  });

  expect(navigateTo).toHaveBeenCalledWith("pipeline-ideas");
  unmount();
});

// ─── Keywords | Concepts toggle ─────────────────────────────────────────────

test("defaults to the Keywords view and does not fetch clusters until toggled", async () => {
  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("No opportunities yet");
  expect(
    mockApiFetch.mock.calls.some((call) =>
      (call[0] as string).startsWith("/api/appstore/opportunity-clusters"),
    ),
  ).toBe(false);
  unmount();
});

test("clicking Concepts switches the view and fires the clusters query; clicking Keywords switches back", async () => {
  const { container, unmount } = mount(React.createElement(KeywordResearch, {}));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const conceptsTab = findButtonByText(container, "Concepts");
  await act(async () => {
    conceptsTab.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    mockApiFetch.mock.calls.some((call) =>
      (call[0] as string).startsWith("/api/appstore/opportunity-clusters"),
    ),
  ).toBe(true);
  expect(container.textContent).toContain("No concepts match these filters");
  expect(container.textContent).not.toContain("No opportunities yet");

  const keywordsTab = findButtonByText(container, "Keywords");
  await act(async () => {
    keywordsTab.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("No opportunities yet");
  unmount();
});
