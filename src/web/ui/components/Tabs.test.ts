import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { renderHTML, mount, click, queryAll } from "../test-helpers";
import { Tabs } from "./Tabs";

const ITEMS = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
  { key: "c", label: "Gamma" },
] as const;

test("Tabs renders a tablist with aria-label", () => {
  const html = renderHTML(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: () => {},
      ariaLabel: "Test tabs",
    }),
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-label="Test tabs"');
});

test("Tabs renders one role=tab per item", () => {
  const html = renderHTML(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: () => {},
      ariaLabel: "Test",
    }),
  );
  const matches = html.match(/role="tab"/g) ?? [];
  expect(matches.length).toBe(3);
});

test("Tabs marks active item with aria-selected=true", () => {
  const html = renderHTML(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "b",
      onSelect: () => {},
      ariaLabel: "Test",
    }),
  );
  // Should contain exactly one aria-selected="true"
  const trueMatches = html.match(/aria-selected="true"/g) ?? [];
  expect(trueMatches.length).toBe(1);
  // Beta label should be nearby
  expect(html).toContain("Beta");
});

test("Tabs marks inactive items with aria-selected=false", () => {
  const html = renderHTML(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: () => {},
      ariaLabel: "Test",
    }),
  );
  const falseMatches = html.match(/aria-selected="false"/g) ?? [];
  expect(falseMatches.length).toBe(2);
});

test("Tabs active tab has tabIndex=0, others -1", () => {
  const html = renderHTML(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: () => {},
      ariaLabel: "Test",
    }),
  );
  expect(html).toContain('tabindex="0"');
  const negOne = html.match(/tabindex="-1"/g) ?? [];
  expect(negOne.length).toBe(2);
});

test("Tabs calls onSelect with item key when clicked", () => {
  let selected = "";
  const { container, unmount } = mount(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: (key) => { selected = key; },
      ariaLabel: "Test",
    }),
  );
  const tabs = queryAll(container, '[role="tab"]');
  click(tabs[1]!);
  expect(selected).toBe("b");
  unmount();
});

test("Tabs applies className to the tablist container", () => {
  const html = renderHTML(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: () => {},
      ariaLabel: "Test",
      className: "my-tabs",
    }),
  );
  expect(html).toContain("my-tabs");
});

test("Tabs ArrowRight key moves selection to next tab", () => {
  let selected = "a";
  const { container, unmount } = mount(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: (key) => { selected = key; },
      ariaLabel: "Test",
    }),
  );
  const tabs = queryAll(container, '[role="tab"]') as HTMLButtonElement[];
  // Fire ArrowRight on the first tab
  act(() => {
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(selected).toBe("b");
  unmount();
});

test("Tabs ArrowLeft key moves selection to previous tab (wraps)", () => {
  let selected = "a";
  const { container, unmount } = mount(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "a",
      onSelect: (key) => { selected = key; },
      ariaLabel: "Test",
    }),
  );
  const tabs = queryAll(container, '[role="tab"]') as HTMLButtonElement[];
  // Fire ArrowLeft on the first tab — should wrap to the last ("c")
  act(() => {
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
  expect(selected).toBe("c");
  unmount();
});

test("Tabs ArrowRight wraps from last tab to first", () => {
  let selected = "c";
  const { container, unmount } = mount(
    React.createElement(Tabs, {
      items: ITEMS,
      active: "c",
      onSelect: (key) => { selected = key; },
      ariaLabel: "Test",
    }),
  );
  const tabs = queryAll(container, '[role="tab"]') as HTMLButtonElement[];
  // Fire ArrowRight on the third (last) tab — should wrap to first ("a")
  act(() => {
    tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(selected).toBe("a");
  unmount();
});
