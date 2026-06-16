import { test, expect } from "bun:test";
import { NAV_SECTIONS, type Tab } from "./navigation";

// Derive tabs from the single source of truth (navigation.ts)
const NAV_IDS = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id));

test("navigation has no duplicate tab IDs", () => {
  expect(new Set(NAV_IDS).size).toBe(NAV_IDS.length);
});

test("navigation has a reasonable number of tabs", () => {
  expect(NAV_IDS.length).toBeGreaterThanOrEqual(15);
  expect(NAV_IDS.length).toBeLessThanOrEqual(40);
});

test("navigation includes core tabs", () => {
  const core: Tab[] = ["overview", "agents", "cron", "logs", "system"];
  for (const tab of core) {
    expect(NAV_IDS).toContain(tab);
  }
});

test("every section has a title and at least one item", () => {
  for (const section of NAV_SECTIONS) {
    expect(section.title.length).toBeGreaterThan(0);
    expect(section.items.length).toBeGreaterThan(0);
  }
});

test("every nav item has id, label, and Icon", () => {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.Icon).toBeDefined();
    }
  }
});
