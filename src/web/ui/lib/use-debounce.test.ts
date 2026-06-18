import { test, expect, jest, afterEach } from "bun:test";
import React, { useState } from "react";
import { act } from "react";
import { mount } from "../test-helpers";
import { useDebounce } from "./use-debounce";

afterEach(() => {
  jest.useRealTimers();
});

// Minimal wrapper component that exposes the debounced value via a data attribute
// so the test can read it from the DOM without reaching into React internals.
function Wrapper({ initialValue, delay }: { readonly initialValue: string; readonly delay: number }) {
  const [value, setValue] = useState(initialValue);
  const debounced = useDebounce(value, delay);

  return React.createElement(
    "div",
    { "data-debounced": debounced },
    React.createElement("button", {
      "data-testid": "setter",
      onClick: () => setValue((v) => v + "x"),
    }),
    React.createElement("button", {
      "data-testid": "set-foo",
      onClick: () => setValue("foo"),
    }),
    React.createElement("button", {
      "data-testid": "set-bar",
      onClick: () => setValue("bar"),
    }),
  );
}

function getDebounced(container: HTMLElement): string {
  return container.querySelector("div")!.getAttribute("data-debounced") ?? "";
}

// ─── 1. Initial value propagates immediately ─────────────────────────────────

test("useDebounce returns initial value without delay", () => {
  jest.useFakeTimers();
  const { container, unmount } = mount(
    React.createElement(Wrapper, { initialValue: "hello", delay: 300 }),
  );
  expect(getDebounced(container)).toBe("hello");
  unmount();
});

// ─── 2. Value does NOT update until delay elapses ────────────────────────────

test("useDebounce does not update before delay elapses", () => {
  jest.useFakeTimers();
  const { container, unmount } = mount(
    React.createElement(Wrapper, { initialValue: "a", delay: 500 }),
  );

  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-foo']")!.click();
  });

  // Advance only part of the delay — value should still be "a"
  act(() => {
    jest.advanceTimersByTime(499);
  });
  expect(getDebounced(container)).toBe("a");

  unmount();
});

// ─── 3. Value updates exactly once after the full delay ───────────────────────

test("useDebounce updates value after delay elapses", () => {
  jest.useFakeTimers();
  const { container, unmount } = mount(
    React.createElement(Wrapper, { initialValue: "a", delay: 300 }),
  );

  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-foo']")!.click();
  });

  act(() => {
    jest.advanceTimersByTime(300);
  });
  expect(getDebounced(container)).toBe("foo");

  unmount();
});

// ─── 4. Rapid changes reset the timer; only last value survives ──────────────

test("useDebounce resets the timer on rapid value changes", () => {
  jest.useFakeTimers();
  const { container, unmount } = mount(
    React.createElement(Wrapper, { initialValue: "a", delay: 300 }),
  );

  // First change to "foo"
  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-foo']")!.click();
  });

  // Advance 200 ms — timer has NOT fired yet
  act(() => {
    jest.advanceTimersByTime(200);
  });
  expect(getDebounced(container)).toBe("a"); // still old value

  // Second change to "bar" resets the 300 ms timer
  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-bar']")!.click();
  });

  // Advance another 200 ms (total 400 ms from first change, 200 from second)
  act(() => {
    jest.advanceTimersByTime(200);
  });
  expect(getDebounced(container)).toBe("a"); // still old value — "bar"'s timer not done

  // Advance the remaining 100 ms to complete the 300 ms from the last change
  act(() => {
    jest.advanceTimersByTime(100);
  });
  expect(getDebounced(container)).toBe("bar"); // only the last change wins

  unmount();
});

// ─── 5. Unmount cancels the pending timer (no late update / warning) ──────────

test("useDebounce cancels pending timer on unmount", () => {
  jest.useFakeTimers();
  const { container, unmount } = mount(
    React.createElement(Wrapper, { initialValue: "a", delay: 300 }),
  );

  act(() => {
    container.querySelector<HTMLButtonElement>("[data-testid='set-foo']")!.click();
  });

  // Unmount before the delay fires — should not throw or warn
  unmount();

  // Advancing timers past the delay after unmount must not cause state-update errors.
  expect(() => {
    act(() => {
      jest.advanceTimersByTime(500);
    });
  }).not.toThrow();
});
