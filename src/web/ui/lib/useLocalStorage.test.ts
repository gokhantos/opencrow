/**
 * Unit tests for useLocalStorage hook.
 *
 * Lane: unit (*.test.ts) — pure hook logic, no DB or module mocking needed.
 * Uses happy-dom via test-helpers.ts which sets up globalThis.window/document.
 *
 * Strategy: mount a minimal Wrapper that exposes the stored value via a
 * data attribute and a button to call the setter, so we can drive the hook
 * from the DOM without reaching into React internals.
 */
import { test, expect, beforeEach } from "bun:test";
import React from "react";
import { act } from "react";
import { mount } from "../test-helpers";
import { useLocalStorage } from "./useLocalStorage";

// ─── localStorage stub ───────────────────────────────────────────────────────
// happy-dom may not supply a full localStorage; provide a simple in-memory one.
const store: Record<string, string> = {};
const mockStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; },
  key: (_i: number) => null,
  length: 0,
};

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    writable: true,
    configurable: true,
  });
} else {
  // Replace the existing one so our store map drives it
  Object.assign(globalThis.localStorage, mockStorage);
}

// Also ensure window.localStorage matches globalThis.localStorage
if ((globalThis as any).window && !(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = globalThis.localStorage;
}

beforeEach(() => {
  mockStorage.clear();
});

// ─── Wrapper helpers ──────────────────────────────────────────────────────────

function makeWrapper(storageKey: string, defaultVal: string) {
  return function Wrapper() {
    const [value, setValue] = useLocalStorage(storageKey, defaultVal);
    return React.createElement(
      "div",
      { "data-value": value },
      React.createElement("button", {
        "data-testid": "set-hello",
        onClick: () => setValue("hello"),
      }),
      React.createElement("button", {
        "data-testid": "set-world",
        onClick: () => setValue("world"),
      }),
      React.createElement("button", {
        "data-testid": "set-fn",
        onClick: () => setValue((prev) => prev + "!"),
      }),
    );
  };
}

function getValue(container: HTMLElement): string {
  return container.querySelector("div")!.getAttribute("data-value") ?? "";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("useLocalStorage returns defaultValue when key is absent", () => {
  const Wrapper = makeWrapper("test-absent", "default");
  const { container, unmount } = mount(React.createElement(Wrapper));
  expect(getValue(container)).toBe("default");
  unmount();
});

test("useLocalStorage reads existing value from localStorage on mount", () => {
  localStorage.setItem("test-existing", JSON.stringify("stored-value"));
  const Wrapper = makeWrapper("test-existing", "fallback");
  const { container, unmount } = mount(React.createElement(Wrapper));
  expect(getValue(container)).toBe("stored-value");
  unmount();
});

test("useLocalStorage persists new value to localStorage on set", () => {
  const Wrapper = makeWrapper("test-persist", "initial");
  const { container, unmount } = mount(React.createElement(Wrapper));

  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-hello']")!.click();
  });

  expect(getValue(container)).toBe("hello");
  expect(JSON.parse(localStorage.getItem("test-persist") ?? "null")).toBe("hello");
  unmount();
});

test("useLocalStorage updater function receives previous value", () => {
  const Wrapper = makeWrapper("test-fn", "base");
  const { container, unmount } = mount(React.createElement(Wrapper));

  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-fn']")!.click();
  });

  expect(getValue(container)).toBe("base!");
  unmount();
});

test("useLocalStorage returns defaultValue when stored JSON is malformed", () => {
  // Directly corrupt the storage
  store["test-malformed"] = "{bad json{{{";
  const Wrapper = makeWrapper("test-malformed", "fallback");
  const { container, unmount } = mount(React.createElement(Wrapper));
  expect(getValue(container)).toBe("fallback");
  unmount();
});

test("useLocalStorage syncs value from storage event (cross-tab simulation)", () => {
  const Wrapper = makeWrapper("test-cross-tab", "initial");
  const { container, unmount } = mount(React.createElement(Wrapper));
  expect(getValue(container)).toBe("initial");

  // Simulate a storage event from another tab
  act(() => {
    const event = new StorageEvent("storage", {
      key: "test-cross-tab",
      newValue: JSON.stringify("from-other-tab"),
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
  });

  expect(getValue(container)).toBe("from-other-tab");
  unmount();
});

test("useLocalStorage ignores storage events for other keys", () => {
  const Wrapper = makeWrapper("test-my-key", "mine");
  const { container, unmount } = mount(React.createElement(Wrapper));

  act(() => {
    const event = new StorageEvent("storage", {
      key: "some-other-key",
      newValue: JSON.stringify("other"),
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
  });

  expect(getValue(container)).toBe("mine");
  unmount();
});

test("useLocalStorage reverts to default when storage event removes the key", () => {
  localStorage.setItem("test-removed", JSON.stringify("was-here"));
  const Wrapper = makeWrapper("test-removed", "gone-default");
  const { container, unmount } = mount(React.createElement(Wrapper));
  expect(getValue(container)).toBe("was-here");

  // Simulate key removal in another tab (newValue = null)
  act(() => {
    const event = new StorageEvent("storage", {
      key: "test-removed",
      newValue: null,
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
  });

  expect(getValue(container)).toBe("gone-default");
  unmount();
});
