import { test, expect } from "bun:test";
import React from "react";
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
