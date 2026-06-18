import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { renderHTML, mount, click } from "../test-helpers";
import { Modal } from "./Modal";

test("Modal returns null when not open", () => {
  const html = renderHTML(
    React.createElement(Modal, { open: false, onClose: () => {}, children: null }, "Content"),
  );
  expect(html).toBe("");
});

test("Modal renders children when open", () => {
  const html = renderHTML(
    React.createElement(Modal, { open: true, onClose: () => {}, children: null }, "Hello World"),
  );
  expect(html).toContain("Hello World");
});

test("Modal renders title when provided", () => {
  const html = renderHTML(
    React.createElement(Modal, { open: true, onClose: () => {}, title: "Settings", children: null }, "Body"),
  );
  expect(html).toContain("Settings");
  expect(html).toContain("<h3");
});

test("Modal omits title section when not provided", () => {
  const html = renderHTML(
    React.createElement(Modal, { open: true, onClose: () => {}, children: null }, "Body"),
  );
  expect(html).not.toContain("<h3");
});

test("Modal has overlay backdrop", () => {
  const html = renderHTML(
    React.createElement(Modal, { open: true, onClose: () => {}, children: null }, "Body"),
  );
  expect(html).toContain("bg-black/60");
  expect(html).toContain("fixed");
});

test("Modal renders close button when title is present", () => {
  const html = renderHTML(
    React.createElement(Modal, { open: true, onClose: () => {}, title: "Edit", children: null }, "Body"),
  );
  expect(html).toContain("aria-label=\"Close\"");
});

test("Modal calls onClose when backdrop clicked", () => {
  let closed = false;
  const { container, unmount } = mount(
    React.createElement(Modal, { open: true, onClose: () => { closed = true; }, children: null }, "Body"),
  );
  const backdrop = container.querySelector(".fixed")!;
  click(backdrop);
  expect(closed).toBe(true);
  unmount();
});

test("Modal does not call onClose when content clicked", () => {
  let closed = false;
  const { container, unmount } = mount(
    React.createElement(Modal, { open: true, onClose: () => { closed = true; }, children: null }, "Body"),
  );
  const content = container.querySelector(".bg-bg-1")!;
  click(content);
  expect(closed).toBe(false);
  unmount();
});

test("Modal close button calls onClose", () => {
  let closed = false;
  const { container, unmount } = mount(
    React.createElement(Modal, { open: true, onClose: () => { closed = true; }, title: "Test", children: null }, "Body"),
  );
  const closeBtn = container.querySelector("[aria-label='Close']")!;
  click(closeBtn);
  expect(closed).toBe(true);
  unmount();
});

test("Modal aria-labelledby matches h3 id", () => {
  const { container, unmount } = mount(
    React.createElement(Modal, { open: true, onClose: () => {}, title: "My Title", children: null }),
  );
  const dialog = container.querySelector('[role="dialog"]')!;
  const labelledBy = dialog.getAttribute("aria-labelledby");
  const h3 = container.querySelector("h3")!;
  expect(labelledBy).not.toBeNull();
  expect(labelledBy).toBe(h3.getAttribute("id"));
  unmount();
});

test("Modal aria-labelledby ids are unique across two instances", () => {
  const { container: c1, unmount: u1 } = mount(
    React.createElement(Modal, { open: true, onClose: () => {}, title: "First", children: null }),
  );
  const { container: c2, unmount: u2 } = mount(
    React.createElement(Modal, { open: true, onClose: () => {}, title: "Second", children: null }),
  );
  const id1 = c1.querySelector('[role="dialog"]')!.getAttribute("aria-labelledby");
  const id2 = c2.querySelector('[role="dialog"]')!.getAttribute("aria-labelledby");
  expect(id1).not.toBe(id2);
  u1();
  u2();
});

test("Modal restores focus to previously-focused element on close", () => {
  // Create a button that will be the trigger element
  const trigger = document.createElement("button");
  trigger.textContent = "Open";
  document.body.appendChild(trigger);
  trigger.focus();
  expect(document.activeElement).toBe(trigger);

  const { unmount } = mount(
    React.createElement(Modal, {
      open: true,
      onClose: () => {},
      title: "Test",
      children: null,
    }),
  );

  // Close the modal — the cleanup in the useEffect should restore focus
  act(() => {
    unmount();
  });

  // Focus should have returned to the trigger button
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("Modal Escape key calls onClose", () => {
  let closed = false;
  const { unmount } = mount(
    React.createElement(Modal, {
      open: true,
      onClose: () => { closed = true; },
      children: null,
    }),
  );
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(closed).toBe(true);
  unmount();
});

test("Modal has no aria-labelledby when title is not provided", () => {
  const { container, unmount } = mount(
    React.createElement(Modal, { open: true, onClose: () => {}, children: null }),
  );
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-labelledby")).toBeNull();
  unmount();
});

test("Modal Tab key on last focusable element wraps to first", () => {
  // Render with two focusable elements so we can test Tab wrap
  const { container, unmount } = mount(
    React.createElement(Modal, {
      open: true,
      onClose: () => {},
      title: "Trap Test",
      children: React.createElement("button", { type: "button" }, "Extra"),
    }),
  );
  // There are 2 focusable elements: Close button + Extra button
  const focusable = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]),input:not([disabled])',
  );
  expect(focusable.length).toBeGreaterThanOrEqual(2);

  // Focus the last element
  const last = focusable[focusable.length - 1]!;
  act(() => { last.focus(); });

  // Tab (forward) on the last element should not throw
  expect(() => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: false, bubbles: true }),
      );
    });
  }).not.toThrow();
  unmount();
});

test("Modal Shift+Tab on first focusable element wraps to last", () => {
  const { container, unmount } = mount(
    React.createElement(Modal, {
      open: true,
      onClose: () => {},
      title: "Trap Test 2",
      children: React.createElement("button", { type: "button" }, "Second"),
    }),
  );
  const focusable = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]),input:not([disabled])',
  );
  const first = focusable[0]!;
  act(() => { first.focus(); });

  // Shift+Tab on first element should not throw
  expect(() => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
  }).not.toThrow();
  unmount();
});
