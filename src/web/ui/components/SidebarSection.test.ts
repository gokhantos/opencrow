/**
 * Unit tests for SidebarSection — the collapsible sidebar navigation section.
 *
 * Lane: unit (*.test.ts) — pure React rendering, no DB, no network.
 *
 * Key behaviors under test (per the UI fix set):
 *  - Collapsible section header is a real <button aria-expanded>
 *  - Clicking the header toggles aria-expanded and hides/shows items
 *  - Non-collapsible section renders a <div> header (no button)
 *  - hiddenTabs prop filters out specific items
 *  - Returns null when all items are hidden
 *  - Active item gets aria-current="page", inactive does not
 *  - Clicking a nav item calls onSelect with the item id
 */
import { test, expect } from "bun:test";
import React from "react";
import { renderHTML, mount, click, queryAll } from "../test-helpers";
import SidebarSection from "./SidebarSection";
import { Home, Bot } from "lucide-react";
import type { NavSection } from "../navigation";
import type { Tab } from "../navigation";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COLLAPSIBLE_SECTION: NavSection = {
  title: "Main",
  collapsible: true,
  items: [
    { id: "overview" as Tab, label: "Overview", Icon: Home },
    { id: "agents" as Tab, label: "Agents", Icon: Bot },
  ],
};

const NON_COLLAPSIBLE_SECTION: NavSection = {
  title: "Settings",
  collapsible: false,
  items: [
    { id: "overview" as Tab, label: "Overview", Icon: Home },
  ],
};

function mkEl(
  section = COLLAPSIBLE_SECTION,
  activeTab: Tab = "overview",
  onSelect: (tab: Tab) => void = () => {},
  hiddenTabs?: ReadonlySet<Tab>,
) {
  return React.createElement(SidebarSection, { section, activeTab, onSelect, hiddenTabs });
}

// ─── Collapsible header ───────────────────────────────────────────────────────

test("SidebarSection renders a <button> header when collapsible", () => {
  const html = renderHTML(mkEl());
  expect(html).toContain("<button");
  expect(html).toContain('aria-expanded="true"');
});

test("SidebarSection header button starts with aria-expanded=true (not collapsed)", () => {
  const { container, unmount } = mount(mkEl());
  const headerBtn = container.querySelector(
    'button[aria-expanded]',
  ) as HTMLButtonElement | null;
  expect(headerBtn).not.toBeNull();
  expect(headerBtn!.getAttribute("aria-expanded")).toBe("true");
  unmount();
});

test("SidebarSection collapses on header click (aria-expanded becomes false)", () => {
  const { container, unmount } = mount(mkEl());
  const headerBtn = container.querySelector(
    'button[aria-expanded]',
  ) as HTMLButtonElement;
  click(headerBtn);
  expect(headerBtn.getAttribute("aria-expanded")).toBe("false");
  unmount();
});

test("SidebarSection hides nav items when collapsed", () => {
  const { container, unmount } = mount(mkEl());
  const headerBtn = container.querySelector(
    'button[aria-expanded]',
  ) as HTMLButtonElement;
  click(headerBtn);

  // After collapse, nav item buttons with aria-current / aria-label should be gone
  const navItems = queryAll(container, "button[aria-label]");
  expect(navItems.length).toBe(0);
  unmount();
});

test("SidebarSection toggles back to expanded on second click", () => {
  const { container, unmount } = mount(mkEl());
  const headerBtn = container.querySelector(
    'button[aria-expanded]',
  ) as HTMLButtonElement;
  click(headerBtn); // collapse
  click(headerBtn); // expand again
  expect(headerBtn.getAttribute("aria-expanded")).toBe("true");
  unmount();
});

// ─── Non-collapsible header ────────────────────────────────────────────────────

test("SidebarSection renders a <div> header when NOT collapsible", () => {
  const html = renderHTML(mkEl(NON_COLLAPSIBLE_SECTION, "overview"));
  // Should NOT have aria-expanded on any element
  expect(html).not.toContain("aria-expanded");
});

// ─── hiddenTabs ───────────────────────────────────────────────────────────────

test("SidebarSection hides items listed in hiddenTabs", () => {
  const hidden = new Set<Tab>(["agents"]);
  const { container, unmount } = mount(mkEl(COLLAPSIBLE_SECTION, "overview", () => {}, hidden));
  const navItems = queryAll(container, "button[aria-label]");
  const labels = navItems.map((b) => b.getAttribute("aria-label"));
  expect(labels).toContain("Overview");
  expect(labels).not.toContain("Agents");
  unmount();
});

test("SidebarSection returns null when all items are hidden", () => {
  const hidden = new Set<Tab>(["overview", "agents"] as Tab[]);
  const html = renderHTML(mkEl(COLLAPSIBLE_SECTION, "overview", () => {}, hidden));
  expect(html).toBe("");
});

// ─── Active state ──────────────────────────────────────────────────────────────

test("SidebarSection active item has aria-current=page", () => {
  const html = renderHTML(mkEl(COLLAPSIBLE_SECTION, "overview"));
  // The active item should carry aria-current="page"
  expect(html).toContain('aria-current="page"');
});

test("SidebarSection inactive item does not have aria-current", () => {
  const { container, unmount } = mount(mkEl(COLLAPSIBLE_SECTION, "overview"));
  const navItems = queryAll(container, "button[aria-label]");
  const agentsBtn = navItems.find(
    (b) => b.getAttribute("aria-label") === "Agents",
  );
  expect(agentsBtn).toBeDefined();
  expect(agentsBtn!.getAttribute("aria-current")).toBeNull();
  unmount();
});

// ─── onSelect ─────────────────────────────────────────────────────────────────

test("SidebarSection calls onSelect with item id when nav item clicked", () => {
  let selected: Tab | null = null;
  const { container, unmount } = mount(
    mkEl(COLLAPSIBLE_SECTION, "overview", (tab) => { selected = tab; }),
  );
  const navItems = queryAll(container, "button[aria-label]");
  const agentsBtn = navItems.find(
    (b) => b.getAttribute("aria-label") === "Agents",
  ) as HTMLButtonElement | undefined;
  expect(agentsBtn).toBeDefined();
  click(agentsBtn!);
  expect(selected as Tab | null).toBe("agents");
  unmount();
});

// ─── Section title ─────────────────────────────────────────────────────────────

test("SidebarSection renders section title text", () => {
  const html = renderHTML(mkEl());
  expect(html).toContain("Main");
});
