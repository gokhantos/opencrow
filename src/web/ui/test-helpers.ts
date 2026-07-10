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

/**
 * Types into a controlled `<input>`/`<textarea>` and fires its React
 * `onChange`.
 *
 * Why not just `el.value = x; el.dispatchEvent(new Event("input"))`? That's
 * the standard jsdom trick, but it doesn't work in this project's happy-dom
 * setup: react-dom's `isInputEventSupported` feature detection (which native
 * event types react-dom treats as "value changed" signals) runs at
 * `react-dom/client` **module-import time** — before this file's own
 * happy-dom `window`/`document` globals exist, since those static imports
 * execute before this module's body runs. It gets permanently cached as
 * `false` for the process, so react-dom falls back to a legacy IE-era
 * polyfill path (focus/keyup + `attachEvent`) that never fires in a modern
 * DOM. Reordering imports doesn't help — every module here that needs
 * happy-dom's globals set up first would have to become an async dynamic
 * `import()`, which would ripple out to every call site of `mount`.
 *
 * Instead, this reads React's internal `__reactProps$*` key that React
 * stores directly on the DOM node (the same object `mount`'s rendered tree
 * wires up as the node's current props) and calls `onChange` with a minimal
 * event-shaped object, bypassing the native event pipeline entirely.
 */
export function typeIntoInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!propsKey) {
    throw new Error("typeIntoInput: no React props found on element (is it mounted?)");
  }
  const onChange = (el as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propsKey]
    ?.onChange;
  if (!onChange) {
    throw new Error("typeIntoInput: element has no onChange handler — is it a controlled input?");
  }
  act(() => {
    onChange({ target: { value } });
  });
}
