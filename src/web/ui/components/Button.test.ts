import { test, expect } from "bun:test";
import React from "react";
import { renderHTML, mount, click } from "../test-helpers";
import { Button } from "./Button";

/* ---------- static rendering ---------- */

test("Button renders children text", () => {
  const html = renderHTML(React.createElement(Button, null, "Save"));
  expect(html).toContain("Save");
});

test("Button renders as <button> element", () => {
  const html = renderHTML(React.createElement(Button, null, "Go"));
  expect(html).toMatch(/^<button/);
});

test("Button applies primary variant styles by default", () => {
  const html = renderHTML(React.createElement(Button, null, "Go"));
  expect(html).toContain("bg-accent");
});

test("Button applies secondary variant styles", () => {
  const html = renderHTML(React.createElement(Button, { variant: "secondary" }, "Go"));
  expect(html).toContain("bg-bg-2");
});

test("Button applies ghost variant styles", () => {
  const html = renderHTML(React.createElement(Button, { variant: "ghost" }, "Go"));
  expect(html).toContain("bg-transparent");
});

test("Button applies danger variant styles", () => {
  const html = renderHTML(React.createElement(Button, { variant: "danger" }, "Go"));
  expect(html).toContain("bg-danger-subtle");
});

test("Button applies sm size styles", () => {
  const html = renderHTML(React.createElement(Button, { size: "sm" }, "Go"));
  expect(html).toContain("px-3");
  expect(html).toContain("py-1.5");
});

test("Button applies md size styles by default", () => {
  const html = renderHTML(React.createElement(Button, null, "Go"));
  expect(html).toContain("px-4");
  expect(html).toContain("py-2.5");
});

test("Button sets disabled attribute when disabled", () => {
  const html = renderHTML(React.createElement(Button, { disabled: true }, "Go"));
  expect(html).toContain("disabled");
  expect(html).toContain("opacity-50");
});

test("Button sets disabled attribute when loading", () => {
  const html = renderHTML(React.createElement(Button, { loading: true }, "Go"));
  expect(html).toContain("disabled");
  expect(html).toContain("opacity-50");
});

test("Button shows spinner when loading instead of children", () => {
  const html = renderHTML(React.createElement(Button, { loading: true }, "Go"));
  expect(html).toContain("animate-spin");
  expect(html).not.toContain("Go");
});

test("Button merges custom className", () => {
  const html = renderHTML(React.createElement(Button, { className: "my-custom" }, "Go"));
  expect(html).toContain("my-custom");
});

/* ---------- interactive tests ---------- */

test("Button calls onClick when clicked", () => {
  let clicked = false;
  const { container, unmount } = mount(
    React.createElement(Button, { onClick: () => { clicked = true; } }, "Go"),
  );
  const btn = container.querySelector("button")!;
  click(btn);
  expect(clicked).toBe(true);
  unmount();
});

test("Button does not call onClick when disabled", () => {
  let clicked = false;
  const { container, unmount } = mount(
    React.createElement(Button, { disabled: true, onClick: () => { clicked = true; } }, "Go"),
  );
  const btn = container.querySelector("button")!;
  click(btn);
  expect(clicked).toBe(false);
  unmount();
});
