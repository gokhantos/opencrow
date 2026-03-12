import { test, expect } from "bun:test";
import { NAV_SECTIONS } from "./navigation";

test("NAV_SECTIONS has expected section titles", () => {
  const titles = NAV_SECTIONS.map((s) => s.title);
  expect(titles).toEqual([
    "Dashboard",
    "Agents",
    "Sources",
    "Intelligence",
    "System",
  ]);
});

test("Dashboard section is not collapsible", () => {
  const dashboard = NAV_SECTIONS.find((s) => s.title === "Dashboard")!;
  expect(dashboard.collapsible).toBe(false);
});

test("Sources section is collapsible", () => {
  const sources = NAV_SECTIONS.find((s) => s.title === "Sources")!;
  expect(sources.collapsible).toBe(true);
});

test("all nav items have unique ids", () => {
  const ids = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(ids.length);
});

test("all nav items have non-empty labels", () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);
  for (const item of items) {
    expect(item.label.length).toBeGreaterThan(0);
  }
});

test("all nav items have Icon component", () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);
  for (const item of items) {
    expect(item.Icon).toBeDefined();
  }
});

test("overview is in Dashboard section", () => {
  const dashboard = NAV_SECTIONS.find((s) => s.title === "Dashboard")!;
  const ids = dashboard.items.map((i) => i.id);
  expect(ids).toContain("overview");
});

test("agents section contains expected items", () => {
  const agents = NAV_SECTIONS.find((s) => s.title === "Agents")!;
  const ids = agents.items.map((i) => i.id);
  expect(ids).toContain("agents");
  expect(ids).toContain("sessions");
  expect(ids).toContain("channels");
  expect(ids).toContain("tools");
});

test("total nav items count is at least 20", () => {
  const total = NAV_SECTIONS.reduce((sum, s) => sum + s.items.length, 0);
  expect(total).toBeGreaterThanOrEqual(20);
});
