import { describe, expect, it } from "bun:test";
import { decideStaleAction, INSTANCE_ID_KEY, type StaleDecisionInput } from "./instance-guard";

const SELF_PID = 8;
const SELF_ID = "self-instance-uuid";

/** A live, foreign instance on a host that genuinely survived (kill-eligible). */
function baseInput(overrides: Partial<StaleDecisionInput> = {}): StaleDecisionInput {
  return {
    hasExisting: true,
    existingPid: 11,
    existingInstanceId: "previous-instance-uuid",
    selfPid: SELF_PID,
    selfInstanceId: SELF_ID,
    existingPidAlive: true,
    existingPidIsAncestor: false,
    inContainer: false,
    ...overrides,
  };
}

describe("decideStaleAction", () => {
  it("skips when there is no existing registry row", () => {
    const d = decideStaleAction(baseInput({ hasExisting: false }));
    expect(d.action).toBe("skip");
  });

  it("skips when the existing row is self by instanceId", () => {
    const d = decideStaleAction(baseInput({ existingInstanceId: SELF_ID }));
    expect(d.action).toBe("skip");
  });

  it("skips when the existing row is self by PID (legacy, no instanceId)", () => {
    const d = decideStaleAction(
      baseInput({ existingPid: SELF_PID, existingInstanceId: undefined }),
    );
    expect(d.action).toBe("skip");
  });

  it("takes over (no kill) when the recorded PID is dead", () => {
    const d = decideStaleAction(baseInput({ existingPidAlive: false }));
    expect(d.action).toBe("takeover");
  });

  // The reported production bug: container PID reuse maps the stale PID onto the
  // container's own ancestor. Must NEVER kill.
  it("takes over (NEVER kills) inside a container even when PID is alive", () => {
    const d = decideStaleAction(baseInput({ inContainer: true }));
    expect(d.action).toBe("takeover");
  });

  it("takes over (NEVER kills) inside a container even with a differing instanceId", () => {
    const d = decideStaleAction(
      baseInput({ inContainer: true, existingInstanceId: "some-other-uuid" }),
    );
    expect(d.action).not.toBe("kill");
    expect(d.action).toBe("takeover");
  });

  // Belt-and-suspenders: existingPid !== selfPid is insufficient; the offending
  // PID was the ancestor, not equal to self.
  it("refuses to kill an ancestor of self (host)", () => {
    const d = decideStaleAction(baseInput({ existingPidIsAncestor: true, inContainer: false }));
    expect(d.action).toBe("takeover");
    expect(d.reason).toContain("ancestor");
  });

  it("ancestor guard wins over a differing instanceId", () => {
    const d = decideStaleAction(
      baseInput({
        existingPidIsAncestor: true,
        existingInstanceId: "different-uuid",
      }),
    );
    expect(d.action).not.toBe("kill");
  });

  it("takes over (no kill) on host for a legacy row with no instanceId", () => {
    const d = decideStaleAction(baseInput({ existingInstanceId: undefined }));
    // Live PID but ambiguous identity: cannot positively attribute → no kill.
    expect(d.action).toBe("takeover");
  });

  it("KILLS only a genuinely different live instance on a host", () => {
    const d = decideStaleAction(baseInput());
    expect(d.action).toBe("kill");
  });

  it("uses INSTANCE_ID_KEY as the stable metadata key", () => {
    // Guards against silent drift between the supervisor's metadata write and
    // the guard's read.
    expect(INSTANCE_ID_KEY).toBe("instanceId");
  });
});
