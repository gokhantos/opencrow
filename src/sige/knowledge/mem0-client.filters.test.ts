/**
 * Isolated tests for Mem0Client HTTP request body shape.
 *
 * Stubs globalThis.fetch to intercept HTTP calls — deterministic, no live
 * Mem0 sidecar. Filed as *.isolated.test.ts because globalThis.fetch mutation
 * is process-global and leaks across files in a shared process.
 *
 * Coverage:
 *   - search WITH filters sends a top-level `filters` key in the POST body
 *   - search WITHOUT filters omits it entirely (legacy byte-identical)
 *   - addMemories to the ideas namespace sends user_id="sige-ideas" and enable_graph=false
 *   - apiToken Bearer header is still sent on every request
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Mem0Client } from "./mem0-client";

// ── fetch mock harness ────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** Captured fetch requests for later assertions. */
const captured: Array<{ url: string; init: RequestInit }> = [];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  captured.length = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: url.toString(), init: init ?? {} });
    const urlStr = url.toString();
    if (urlStr.includes("/search/")) return okJson({ results: [], relations: [] });
    if (urlStr.includes("/memories/")) return okJson({ results: [], relations: [] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function parseBody(init: RequestInit): Promise<Record<string, unknown>> {
  const raw = init.body;
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (raw instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  }
  throw new Error(`Unexpected body type: ${typeof raw}`);
}

// ── Mem0Client — search request body shape ────────────────────────────────────

describe("Mem0Client — search request body shape", () => {
  test("search WITH filters includes top-level 'filters' key in POST body", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.search({
      query: "test query",
      userId: "sige-ideas",
      limit: 12,
      enableGraph: false,
      filters: { kind: "idea-outcome", verdict: "validated" },
    });

    expect(captured.length).toBe(1);
    const body = await parseBody(captured[0]!.init);
    expect(body).toHaveProperty("filters");
    expect(body["filters"]).toEqual({ kind: "idea-outcome", verdict: "validated" });
  });

  test("search WITHOUT filters omits the 'filters' key entirely (legacy byte-identical)", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.search({
      query: "legacy query",
      userId: "sige-global",
      limit: 30,
    });

    expect(captured.length).toBe(1);
    const body = await parseBody(captured[0]!.init);
    expect(body).not.toHaveProperty("filters");
  });

  test("search body includes query, user_id, limit, and enable_graph", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.search({
      query: "saas idea",
      userId: "sige-ideas",
      limit: 5,
      enableGraph: false,
    });

    const body = await parseBody(captured[0]!.init);
    expect(body["query"]).toBe("saas idea");
    expect(body["user_id"]).toBe("sige-ideas");
    expect(body["limit"]).toBe(5);
    expect(body["enable_graph"]).toBe(false);
  });
});

// ── Mem0Client — addMemories to ideas namespace ───────────────────────────────

describe("Mem0Client — addMemories to ideas namespace", () => {
  test("addMemories sends user_id='sige-ideas' and enable_graph=false", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.addMemories({
      items: [{ content: "Idea outcome memory sentence", metadata: { kind: "idea-outcome" } }],
      userId: "sige-ideas",
      enableGraph: false,
    });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const body = await parseBody(captured[0]!.init);
    expect(body["user_id"]).toBe("sige-ideas");
    expect(body["enable_graph"]).toBe(false);
  });

  test("addMemories sends content as a user-role message", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.addMemories({
      items: [{ content: "Test memory content" }],
      userId: "sige-ideas",
      enableGraph: false,
    });

    const body = await parseBody(captured[0]!.init);
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("Test memory content");
  });

  test("addMemories batches multiple items (one addMemory call per item)", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.addMemories({
      items: [
        { content: "Memory 1" },
        { content: "Memory 2" },
        { content: "Memory 3" },
      ],
      userId: "sige-ideas",
      enableGraph: false,
      maxConcurrent: 3,
    });

    // Three items → three POST /v1/memories/ calls
    expect(captured.length).toBe(3);
  });
});

// ── Mem0Client — Bearer auth header on all requests ──────────────────────────

describe("Mem0Client — Bearer auth header on all requests", () => {
  test("apiToken is sent as Authorization: Bearer on search", async () => {
    const client = new Mem0Client({
      baseUrl: "http://localhost:8080",
      apiToken: "my-secret-token",
    });

    await client.search({ query: "x", userId: "u" });

    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer my-secret-token");
  });

  test("apiToken is sent as Authorization: Bearer on addMemory", async () => {
    const client = new Mem0Client({
      baseUrl: "http://localhost:8080",
      apiToken: "my-secret-token",
    });

    await client.addMemory({ content: "test", userId: "u" });

    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer my-secret-token");
  });

  test("no Authorization header when apiToken is absent", async () => {
    const client = new Mem0Client({ baseUrl: "http://localhost:8080" });

    await client.search({ query: "x", userId: "u" });

    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("authorization")).toBeNull();
  });
});
