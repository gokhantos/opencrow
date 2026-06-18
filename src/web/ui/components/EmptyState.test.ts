import { test, expect } from "bun:test";
import React from "react";
import { renderHTML } from "../test-helpers";
import { EmptyState } from "./EmptyState";

test("EmptyState renders with no props", () => {
  const html = renderHTML(React.createElement(EmptyState));
  expect(html).toContain("div");
});

test("EmptyState renders icon when provided", () => {
  const html = renderHTML(React.createElement(EmptyState, { icon: "🔍" }));
  expect(html).toContain("🔍");
});

test("EmptyState omits icon container when not provided", () => {
  const html = renderHTML(React.createElement(EmptyState, { title: "Nothing" }));
  expect(html).not.toContain("text-2xl");
});

test("EmptyState renders title", () => {
  const html = renderHTML(React.createElement(EmptyState, { title: "No results" }));
  expect(html).toContain("No results");
  expect(html).toContain("font-semibold");
});

test("EmptyState omits title element when not provided", () => {
  const html = renderHTML(React.createElement(EmptyState, { description: "Try again" }));
  expect(html).not.toContain("font-semibold");
});

test("EmptyState renders description", () => {
  const html = renderHTML(React.createElement(EmptyState, { description: "Try a different query" }));
  expect(html).toContain("Try a different query");
});

test("EmptyState renders children", () => {
  const html = renderHTML(
    React.createElement(EmptyState, null, React.createElement("button", null, "Retry")),
  );
  expect(html).toContain("Retry");
  expect(html).toContain("<button");
});

test("EmptyState renders all props together", () => {
  const html = renderHTML(
    React.createElement(EmptyState, { icon: "📭", title: "Empty", description: "Nothing here" }),
  );
  expect(html).toContain("📭");
  expect(html).toContain("Empty");
  expect(html).toContain("Nothing here");
});

test("EmptyState icon container is aria-hidden", () => {
  const html = renderHTML(React.createElement(EmptyState, { icon: "🔍" }));
  expect(html).toContain('aria-hidden="true"');
});
