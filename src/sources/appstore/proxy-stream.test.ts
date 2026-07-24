import { describe, expect, it } from "bun:test";
import {
  advanceProxyBreaker,
  computeBreakerCooloffMs,
  createSweepPartition,
  INITIAL_PROXY_BREAKER_STATE,
  isProxyBreakerOpen,
} from "./proxy-stream";
import type { ProxyBreakerParams, ProxyBreakerState } from "./proxy-stream";

const PARAMS: ProxyBreakerParams = {
  failureThreshold: 5,
  cooloffMs: 15 * 60 * 1000,
  maxCooloffMs: 6 * 60 * 60 * 1000,
};

const NOW = 1_753_000_000_000;

describe("advanceProxyBreaker — trip conditions", () => {
  it("trips on the observed dead-pool signature: scanned:0/failed:5 in one tick", () => {
    const next = advanceProxyBreaker(
      INITIAL_PROXY_BREAKER_STATE,
      { scanned: 0, failed: 5 },
      NOW,
      PARAMS,
    );
    expect(next.openUntilMs).toBe(NOW + PARAMS.cooloffMs);
    expect(next.consecutiveTrips).toBe(1);
    expect(next.consecutiveFailures).toBe(0);
    expect(isProxyBreakerOpen(next, NOW)).toBe(true);
  });

  it("accumulates success-free failures ACROSS ticks (small throttled batches still trip)", () => {
    let state = INITIAL_PROXY_BREAKER_STATE;
    // Three ticks of scanned:0/failed:2 — trips on the third (2+2+2 >= 5).
    state = advanceProxyBreaker(state, { scanned: 0, failed: 2 }, NOW, PARAMS);
    expect(state.openUntilMs).toBeNull();
    expect(state.consecutiveFailures).toBe(2);
    state = advanceProxyBreaker(state, { scanned: 0, failed: 2 }, NOW, PARAMS);
    expect(state.openUntilMs).toBeNull();
    expect(state.consecutiveFailures).toBe(4);
    state = advanceProxyBreaker(state, { scanned: 0, failed: 2 }, NOW, PARAMS);
    expect(state.openUntilMs).toBe(NOW + PARAMS.cooloffMs);
  });

  it("does NOT trip below the threshold", () => {
    const next = advanceProxyBreaker(
      INITIAL_PROXY_BREAKER_STATE,
      { scanned: 0, failed: 4 },
      NOW,
      PARAMS,
    );
    expect(next.openUntilMs).toBeNull();
    expect(next.consecutiveFailures).toBe(4);
    expect(isProxyBreakerOpen(next, NOW)).toBe(false);
  });

  it("a partially-successful tick never trips and fully resets the failure accumulator (partial degradation is the AIMD throttle's job)", () => {
    const accumulated: ProxyBreakerState = {
      consecutiveFailures: 4,
      consecutiveTrips: 0,
      openUntilMs: null,
    };
    // Even with many failures in the tick, one success proves the pool works.
    const next = advanceProxyBreaker(accumulated, { scanned: 1, failed: 40 }, NOW, PARAMS);
    expect(next).toEqual(INITIAL_PROXY_BREAKER_STATE);
  });

  it("an empty tick (scanned:0/failed:0 — skipped/empty batch) leaves state unchanged", () => {
    const accumulated: ProxyBreakerState = {
      consecutiveFailures: 3,
      consecutiveTrips: 2,
      openUntilMs: null,
    };
    const next = advanceProxyBreaker(accumulated, { scanned: 0, failed: 0 }, NOW, PARAMS);
    expect(next).toEqual(accumulated);
  });

  it("does not mutate the input state (immutability)", () => {
    const state: ProxyBreakerState = {
      consecutiveFailures: 1,
      consecutiveTrips: 0,
      openUntilMs: null,
    };
    advanceProxyBreaker(state, { scanned: 0, failed: 2 }, NOW, PARAMS);
    expect(state).toEqual({ consecutiveFailures: 1, consecutiveTrips: 0, openUntilMs: null });
  });
});

