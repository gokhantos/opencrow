import { test, expect } from "bun:test";
import React from "react";
import { renderHTML, mount, click } from "../test-helpers";
import { Toggle } from "./Toggle";

test("Toggle renders as button", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {} }));
  expect(html).toMatch(/^<button/);
});

test("Toggle shows accent background when checked", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: true, onChange: () => {} }));
  expect(html).toContain("bg-accent");
});

test("Toggle shows bg-3 background when unchecked", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {} }));
  expect(html).toContain("bg-bg-3");
});

test("Toggle has translate-x-4 when checked (knob moved)", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: true, onChange: () => {} }));
  expect(html).toContain("translate-x-4");
});

test("Toggle has translate-x-0 when unchecked", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {} }));
  expect(html).toContain("translate-x-0");
});

test("Toggle renders label when provided", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {}, label: "Enable" }));
  expect(html).toContain("Enable");
  expect(html).toContain("<span");
});

test("Toggle wraps in div with label", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {}, label: "Test" }));
  expect(html).toMatch(/^<div/);
});

test("Toggle is just a button without label", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {} }));
  expect(html).toMatch(/^<button/);
});

test("Toggle shows opacity-50 when disabled", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {}, disabled: true }));
  expect(html).toContain("opacity-50");
});

test("Toggle calls onChange with negated value on click", () => {
  let result: boolean | null = null;
  const { container, unmount } = mount(
    React.createElement(Toggle, { checked: false, onChange: (v: boolean) => { result = v; } }),
  );
  const btn = container.querySelector("button")!;
  click(btn);
  expect(result as unknown).toBe(true);
  unmount();
});

test("Toggle calls onChange with false when currently checked", () => {
  let result: boolean | null = null;
  const { container, unmount } = mount(
    React.createElement(Toggle, { checked: true, onChange: (v: boolean) => { result = v; } }),
  );
  const btn = container.querySelector("button")!;
  click(btn);
  expect(result as unknown).toBe(false);
  unmount();
});

test("Toggle text content shows On when checked", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: true, onChange: () => {} }));
  expect(html).toContain("On");
});

test("Toggle text content shows Off when unchecked", () => {
  const html = renderHTML(React.createElement(Toggle, { checked: false, onChange: () => {} }));
  expect(html).toContain("Off");
});
