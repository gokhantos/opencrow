/**
 * Isolated security-branch tests for the process_manage tool
 * (src/tools/self-restart.ts).
 *
 * These cover the security guards added in PR-3 that the unit-lane test does not
 * fully exercise:
 *   (a) non-self target → permission denied, with NO control-plane call sent.
 *   (b) process-list lookup failure → fail closed (refuses, does NOT mutate).
 *   (c) > GLOBAL_ACTION_MAX (3) mutating actions within the window → rate limited.
 *
 * We mock.module the store/db (so the SDK-session cleanup never touches a real
 * DB) and intercept the control-plane HTTP boundary via globalThis.fetch so we
 * can assert exactly which calls are sent.
 *
 * Lane: isolated (*.isolated.test.ts) — `mock.module` requires this suffix.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// ────────────────────────────────────────────────────────────────────────────
// Module mocks (must precede the import of the module under test)
// ────────────────────────────────────────────────────────────────────────────

// The self-restart path may DELETE sdk_sessions before an agent self-restart.
// Mock getDb so that never hits a real database.
const dbCalls: string[] = [];
mock.module("../store/db", () => ({
  getDb: () => {
    const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      dbCalls.push(strings.join("?"));
      return Promise.resolve([]);
    };
    return tag;
  },
}));

mock.module("../logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { createSelfRestartTool } from "./self-restart";

// ────────────────────────────────────────────────────────────────────────────
// Fetch interception helper — records every control-plane call and returns a
// scriptable response so we can model list-lookups and mutating actions.
// ────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly callerHeader: string | undefined;
}

const originalFetch = globalThis.fetch;
let recordedCalls: RecordedCall[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Installs a fetch mock that:
 *  - returns `listBody` for any /orchestrator/state (list) request
 *  - returns `{ ok: true }` for any mutating /processes/:name/:action request
 * while recording every call for assertions.
 */
function installFetch(listBody: unknown): void {
  recordedCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers ?? {});
    recordedCalls.push({
      url,
      method,
      callerHeader: headers.get("X-OpenCrow-Caller-Process") ?? undefined,
    });
    if (url.includes("/orchestrator/state")) {
      return Promise.resolve(jsonResponse(listBody));
    }
    // mutating action
    return Promise.resolve(jsonResponse({ ok: true }));
  }) as unknown as typeof fetch;
}

function installFailingListFetch(): void {
  recordedCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    recordedCalls.push({
      url,
      method: init?.method ?? "GET",
      callerHeader: undefined,
    });
    return Promise.reject(new Error("ECONNREFUSED"));
  }) as unknown as typeof fetch;
}

function mutatingCalls(): RecordedCall[] {
  return recordedCalls.filter((c) => !c.url.includes("/orchestrator/state"));
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("process_manage — security branches (isolated)", () => {
  beforeEach(() => {
    dbCalls.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // (a) Non-self target → permission denied, NO control-plane call sent.
  test("rejects a non-self target before any control-plane call", async () => {
    // Default owner is "web" (no agent/scraper env). Target a different process.
    installFetch({ data: [] });

    const tool = createSelfRestartTool();
    const result = await tool.execute({
      action: "stop",
      target: "agent:victim",
      reason: "attempt cross-process control",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Permission denied");
    // The guard short-circuits before the list lookup AND the mutating call.
    expect(recordedCalls.length).toBe(0);
  });

  // (b) Process-list lookup failure → fail closed (no mutating call).
  test("fails closed when the process-list lookup fails", async () => {
    const prev = process.env.OPENCROW_AGENT_ID;
    process.env.OPENCROW_AGENT_ID = "failclosed";
    try {
      installFailingListFetch();

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "restart",
        target: "agent:failclosed", // self target → passes self-only guard
        reason: "list unavailable",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("could not verify process list");
      expect(result.output).toContain("Refusing to restart");
      // It attempted the list lookup but never issued a mutating action.
      expect(mutatingCalls().length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.OPENCROW_AGENT_ID;
      else process.env.OPENCROW_AGENT_ID = prev;
    }
  });

  // (c) Global rate limit: > 3 mutating actions within the window are blocked.
  test("rate limits more than 3 mutating actions within the window", async () => {
    const prev = process.env.OPENCROW_AGENT_ID;
    process.env.OPENCROW_AGENT_ID = "ratelimit";
    const self = "agent:ratelimit";
    try {
      installFetch({
        data: [
          {
            name: self,
            status: "running",
            syncStatus: "synced",
            pid: 1,
            restartCount: 0,
            uptimeSeconds: 100,
          },
        ],
      });

      const tool = createSelfRestartTool();

      // Three distinct (action:target) keys avoid the per-target cooldown, so
      // each records a successful mutating action toward the global cap.
      const r1 = await tool.execute({
        action: "restart",
        target: self,
        reason: "1",
      });
      const r2 = await tool.execute({
        action: "stop",
        target: self,
        reason: "2",
      });
      const r3 = await tool.execute({
        action: "start",
        target: self,
        reason: "3",
      });

      expect(r1.isError).toBe(false);
      expect(r2.isError).toBe(false);
      expect(r3.isError).toBe(false);
      // Three mutating control-plane calls actually went through.
      expect(mutatingCalls().length).toBe(3);

      // A 4th mutating action (any action) is blocked by the global limit before
      // it can reach the control plane.
      const r4 = await tool.execute({
        action: "restart",
        target: self,
        reason: "4 — should be throttled",
      });

      expect(r4.isError).toBe(true);
      expect(r4.output).toContain("Rate limited");
      // Still only 3 mutating calls — the 4th never reached the control plane.
      expect(mutatingCalls().length).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.OPENCROW_AGENT_ID;
      else process.env.OPENCROW_AGENT_ID = prev;
    }
  });
});
