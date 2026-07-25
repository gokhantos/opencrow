/**
 * Isolated tests: every outbound call in the memory path is time-bounded.
 *
 * Lane: isolated (own process) — `globalThis.fetch` is replaced, which must not
 * leak into other test processes.
 *
 * Regression basis (2026-07-25): `qdrant.ts`'s `request()` and
 * `embeddings.ts`'s `embedBatch()` were bare `fetch` calls with no timeout, no
 * abort signal and no retry — the only bounded call in either file was
 * Qdrant's `/healthz` probe. The App Store scraper's hourly chain parked on
 * one of these at 10:36 UTC, held its lane's single-flight lock for 2.5h+ and
 * left `appstore_ranking_history` stale, while Qdrant itself stayed healthy
 * throughout (658-833 requests/hour served for other clients, all 200s, ~0.33s
 * search latency, 0% CPU). The client had no way to give up.
 *
 * What these assert: both call sites now pass an `AbortSignal` down to
 * `fetch`, i.e. they route through `fetchWithTimeout` rather than the bare
 * global. Reverting either to a plain `fetch` drops `init.signal` and fails
 * here. The deadline BEHAVIOUR itself (abort path + never-settles hard
 * deadline) is covered by `sources/shared/fetch-with-timeout.test.ts`; these
 * tests are about the wiring, so they stay fast and need no fake timers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createQdrantClient } from "./qdrant";
import { createLocalOllamaEmbeddingProvider } from "./embeddings";

let originalFetch: typeof globalThis.fetch;
let capturedSignals: Array<AbortSignal | null | undefined>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  capturedSignals = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Records each call's abort signal and replies with `body`. */
function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedSignals.push(init?.signal);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("Qdrant client request timeout", () => {
  test("passes an abort signal on the main request path", async () => {
    // Health probe (createQdrantClient probes on construction) + the search.
    stubFetch({ result: [], status: "ok" });

    const client = await createQdrantClient({ url: "http://127.0.0.1:6333" });
    await client.searchPoints("test_collection", [0.1, 0.2], 1);

    expect(capturedSignals.length).toBeGreaterThan(0);
    for (const signal of capturedSignals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe("Embedding provider request timeout", () => {
  test("passes an abort signal on the embed path", async () => {
    stubFetch({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { total_tokens: 3 } });

    const provider = createLocalOllamaEmbeddingProvider({});
    await provider.embed(["hello"]);

    expect(capturedSignals.length).toBeGreaterThan(0);
    for (const signal of capturedSignals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});
