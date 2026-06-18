import { test, expect } from "bun:test";
import React from "react";
import { renderHTML, mount, click } from "../test-helpers";
import { IconButton } from "./IconButton";

test("IconButton renders a <button type='button'>", () => {
  const html = renderHTML(
    React.createElement(IconButton, { "aria-label": "Close" }, null),
  );
  expect(html).toContain('<button type="button"');
});

test("IconButton carries the provided aria-label", () => {
  const html = renderHTML(
    React.createElement(IconButton, { "aria-label": "Delete item" }, null),
  );
  expect(html).toContain('aria-label="Delete item"');
});

test("IconButton renders children", () => {
  const html = renderHTML(
    React.createElement(
      IconButton,
      { "aria-label": "Toggle" },
      React.createElement("span", null, "X"),
    ),
  );
  expect(html).toContain("X");
});

test("IconButton applies className", () => {
  const html = renderHTML(
    React.createElement(IconButton, { "aria-label": "Add", className: "my-class" }, null),
  );
  expect(html).toContain("my-class");
});

test("IconButton applies disabled attribute", () => {
  const html = renderHTML(
    React.createElement(IconButton, { "aria-label": "Save", disabled: true }, null),
  );
  expect(html).toContain("disabled");
});

test("IconButton calls onClick when clicked", () => {
  let clicked = false;
  const { container, unmount } = mount(
    React.createElement(
      IconButton,
      { "aria-label": "Open", onClick: () => { clicked = true; } },
      null,
    ),
  );
  click(container.querySelector("button")!);
  expect(clicked).toBe(true);
  unmount();
});
