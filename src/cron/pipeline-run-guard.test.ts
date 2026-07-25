import { describe, expect, it } from "bun:test";
import {
  DEFAULT_START_GRACE_SECONDS,
  decidePipelineRunStart,
  type InFlightRun,
} from "./pipeline-run-guard";

const NOW = 1_800_000_000;

function run(over: Partial<InFlightRun> = {}): InFlightRun {
  return {
    runId: "run-1",
    startedAt: NOW - 600,
    hasFreshHeartbeat: false,
    ...over,
  };
}

describe("decidePipelineRunStart", () => {
  it("starts when nothing is in flight", () => {
    const d = decidePipelineRunStart([], { nowEpochSeconds: NOW });
    expect(d.shouldRun).toBe(true);
    expect(d.blockingRunId).toBeNull();
    expect(d.reason).toBeNull();
  });

  it("skips when an in-flight run has a fresh heartbeat", () => {
    const d = decidePipelineRunStart([run({ hasFreshHeartbeat: true })], {
      nowEpochSeconds: NOW,
    });
    expect(d.shouldRun).toBe(false);
    expect(d.blockingRunId).toBe("run-1");
    expect(d.reason).toContain("heartbeat");
  });

  it("skips a just-started run that has not ticked a step yet (grace window)", () => {
    const d = decidePipelineRunStart(
      [run({ startedAt: NOW - 10, hasFreshHeartbeat: false })],
      { nowEpochSeconds: NOW },
    );
    expect(d.shouldRun).toBe(false);
    expect(d.blockingRunId).toBe("run-1");
    expect(d.reason).toContain("grace");
  });

  it("starts anyway when the only in-flight run is stale beyond the grace window", () => {
    // A zombie 'running' row whose owner died — the reaper will clean it up; a
    // scheduled run must not be blocked forever by it.
    const d = decidePipelineRunStart(
      [run({ startedAt: NOW - DEFAULT_START_GRACE_SECONDS - 1, hasFreshHeartbeat: false })],
      { nowEpochSeconds: NOW },
    );
    expect(d.shouldRun).toBe(true);
    expect(d.blockingRunId).toBeNull();
  });

  it("treats a null startedAt as inside the grace window (unknown age is not proof of death)", () => {
    const d = decidePipelineRunStart([run({ startedAt: null })], { nowEpochSeconds: NOW });
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toContain("grace");
  });

  it("honours an explicit grace override", () => {
    const stale = run({ startedAt: NOW - 100, hasFreshHeartbeat: false });
    expect(
      decidePipelineRunStart([stale], { nowEpochSeconds: NOW, startGraceSeconds: 50 }).shouldRun,
    ).toBe(true);
    expect(
      decidePipelineRunStart([stale], { nowEpochSeconds: NOW, startGraceSeconds: 200 }).shouldRun,
    ).toBe(false);
  });

  it("a fresh heartbeat blocks even when the run is older than the grace window", () => {
    const d = decidePipelineRunStart(
      [run({ startedAt: NOW - 100_000, hasFreshHeartbeat: true })],
      { nowEpochSeconds: NOW },
    );
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toContain("heartbeat");
  });

  it("blocks on the first live run when several are in flight", () => {
    const d = decidePipelineRunStart(
      [
        run({ runId: "dead", startedAt: NOW - 99_999, hasFreshHeartbeat: false }),
        run({ runId: "alive", startedAt: NOW - 99_999, hasFreshHeartbeat: true }),
      ],
      { nowEpochSeconds: NOW },
    );
    expect(d.shouldRun).toBe(false);
    expect(d.blockingRunId).toBe("alive");
  });
});
