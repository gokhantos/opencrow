import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { mount, click, queryAll } from "../test-helpers";
import { ConfirmDelete } from "./ConfirmDelete";

test("ConfirmDelete shows initial delete button", () => {
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => {} }),
  );
  const btn = container.querySelector("button")!;
  expect(btn.textContent).toContain("Delete");
  unmount();
});

test("ConfirmDelete uses custom buttonLabel", () => {
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => {}, buttonLabel: "Remove" }),
  );
  const btn = container.querySelector("button")!;
  expect(btn.textContent).toContain("Remove");
  unmount();
});

test("ConfirmDelete shows confirmation after first click", () => {
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => {} }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");
  expect(buttons.length).toBe(2);
  expect(buttons[0]!.textContent).toContain("Confirm");
  expect(buttons[1]!.textContent).toContain("Cancel");
  unmount();
});

test("ConfirmDelete shows custom confirmLabel", () => {
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => {}, confirmLabel: "Really?" }),
  );
  click(container.querySelector("button")!);
  expect(container.textContent).toContain("Really?");
  unmount();
});

test("ConfirmDelete calls onConfirm when Confirm clicked", async () => {
  let confirmed = false;
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => { confirmed = true; } }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");
  await act(async () => {
    (buttons[0] as HTMLElement).click();
  });
  expect(confirmed).toBe(true);
  unmount();
});

test("ConfirmDelete returns to initial state after Cancel", () => {
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => {} }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");
  click(buttons[1]!); // Cancel
  const btns = queryAll(container, "button");
  expect(btns.length).toBe(1);
  expect(btns[0]!.textContent).toContain("Delete");
  unmount();
});

test("ConfirmDelete does not call onConfirm on Cancel", () => {
  let confirmed = false;
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => { confirmed = true; } }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");
  click(buttons[1]!); // Cancel
  expect(confirmed).toBe(false);
  unmount();
});

test("ConfirmDelete returns to initial state after Confirm", async () => {
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => {} }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");
  await act(async () => {
    (buttons[0] as HTMLElement).click(); // Confirm
  });
  const btns = queryAll(container, "button");
  expect(btns.length).toBe(1);
  expect(btns[0]!.textContent).toContain("Delete");
  unmount();
});

test("ConfirmDelete disables Confirm button while onConfirm is pending", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((res) => { resolve = res; });
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => pending }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");

  // Start the async confirm
  act(() => { (buttons[0] as HTMLElement).click(); });

  // While pending, the Confirm button should be disabled
  const confirmBtn = container.querySelector('[aria-busy="true"], button[disabled]') as HTMLButtonElement | null;
  expect(confirmBtn).not.toBeNull();

  // Resolve the promise and clean up
  await act(async () => { resolve(); await pending; });
  unmount();
});

test("ConfirmDelete re-enables Confirm button when onConfirm throws", async () => {
  let rejectFn!: (err: Error) => void;
  const failing = new Promise<void>((_, rej) => { rejectFn = rej; });
  const { container, unmount } = mount(
    React.createElement(ConfirmDelete, { onConfirm: () => failing }),
  );
  click(container.querySelector("button")!);
  const buttons = queryAll(container, "button");

  // Start the async confirm
  act(() => { (buttons[0] as HTMLElement).click(); });

  // Reject the promise (simulating onConfirm failure)
  await act(async () => {
    rejectFn(new Error("Network error"));
    await failing.catch(() => {});
  });

  // After error, the Confirm + Cancel buttons should still be visible (not reset to Delete)
  const btnsAfterError = queryAll(container, "button");
  expect(btnsAfterError.length).toBe(2);

  // And the Confirm button should no longer be disabled (loading = false)
  const confirmBtn = btnsAfterError[0] as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(false);

  unmount();
});
