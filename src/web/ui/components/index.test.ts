import { test, expect } from "bun:test";
import * as components from "./index";

const EXPECTED_EXPORTS = [
  "PageHeader",
  "EmptyState",
  "LoadingState",
  "StatusBadge",
  "CardGrid",
  "Modal",
  "Toggle",
  "ConfirmDelete",
  "SearchBar",
  "FilterTabs",
  "FeedRow",
  "Button",
  "Input",
  "FormField",
  "IconButton",
  "Tabs",
  "IntervalConfigPanel",
];

test("barrel export has all expected components", () => {
  for (const name of EXPECTED_EXPORTS) {
    expect((components as Record<string, unknown>)[name]).toBeDefined();
  }
});

test("barrel export count matches expected", () => {
  expect(Object.keys(components).length).toBe(EXPECTED_EXPORTS.length);
});

test("all exports are functions or forwardRef components", () => {
  for (const name of EXPECTED_EXPORTS) {
    const exp = (components as Record<string, unknown>)[name];
    const valid = typeof exp === "function" || (typeof exp === "object" && exp !== null);
    expect(valid).toBe(true);
  }
});
