import { GlobalWindow } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Register DOM globals once
if (typeof globalThis.document === "undefined") {
  const win = new GlobalWindow();
  for (const key of [
    "document",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "StorageEvent",
    "CustomEvent",
    "MutationObserver",
    "navigator",
  ] as const) {
    (globalThis as any)[key] = (win as any)[key];
  }
  (globalThis as any).window = win;
}

/** Render a component to static HTML string (no interactivity needed) */
export function renderHTML(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Mount a component into a real DOM container for interaction testing */
export function mount(element: React.ReactElement): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Query helpers */
export function queryAll(container: HTMLElement, selector: string): Element[] {
  return Array.from(container.querySelectorAll(selector));
}

export function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}
