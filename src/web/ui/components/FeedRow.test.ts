import { test, expect } from "bun:test";
import React from "react";
import { renderHTML } from "../test-helpers";
import { FeedRow } from "./FeedRow";

test("FeedRow renders title as text when no url", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "My Post" }));
  expect(html).toContain("My Post");
  expect(html).not.toContain("<a");
});

test("FeedRow renders title as link when url provided", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "My Post", url: "https://example.com" }));
  expect(html).toContain("<a");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain("My Post");
});

test("FeedRow link opens in new tab", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T", url: "https://example.com" }));
  expect(html).toContain('target="_blank"');
  expect(html).toContain("noopener");
});

test("FeedRow renders rank when provided", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T", rank: 5 }));
  expect(html).toContain(">5<");
});

test("FeedRow omits rank when not provided", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T" }));
  expect(html).not.toContain("font-mono text-sm font-medium text-faint text-right");
});

test("FeedRow renders domain in parentheses", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T", domain: "example.com" }));
  expect(html).toContain("(example.com)");
});

test("FeedRow renders meta slot", () => {
  const meta = React.createElement("span", null, "2 hours ago");
  const html = renderHTML(React.createElement(FeedRow, { title: "T", meta }));
  expect(html).toContain("2 hours ago");
});

test("FeedRow renders stats slot", () => {
  const stats = React.createElement("span", null, "42 points");
  const html = renderHTML(React.createElement(FeedRow, { title: "T", stats }));
  expect(html).toContain("42 points");
});

test("FeedRow omits meta container when not provided", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T" }));
  expect(html).not.toContain("mt-1.5");
});

test("FeedRow uses 3-column grid when rank is provided", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T", rank: 1 }));
  expect(html).toContain("grid-cols-[3rem_1fr_auto]");
});

test("FeedRow uses 2-column grid when rank is absent", () => {
  const html = renderHTML(React.createElement(FeedRow, { title: "T" }));
  expect(html).toContain("grid-cols-[1fr_auto]");
  expect(html).not.toContain("grid-cols-[3rem_1fr_auto]");
});
