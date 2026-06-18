/**
 * Isolated tests for the server-side self-only enforcement on process control
 * routes in src/internal/server.ts.
 *
 * These import and assert the REAL exported decision helper
 * (`decideSelfOnlyProcessControl`) plus exercise it through a Hono app wired to
 * the same `CALLER_PROCESS_HEADER`. We mock the heavy server-side deps so the
 * module imports cleanly without a DB / process registry.
 *
 * Lane: isolated (*.isolated.test.ts) — run with `bun run test:isolated`.
 */

import { describe, test, expect, mock } from "bun:test";
import { Hono } from "hono";

// ────────────────────────────────────────────────────────────────────────────
// Module mocks (must come before any import of the module under test)
// ────────────────────────────────────────────────────────────────────────────

mock.module("../process/health", () => ({
  getProcessStatuses: mock(async () => []),
}));

mock.module("../process/commands", () => ({
  sendCommand: mock(async () => "cmd-id"),
}));

mock.module("../config/loader", () => ({
  loadConfigWithOverrides: mock(async () => ({
    channels: {},
    processes: { scraperProcesses: { scraperIds: [] } },
  })),
}));

mock.module("../config/secrets", () => ({
  getSecret: mock(async (key: string) => {
    if (key === "OPENCROW_INTERNAL_TOKEN") return "test-token-abc";
    return undefined;
  }),
}));

mock.module("../logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import the REAL function under test (after mocks are registered).
import {
  decideSelfOnlyProcessControl,
  CALLER_PROCESS_HEADER,
} from "./server";

// ────────────────────────────────────────────────────────────────────────────
// Hono app exercising the REAL decision helper through HTTP semantics.
// ────────────────────────────────────────────────────────────────────────────
//
// This mirrors how src/internal/server.ts wires the route: read the
// CALLER_PROCESS_HEADER, run the REAL `decideSelfOnlyProcessControl`, and turn a
// denial into a 403 JSON response. We do NOT re-implement the decision — we call
// the production function so divergence is caught.

function buildTestApp(): Hono {
  const app = new Hono();

  // Simulate the auth middleware: any request with the right Bearer token passes.
  app.use("/internal/*", async (c, next) => {
    const authHeader = c.req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token !== "test-token-abc") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  for (const action of ["restart", "stop", "start"] as const) {
    const a = action; // capture for closure
    app.post(`/internal/processes/:name/${a}`, (c) => {
      const name = c.req.param("name");
      const caller = c.req.header(CALLER_PROCESS_HEADER);
      const decision = decideSelfOnlyProcessControl(caller, name, a);
      if (!decision.allowed) {
        return c.json({ error: decision.error }, decision.status);
      }
      return c.json({ ok: true });
    });
  }

  return app;
}

const app = buildTestApp();

// Helper to fire a request against the Hono app without a real server.
async function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-token-abc",
      ...headers,
    },
  });
  const res = await app.fetch(req);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("Internal server — self-only process control enforcement", () => {
  describe("operator caller (no CALLER_PROCESS_HEADER)", () => {
    test("can restart any process", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/web/restart",
      );
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).ok).toBe(true);
    });

    test("can stop any process", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/cron/stop",
      );
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).ok).toBe(true);
    });

    test("can start any process", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/agent:worker/start",
      );
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).ok).toBe(true);
    });

    test("can restart an agent process it does not own", async () => {
      const { status } = await request(
        "POST",
        "/internal/processes/agent:some-other/restart",
      );
      expect(status).toBe(200);
    });
  });

  describe("agent caller (CALLER_PROCESS_HEADER set)", () => {
    test("agent can restart itself (self target)", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/agent:default/restart",
        { [CALLER_PROCESS_HEADER]: "agent:default" },
      );
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).ok).toBe(true);
    });

    test("agent can stop itself (self target)", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/agent:default/stop",
        { [CALLER_PROCESS_HEADER]: "agent:default" },
      );
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).ok).toBe(true);
    });

    test("agent is rejected when trying to restart a different process", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/web/restart",
        { [CALLER_PROCESS_HEADER]: "agent:default" },
      );
      expect(status).toBe(403);
      const err = (body as Record<string, unknown>).error as string;
      expect(err).toContain("Self-only");
      expect(err).toContain("agent:default");
      expect(err).toContain("web");
    });

    test("agent is rejected when trying to stop another agent", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/agent:other/stop",
        { [CALLER_PROCESS_HEADER]: "agent:default" },
      );
      expect(status).toBe(403);
      const err = (body as Record<string, unknown>).error as string;
      expect(err).toContain("Self-only");
      expect(err).toContain("agent:default");
      expect(err).toContain("agent:other");
    });

    test("agent is rejected when trying to stop the cron process", async () => {
      const { status } = await request(
        "POST",
        "/internal/processes/cron/stop",
        { [CALLER_PROCESS_HEADER]: "agent:default" },
      );
      expect(status).toBe(403);
    });

    test("agent is rejected when trying to start any other process", async () => {
      const { status } = await request(
        "POST",
        "/internal/processes/web/start",
        { [CALLER_PROCESS_HEADER]: "agent:researcher" },
      );
      expect(status).toBe(403);
    });

    test("scraper caller rejected when targeting a different process", async () => {
      const { status, body } = await request(
        "POST",
        "/internal/processes/web/restart",
        { [CALLER_PROCESS_HEADER]: "scraper:hackernews" },
      );
      expect(status).toBe(403);
      const err = (body as Record<string, unknown>).error as string;
      expect(err).toContain("scraper:hackernews");
    });

    test("scraper caller allowed when targeting itself", async () => {
      const { status } = await request(
        "POST",
        "/internal/processes/scraper:hackernews/restart",
        { [CALLER_PROCESS_HEADER]: "scraper:hackernews" },
      );
      expect(status).toBe(200);
    });
  });

  describe("auth guard", () => {
    test("rejects request with no bearer token", async () => {
      const req = new Request(
        "http://localhost/internal/processes/web/restart",
        {
          method: "POST",
        },
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    test("rejects request with wrong token", async () => {
      const req = new Request(
        "http://localhost/internal/processes/web/restart",
        {
          method: "POST",
          headers: { Authorization: "Bearer wrong-token" },
        },
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Direct unit tests of the REAL exported decision function.
// ────────────────────────────────────────────────────────────────────────────

describe("decideSelfOnlyProcessControl (real exported function)", () => {
  test("allows when caller header is absent (operator)", () => {
    expect(decideSelfOnlyProcessControl(undefined, "web", "restart")).toEqual({
      allowed: true,
    });
  });

  test("allows when caller === target (self)", () => {
    expect(
      decideSelfOnlyProcessControl("agent:default", "agent:default", "restart"),
    ).toEqual({ allowed: true });
  });

  test("denies with 403 when caller !== target", () => {
    const result = decideSelfOnlyProcessControl("agent:default", "web", "stop");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(403);
    }
  });

  test("403 error message contains caller, target, and action", () => {
    const result = decideSelfOnlyProcessControl(
      "agent:foo",
      "agent:bar",
      "restart",
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain("agent:foo");
      expect(result.error).toContain("agent:bar");
      expect(result.error).toContain("restart");
    }
  });

  test("empty string caller header is treated as operator (full power)", () => {
    // "" is falsy in JS, so the function treats it as no header = operator.
    // This documents the edge: an empty header is NOT enforced as a self-only agent.
    expect(decideSelfOnlyProcessControl("", "web", "restart")).toEqual({
      allowed: true,
    });
  });
});
