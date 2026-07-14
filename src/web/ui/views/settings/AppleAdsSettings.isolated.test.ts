/**
 * Isolated tests for the AppleAdsSettings panel.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace apiFetch
 * and useToast, which would otherwise hit the network / throw outside a
 * <ToastProvider>. mock.module leaks across files in a shared process, so
 * this MUST run via `bun run test:isolated` (or directly, as its own file).
 */
import { test, expect, mock, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";

interface MockApiResponse {
  readonly data?: unknown;
}

const DEFAULT_STATUS = {
  clientIdSet: false,
  teamIdSet: false,
  keyIdSet: false,
  orgIdSet: false,
  privateKeySet: false,
  configured: false,
};

function defaultApiFetchImpl(path: string, opts?: { method?: string }): Promise<MockApiResponse> {
  const method = opts?.method ?? "GET";
  if (path === "/api/appstore/apple-ads/config" && method === "GET") {
    return Promise.resolve({ data: DEFAULT_STATUS });
  }
  if (path === "/api/appstore/apple-ads/config" && method === "POST") {
    return Promise.resolve({ data: undefined });
  }
  if (path === "/api/appstore/apple-ads/test" && method === "POST") {
    return Promise.resolve({ data: { ok: false, error: "not configured" } });
  }
  if (path === "/api/appstore/apple-ads/probe" && method === "POST") {
    return Promise.resolve({ data: { state: "COMPLETED", rowCount: 0, sample: [] } });
  }
  return Promise.reject(new Error(`Unexpected apiFetch call in test: ${method} ${path}`));
}

const mockApiFetch = mock(defaultApiFetchImpl);

await mock.module("../../api", () => ({
  apiFetch: mockApiFetch,
  getToken: mock(() => null),
}));

const mockSuccess = mock((_msg: string) => {});
const mockError = mock((_msg: string) => {});
await mock.module("../../components/Toast", () => ({
  useToast: () => ({ success: mockSuccess, error: mockError, warning: mock(), info: mock() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import AppleAdsSettings from "./AppleAdsSettings";
import { mount, typeIntoInput } from "../../test-helpers";

beforeEach(() => {
  mockApiFetch.mockClear();
  mockApiFetch.mockImplementation(defaultApiFetchImpl);
  mockSuccess.mockClear();
  mockError.mockClear();
});

function flush() {
  return act(async () => {
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

function getInput(container: HTMLElement, id: string): HTMLInputElement {
  const el = container.querySelector(`#${id}`);
  if (!el) throw new Error(`No element found with id "${id}"`);
  return el as HTMLInputElement;
}

function getTextarea(container: HTMLElement, id: string): HTMLTextAreaElement {
  const el = container.querySelector(`#${id}`);
  if (!el) throw new Error(`No element found with id "${id}"`);
  return el as HTMLTextAreaElement;
}

// ─── Rendering / status ─────────────────────────────────────────────────────

test("AppleAdsSettings loads and renders 'not set' status for every field", async () => {
  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  expect(mockApiFetch).toHaveBeenCalledWith("/api/appstore/apple-ads/config");
  expect(container.textContent).toContain("Apple Ads (Search Ads)");
  // 5 field pills + 1 overall status pill, all "not set"
  const notSetCount = (container.textContent?.match(/not set/g) ?? []).length;
  expect(notSetCount).toBe(6);
  unmount();
});

test("AppleAdsSettings renders 'set' status when credentials are configured", async () => {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/api/appstore/apple-ads/config" && (opts?.method ?? "GET") === "GET") {
      return Promise.resolve({
        data: {
          clientIdSet: true,
          teamIdSet: true,
          keyIdSet: true,
          orgIdSet: true,
          privateKeySet: true,
          configured: true,
        },
      });
    }
    return defaultApiFetchImpl(path, opts);
  });

  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  const pillSpans = Array.from(container.querySelectorAll("span")).filter(
    (s) => s.textContent?.trim() === "set",
  );
  expect(pillSpans.length).toBe(6);
  expect(container.textContent).not.toContain("not set");
  unmount();
});

// ─── Save ────────────────────────────────────────────────────────────────────

test("Save button is disabled until all 5 fields are filled, then POSTs them", async () => {
  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  const saveButton = findButtonByText(container, "Save");
  expect(saveButton.disabled).toBe(true);

  typeIntoInput(getInput(container, "apple-ads-client-id"), "client-123");
  typeIntoInput(getInput(container, "apple-ads-team-id"), "team-123");
  typeIntoInput(getInput(container, "apple-ads-key-id"), "key-123");
  typeIntoInput(getInput(container, "apple-ads-org-id"), "org-123");
  expect(saveButton.disabled).toBe(true);

  typeIntoInput(
    getTextarea(container, "apple-ads-private-key"),
    "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----",
  );
  expect(saveButton.disabled).toBe(false);

  await act(async () => {
    saveButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApiFetch).toHaveBeenCalledWith("/api/appstore/apple-ads/config", {
    method: "POST",
    body: JSON.stringify({
      clientId: "client-123",
      teamId: "team-123",
      keyId: "key-123",
      orgId: "org-123",
      privateKey: "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----",
    }),
  });
  expect(mockSuccess).toHaveBeenCalledWith("Apple Ads credentials saved.");
  unmount();
});

test("shows a toast error and does not clear the form when save fails", async () => {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (path === "/api/appstore/apple-ads/config" && method === "GET") {
      return Promise.resolve({ data: DEFAULT_STATUS });
    }
    if (path === "/api/appstore/apple-ads/config" && method === "POST") {
      return Promise.reject(new Error("boom"));
    }
    return defaultApiFetchImpl(path, opts);
  });

  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  typeIntoInput(getInput(container, "apple-ads-client-id"), "a");
  typeIntoInput(getInput(container, "apple-ads-team-id"), "b");
  typeIntoInput(getInput(container, "apple-ads-key-id"), "c");
  typeIntoInput(getInput(container, "apple-ads-org-id"), "d");
  typeIntoInput(getTextarea(container, "apple-ads-private-key"), "e");

  const saveButton = findButtonByText(container, "Save");
  await act(async () => {
    saveButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockError).toHaveBeenCalledWith("Failed to save Apple Ads credentials.");
  unmount();
});

// ─── Test connection ─────────────────────────────────────────────────────────

test("Test connection shows a green banner with org name on success", async () => {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/api/appstore/apple-ads/test") {
      return Promise.resolve({ data: { ok: true, orgName: "Acme Org" } });
    }
    return defaultApiFetchImpl(path, opts);
  });

  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  const testButton = findButtonByText(container, "Test connection");
  await act(async () => {
    testButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Connected");
  expect(container.textContent).toContain("Acme Org");
  unmount();
});

test("Test connection shows a red banner with the error on failure", async () => {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/api/appstore/apple-ads/test") {
      return Promise.resolve({ data: { ok: false, error: "not configured" } });
    }
    return defaultApiFetchImpl(path, opts);
  });

  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  const testButton = findButtonByText(container, "Test connection");
  await act(async () => {
    testButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("not configured");
  unmount();
});

test("Test connection button is disabled while in flight", async () => {
  let resolve!: () => void;
  const hanging = new Promise<MockApiResponse>((res) => {
    resolve = () => res({ data: { ok: true, orgName: "Acme" } });
  });
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/api/appstore/apple-ads/test") return hanging;
    return defaultApiFetchImpl(path, opts);
  });

  const { container, unmount } = mount(React.createElement(AppleAdsSettings, {}));
  await flush();

  const testButton = findButtonByText(container, "Test connection");
  act(() => {
    testButton.click();
  });
  expect(testButton.disabled).toBe(true);

  await act(async () => {
    resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  unmount();
});
