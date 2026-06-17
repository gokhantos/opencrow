import { test, expect, describe, afterEach } from "bun:test";
import { Mem0Client } from "./mem0-client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Mem0Client circuit breaker", () => {
  test("trips on connection failure and short-circuits subsequent requests", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }) as typeof fetch;

    const client = new Mem0Client({ baseUrl: "http://127.0.0.1:9" });
    expect(client.isUnavailable()).toBe(false);

    // First call hits the network, fails, and trips the breaker.
    await expect(
      client.search({ query: "x", userId: "u" }),
    ).rejects.toThrow(/Mem0 search failed/);
    expect(client.isUnavailable()).toBe(true);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Second call must NOT re-dial the dead endpoint.
    await expect(
      client.search({ query: "y", userId: "u" }),
    ).rejects.toThrow(/Mem0 search failed/);
    expect(calls).toBe(callsAfterFirst);
  });

  test("does not trip on a structured HTTP error (server reachable)", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as typeof fetch;

    const client = new Mem0Client({ baseUrl: "http://127.0.0.1:9" });

    await expect(
      client.search({ query: "x", userId: "u" }),
    ).rejects.toThrow(/Mem0 search failed/);
    // A 404 means the server answered — the breaker should stay closed.
    expect(client.isUnavailable()).toBe(false);
  });
});