describe("advanceProxyBreaker — reset and exponential back-off", () => {
  it("a healthy tick after a trip resets the breaker completely (half-open probe succeeded)", () => {
    const tripped = advanceProxyBreaker(
      INITIAL_PROXY_BREAKER_STATE,
      { scanned: 0, failed: 5 },
      NOW,
      PARAMS,
    );
    const afterCooloff = NOW + PARAMS.cooloffMs + 1;
    expect(isProxyBreakerOpen(tripped, afterCooloff)).toBe(false);
    const healthy = advanceProxyBreaker(tripped, { scanned: 10, failed: 0 }, afterCooloff, PARAMS);
    expect(healthy).toEqual(INITIAL_PROXY_BREAKER_STATE);
  });

  it("consecutive trips double the cool-off each time", () => {
    let state = INITIAL_PROXY_BREAKER_STATE;
    let now = NOW;
    // Trip 1: base cool-off.
    state = advanceProxyBreaker(state, { scanned: 0, failed: 5 }, now, PARAMS);
    expect(state.openUntilMs).toBe(now + PARAMS.cooloffMs);
    // Trip 2 (failed probe after the cool-off): 2x.
    now = state.openUntilMs! + 1;
    state = advanceProxyBreaker(state, { scanned: 0, failed: 5 }, now, PARAMS);
    expect(state.consecutiveTrips).toBe(2);
    expect(state.openUntilMs).toBe(now + PARAMS.cooloffMs * 2);
    // Trip 3: 4x.
    now = state.openUntilMs! + 1;
    state = advanceProxyBreaker(state, { scanned: 0, failed: 5 }, now, PARAMS);
    expect(state.consecutiveTrips).toBe(3);
    expect(state.openUntilMs).toBe(now + PARAMS.cooloffMs * 4);
  });

  it("caps the exponential cool-off at maxCooloffMs", () => {
    // 15min base doubles past 6h somewhere around trip 6; trip 60 is far past it.
    expect(computeBreakerCooloffMs(60, PARAMS)).toBe(PARAMS.maxCooloffMs);
    expect(computeBreakerCooloffMs(1, PARAMS)).toBe(PARAMS.cooloffMs);
    expect(computeBreakerCooloffMs(2, PARAMS)).toBe(PARAMS.cooloffMs * 2);
  });

  it("isProxyBreakerOpen is a strict window: open strictly before openUntilMs, closed at/after it", () => {
    const tripped: ProxyBreakerState = {
      consecutiveFailures: 0,
      consecutiveTrips: 1,
      openUntilMs: NOW + 1000,
    };
    expect(isProxyBreakerOpen(tripped, NOW)).toBe(true);
    expect(isProxyBreakerOpen(tripped, NOW + 999)).toBe(true);
    expect(isProxyBreakerOpen(tripped, NOW + 1000)).toBe(false);
    expect(isProxyBreakerOpen(INITIAL_PROXY_BREAKER_STATE, NOW)).toBe(false);
  });
});

describe("createSweepPartition — two-stream work partitioning", () => {
  it("a keyword claimed by one stream is excluded from and unclaimable by the other", () => {
    const partition = createSweepPartition();
    const directClaim = partition.direct.claim(["a", "b"]);
    expect(directClaim.keywords).toEqual(["a", "b"]);

    // SQL-level exclusion snapshot sees the direct stream's claims.
    expect([...partition.proxied.excluded()].sort()).toEqual(["a", "b"]);

    // Post-select re-check: even if the proxied stream's DB query raced and
    // returned an overlapping candidate, claim() drops it.
    const proxiedClaim = partition.proxied.claim(["b", "c"]);
    expect(proxiedClaim.keywords).toEqual(["c"]);

    directClaim.release();
    proxiedClaim.release();
  });

  it("release() frees the keywords for the other stream, and is idempotent", () => {
    const partition = createSweepPartition();
    const claim = partition.direct.claim(["a"]);
    expect(partition.proxied.claim(["a"]).keywords).toEqual([]);

    claim.release();
    claim.release(); // idempotent — must not throw or double-free

    const after = partition.proxied.claim(["a"]);
    expect(after.keywords).toEqual(["a"]);
    after.release();
  });

  it("excluded() is empty while the sibling stream holds no claims (feature-off behavior)", () => {
    const partition = createSweepPartition();
    expect(partition.direct.excluded()).toEqual([]);
    expect(partition.proxied.excluded()).toEqual([]);
  });

  it("claims are per-slot: a stream never re-claims its own in-flight keyword", () => {
    const partition = createSweepPartition();
    const first = partition.direct.claim(["a"]);
    const second = partition.direct.claim(["a", "b"]);
    expect(second.keywords).toEqual(["b"]);
    first.release();
    second.release();
  });

  it("does not mutate the candidates array passed in", () => {
    const partition = createSweepPartition();
    const candidates = ["a", "b"];
    const claim = partition.direct.claim(candidates);
    expect(candidates).toEqual(["a", "b"]);
    claim.release();
  });
});
