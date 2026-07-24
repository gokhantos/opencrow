import { afterEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Unit tests for fetch-with-timeout.ts — the single outbound-HTTP chokepoint
// every App Store scan (direct AND proxied lane) flows through.
//
// The crux test reproduces the production wedge deterministically WITHOUT any
// network: a `fetch` stub whose promise NEVER settles and IGNORES its abort
// signal — mimicking a wedged socket that outlives `AbortSignal.timeout`. This
// is the false-green trap the fix must survive: a fake hang that IS cancellable
// by the abort signal would pass even against the old code, proving nothing.
// This fake is TRULY non-settling, so it fails against the old (abort-only)
// implementation and only passes once a hard-deadline backstop is added.
//
// Stubs `globalThis.fetch` directly (no `mock.module`), so this belongs in the
// unit lane (*.test.ts), not the isolated lane.
// ---------------------------------------------------------------------------

import { fetchWithTimeout } from "./fetch-with-timeout";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Race `promise` against a watchdog so a REGRESSION (fetchWithTimeout hanging
 * forever) fails deterministically instead of hanging the whole test process
 * until the runner's own timeout. Resolves to `"watchdog"` if the watchdog wins.
 */
function raceWatchdog<T>(promise: Promise<T>, watchdogMs: number): Promise<T | "watchdog"> {
  return Promise.race([
    promise,
    new Promise<"watchdog">((resolve) => setTimeout(() => resolve("watchdog"), watchdogMs)),
  ]);
}

describe("fetchWithTimeout hard-deadline backstop", () => {
  it("rejects within a hard deadline when the underlying fetch never settles and ignores its abort signal", async () => {
    // TRULY non-settling: never resolves, never rejects, and does not observe
    // the abort signal at all — a wedged socket that outlives the timeout.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const start = Date.now();
    // Soft timeout 50ms + hard grace (~2s) => hard deadline ~2050ms. Watchdog
    // sits well beyond that so the deadline (not the watchdog) is what settles
    // the call once the fix is in place.
    const outcome = await raceWatchdog(
      fetchWithTimeout("https://itunes.apple.com/search?term=x", {}, 50).then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      8000,
    );
    const elapsed = Date.now() - start;

    // The regression signature: the watchdog winning means fetchWithTimeout
    // hung past the hard deadline (the exact production wedge).
    expect(outcome).not.toBe("watchdog");
    expect(outcome).toMatchObject({ kind: "rejected" });
    const { err } = outcome as { kind: "rejected"; err: unknown };
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.toLowerCase()).toContain("hard deadline");
    // Settled via the deadline, not the watchdog.
    expect(elapsed).toBeLessThan(6000);
  });

  it("resolves normally (no hard-deadline) when the fetch settles quickly", async () => {
    const body = new Response("ok", { status: 200 });
    globalThis.fetch = (() => Promise.resolve(body)) as unknown as typeof fetch;

    const res = await fetchWithTimeout("https://itunes.apple.com/search?term=x", {}, 50);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("surfaces a genuine AbortSignal.timeout rejection as a timeout error (soft path wins, no hard deadline)", async () => {
    // Healthy abort behavior: rejects promptly with a TimeoutError once aborted
    // — the soft path, which must win the race well before the hard deadline.
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          "abort",
          () => {
            const e = new Error("The operation timed out.");
            e.name = "TimeoutError";
            reject(e);
          },
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      fetchWithTimeout("https://itunes.apple.com/search?term=x", {}, 50),
    ).rejects.toThrow(/timed out after 50ms/);
    // Rejected via the soft abort at ~50ms, long before the hard deadline.
    expect(Date.now() - start).toBeLessThan(1500);
  });
});
