/**
 * Isolated tests for useSystemEvents hook.
 *
 * Lane: isolated (*.isolated.test.ts) — uses mock.module to replace the
 * WebSocket and getToken, which would otherwise try to reach the network.
 * mock.module leaks across files in a shared process.
 *
 * Key behaviors under test:
 *  - mountedRef guard: no reconnect or state update after unmount
 *  - setConnected(true) on ws.onopen
 *  - setConnected(false) on ws.onclose and schedules reconnect
 *  - onEvent callback is called with parsed message data
 *  - cleanup nullifies handlers and closes the socket
 */
import { test, expect, mock, jest, afterEach } from "bun:test";
import React from "react";
import { act } from "react";
import { mount } from "../test-helpers";

afterEach(() => {
  jest.useRealTimers();
});

// ─── WebSocket mock factory ───────────────────────────────────────────────────

type WsHandler = ((e: { data: string }) => void) | null;

interface MockWs {
  onopen: (() => void) | null;
  onmessage: WsHandler;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof mock>;
  // Test helpers to trigger handlers
  triggerOpen: () => void;
  triggerMessage: (data: unknown) => void;
  triggerClose: () => void;
  triggerError: () => void;
}

let lastWs: MockWs | null = null;

await mock.module("../api", () => ({
  getToken: mock(() => null),
}));

// Intercept WebSocket constructor
(globalThis as any).WebSocket = class {
  onopen: (() => void) | null = null;
  onmessage: WsHandler = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    // Capture last instance for tests
    lastWs = this as unknown as MockWs;
    (lastWs as any).close = mock(() => {});
    (lastWs as any).triggerOpen = () => this.onopen?.();
    (lastWs as any).triggerMessage = (data: unknown) => this.onmessage?.({ data: JSON.stringify(data) });
    (lastWs as any).triggerClose = () => this.onclose?.();
    (lastWs as any).triggerError = () => this.onerror?.();
  }

  close() {
    (this as any).close?.();
  }
};

import { useSystemEvents } from "./useSystemEvents";

// ─── Wrapper component ────────────────────────────────────────────────────────

function makeWrapper(onEvent?: (e: unknown) => void) {
  return function Wrapper() {
    const { connected } = useSystemEvents(onEvent as any);
    return React.createElement("div", { "data-connected": String(connected) });
  };
}

function isConnected(container: HTMLElement): boolean {
  return container.querySelector("div")!.getAttribute("data-connected") === "true";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("useSystemEvents starts disconnected", () => {
  const { container, unmount } = mount(React.createElement(makeWrapper()));
  expect(isConnected(container)).toBe(false);
  act(() => { (lastWs as any)?.triggerClose?.(); }); // prevent reconnect timer leak
  unmount();
});

test("useSystemEvents sets connected=true on ws.onopen", () => {
  const { container, unmount } = mount(React.createElement(makeWrapper()));
  act(() => { (lastWs as any)!.triggerOpen(); });
  expect(isConnected(container)).toBe(true);
  unmount();
});

test("useSystemEvents sets connected=false on ws.onclose", () => {
  jest.useFakeTimers();
  const { container, unmount } = mount(React.createElement(makeWrapper()));
  act(() => { (lastWs as any)!.triggerOpen(); });
  expect(isConnected(container)).toBe(true);
  act(() => { (lastWs as any)!.triggerClose(); });
  expect(isConnected(container)).toBe(false);
  unmount();
});

test("useSystemEvents calls onEvent with parsed message", () => {
  const received: unknown[] = [];
  const { unmount } = mount(
    React.createElement(makeWrapper((e) => received.push(e))),
  );
  act(() => { (lastWs as any)!.triggerOpen(); });
  act(() => {
    (lastWs as any)!.triggerMessage({ type: "status", data: { foo: "bar" }, ts: 123 });
  });
  expect(received.length).toBe(1);
  expect((received[0] as any).type).toBe("status");
  unmount();
});

test("useSystemEvents ignores malformed message JSON", () => {
  // Should not throw
  const { unmount } = mount(React.createElement(makeWrapper()));
  act(() => { (lastWs as any)!.triggerOpen(); });
  expect(() => {
    act(() => {
      (lastWs as any)!.onmessage?.({ data: "not-valid-json{{" });
    });
  }).not.toThrow();
  unmount();
});

test("useSystemEvents does not reconnect after unmount (mountedRef guard)", () => {
  jest.useFakeTimers();
  const { unmount } = mount(React.createElement(makeWrapper()));
  act(() => { (lastWs as any)!.triggerOpen(); });

  // Unmount — mountedRef.current is set to false, handlers nulled
  act(() => { unmount(); });

  // Now trigger onclose on the old ws (race condition scenario).
  // Because mountedRef is false, this should be a no-op.
  // We capture lastWs again; if a new WebSocket was created, lastWs changed.
  const wsBefore = lastWs;
  // The onclose handler was nulled in cleanup, so this is safe
  // (in real scenario the handler can fire after close() returns)
  act(() => {
    jest.advanceTimersByTime(30_000);
  });

  // lastWs should not have changed (no new WebSocket was created post-unmount)
  expect(lastWs).toBe(wsBefore);
});

test("useSystemEvents nullifies handlers on unmount (no stale-closure leak)", () => {
  const { unmount } = mount(React.createElement(makeWrapper()));
  const ws = lastWs as any;
  act(() => { unmount(); });
  // After unmount, all handlers should be null
  expect(ws.onopen).toBeNull();
  expect(ws.onmessage).toBeNull();
  expect(ws.onclose).toBeNull();
  expect(ws.onerror).toBeNull();
});
