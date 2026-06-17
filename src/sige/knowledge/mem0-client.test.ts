import { test, expect, describe, afterEach } from "bun:test";
import { Mem0Client } from "./mem0-client";

const realFetch = globalThis.fetch;
const realNow = Date.now;

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

function connErr(): never {
  throw new Error("Unable to connect. Is the computer able to access the url?");
}
function okResponse(): Response {
  return new Response(JSON.stringify({ results: [], relations: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Mem0Client circuit breaker", () => {
  test("trips on connection failure and short-circuits subsequent requests", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;

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
      new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const client = new Mem0Client({ baseUrl: "http://127.0.0.1:9" });

    await expect(
      client.search({ query: "x", userId: "u" }),
    ).rejects.toThrow(/Mem0 search failed/);
    // A 404 means the server answered — the breaker should stay closed.
    expect(client.isUnavailable()).toBe(false);
  });
});

describe("Mem0Client half-open recovery", () => {
  test("half-opens after the cooldown and closes on a successful probe", async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let calls = 0;
    let mode: "fail" | "ok" = "fail";
    globalThis.fetch = (async () => {
      calls += 1;
      if (mode === "fail") connErr();
      return okResponse();
    }) as unknown as typeof fetch;

    const client = new Mem0Client({ baseUrl: "http://127.0.0.1:9" });

    // Trip the breaker.
    await expect(client.search({ query: "x", userId: "u" })).rejects.toThrow();
    expect(client.isUnavailable()).toBe(true);
    expect(calls).toBe(1);

    // Within the cooldown → short-circuit, no dial.
    now += 10_000;
    await expect(client.search({ query: "x", userId: "u" })).rejects.toThrow();
    expect(calls).toBe(1);

    // Cooldown elapsed and the endpoint is healthy again → the probe dials and
    // the breaker closes, with no process restart.
    now += 25_000; // 35s total > 30s cooldown
    mode = "ok";
    await client.search({ query: "x", userId: "u" });
    expect(client.isUnavailable()).toBe(false);
    expect(calls).toBe(2);

    // Subsequent calls flow normally.
    await client.search({ query: "y", userId: "u" });
    expect(calls).toBe(3);
  });

  test("a failed probe re-opens the breaker and restarts the cooldown", async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      connErr();
    }) as unknown as typeof fetch;

    const client = new Mem0Client({ baseUrl: "http://127.0.0.1:9" });
    await expect(client.search({ query: "x", userId: "u" })).rejects.toThrow();
    expect(calls).toBe(1);

    // Cooldown elapsed → probe dials, still failing → re-open.
    now += 31_000;
    await expect(client.search({ query: "x", userId: "u" })).rejects.toThrow();
    expect(calls).toBe(2);
    expect(client.isUnavailable()).toBe(true);

    // Right after the failed probe → short-circuit again (cooldown restarted).
    now += 5_000;
    await expect(client.search({ query: "x", userId: "u" })).rejects.toThrow();
    expect(calls).toBe(2);
  });

  test("concurrent half-open requests dial only once (single-flight probe)", async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let calls = 0;
    let mode: "fail" | "ok" = "fail";
    globalThis.fetch = (async () => {
      calls += 1;
      if (mode === "fail") connErr();
      return okResponse();
    }) as unknown as typeof fetch;

    const client = new Mem0Client({ baseUrl: "http://127.0.0.1:9" });
    await expect(client.search({ query: "x", userId: "u" })).rejects.toThrow();
    expect(calls).toBe(1);

    // Cooldown elapsed; fire three concurrently — only the first probes.
    now += 31_000;
    mode = "ok";
    const results = await Promise.allSettled([
      client.search({ query: "a", userId: "u" }),
      client.search({ query: "b", userId: "u" }),
      client.search({ query: "c", userId: "u" }),
    ]);
    expect(calls).toBe(2); // 1 initial trip + 1 probe
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(client.isUnavailable()).toBe(false);
  });
});
