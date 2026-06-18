/**
 * Isolated tests for sandbox.ts — exercises platform branches that are
 * unreachable on the current host by mocking the mechanism detection.
 *
 * Lane: isolated (*.isolated.test.ts) — must use mock.module, own process.
 *
 * Three branches tested via mock.module on existsSync (via isOnPath):
 *   A. Forced "none" → required → refuse plan
 *   B. Forced "none" → best-effort → raw exec plan
 *   C. Forced "bwrap"  → bwrap plan shape
 *   D. Forced "sandbox-exec" → seatbelt plan shape (validates profile)
 *
 * resetSandboxMechanismCache() is called before each test so the cached
 * mechanism is cleared and re-detected using the mocked existsSync.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Module mock: make isOnPath controllable ──────────────────────────────────
// We intercept `node:fs` existsSync which isOnPath uses internally.

let existsSyncResult = false;

mock.module("node:fs", () => ({
  existsSync: (_path: string) => existsSyncResult,
}));

// Import AFTER mocking so the module picks up the fake existsSync.
const {
  planSandboxedExec,
  detectSandboxMechanism,
  resetSandboxMechanismCache,
} = await import("./sandbox");

import type { SandboxRequest, SandboxMechanism } from "./sandbox";

function req(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    command: "echo test",
    cwd: "/workspace",
    allowedDirs: ["/workspace"],
    mode: "best-effort",
    ...overrides,
  };
}

// Helper: force the cached mechanism to a desired value by controlling
// existsSync and re-detecting.
function forceMechanism(platform: NodeJS.Platform, binExists: boolean): void {
  resetSandboxMechanismCache();
  existsSyncResult = binExists;
  // Temporarily override platform so detectSandboxMechanism picks the right branch.
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  detectSandboxMechanism(); // fills the cache
  Object.defineProperty(process, "platform", { value: orig, configurable: true });
}

// ── A. Forced "none" → required → refuse ────────────────────────────────────

describe("sandbox — forced none mechanism, mode required → refuse", () => {
  beforeEach(() => {
    forceMechanism("linux", false); // linux but bwrap absent → none
  });

  it("returns refuse plan", () => {
    const plan = planSandboxedExec(req({ mode: "required" }));
    expect(plan.kind).toBe("refuse");
  });

  it("refuse reason starts with 'Error:'", () => {
    const plan = planSandboxedExec(req({ mode: "required" }));
    if (plan.kind !== "refuse") return;
    expect(plan.reason.startsWith("Error:")).toBe(true);
  });

  it("refuse reason mentions sandbox", () => {
    const plan = planSandboxedExec(req({ mode: "required" }));
    if (plan.kind !== "refuse") return;
    expect(plan.reason.toLowerCase()).toContain("sandbox");
  });
});

// ── B. Forced "none" → best-effort → raw exec ────────────────────────────────

describe("sandbox — forced none mechanism, mode best-effort → raw exec", () => {
  beforeEach(() => {
    forceMechanism("linux", false);
  });

  it("returns exec plan", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    expect(plan.kind).toBe("exec");
  });

  it("exec plan mechanism is 'none'", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.mechanism).toBe("none");
  });

  it("exec plan argv is raw ['bash', '-c', command]", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort", command: "ls" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toEqual(["bash", "-c", "ls"]);
  });
});

// ── C. Forced "bwrap" (Linux) ─────────────────────────────────────────────────

describe("sandbox — forced bwrap mechanism", () => {
  beforeEach(() => {
    forceMechanism("linux", true); // linux + bwrap found → bwrap
  });

  it("returns exec plan with mechanism bwrap", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    expect(plan.kind).toBe("exec");
    if (plan.kind !== "exec") return;
    expect(plan.mechanism).toBe("bwrap");
  });

  it("argv[0] is 'bwrap'", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[0]).toBe("bwrap");
  });

  it("contains --die-with-parent", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("--die-with-parent");
  });

  it("contains --unshare-pid", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("--unshare-pid");
  });

  it("contains --unshare-net when allowNetwork is false", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort", allowNetwork: false }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("--unshare-net");
  });

  it("does NOT contain --unshare-net when allowNetwork is true", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort", allowNetwork: true }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).not.toContain("--unshare-net");
  });

  it("contains --ro-bind-try for resolver when allowNetwork is true", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort", allowNetwork: true }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("/etc/resolv.conf");
  });

  it("contains --bind-try for each allowed directory", () => {
    const dir = "/workspace/project";
    const plan = planSandboxedExec(
      req({ mode: "best-effort", allowedDirs: [dir] }),
    );
    if (plan.kind !== "exec") return;
    const argv = plan.argv as string[];
    const idx = argv.indexOf("--bind-try");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe(dir);
    expect(argv[idx + 2]).toBe(dir);
  });

  it("sets --chdir to the cwd", () => {
    const cwd = "/workspace/src";
    const plan = planSandboxedExec(req({ mode: "best-effort", cwd, allowedDirs: [cwd] }));
    if (plan.kind !== "exec") return;
    const argv = plan.argv as string[];
    const idx = argv.indexOf("--chdir");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe(cwd);
  });

  it("terminates with bash -c <command>", () => {
    const cmd = "npm test";
    const plan = planSandboxedExec(req({ mode: "best-effort", command: cmd }));
    if (plan.kind !== "exec") return;
    const last = plan.argv[plan.argv.length - 1];
    const secondLast = plan.argv[plan.argv.length - 2];
    expect(secondLast).toBe("-c");
    expect(last).toBe(cmd);
  });

  it("required mode succeeds (exec) when mechanism is available", () => {
    const plan = planSandboxedExec(req({ mode: "required" }));
    expect(plan.kind).toBe("exec");
  });
});

// ── D. Forced "sandbox-exec" (macOS) ─────────────────────────────────────────

describe("sandbox — forced sandbox-exec mechanism", () => {
  beforeEach(() => {
    forceMechanism("darwin", true); // darwin + sandbox-exec found
  });

  it("returns exec plan with mechanism sandbox-exec", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    expect(plan.kind).toBe("exec");
    if (plan.kind !== "exec") return;
    expect(plan.mechanism).toBe("sandbox-exec");
  });

  it("argv[0] is 'sandbox-exec'", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[0]).toBe("sandbox-exec");
  });

  it("includes -p as second arg", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[1]).toBe("-p");
  });

  it("third arg is a string (the inline seatbelt profile)", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(typeof plan.argv[2]).toBe("string");
  });

  it("profile contains (deny default)", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[2] as string).toContain("(deny default)");
  });

  it("profile contains (deny network*) when allowNetwork false", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort", allowNetwork: false }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[2] as string).toContain("(deny network*)");
  });

  it("profile contains (allow network*) when allowNetwork true", () => {
    const plan = planSandboxedExec(req({ mode: "best-effort", allowNetwork: true }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[2] as string).toContain("(allow network*)");
  });

  it("profile includes each allowed directory as a subpath", () => {
    const dirs = ["/workspace/app", "/tmp/build"];
    const plan = planSandboxedExec(
      req({ mode: "best-effort", allowedDirs: dirs }),
    );
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    expect(profile).toContain("/workspace/app");
    expect(profile).toContain("/tmp/build");
  });

  it("escapes a double-quote in directory path to prevent profile injection", () => {
    const plan = planSandboxedExec(
      req({ mode: "best-effort", allowedDirs: ['/tmp/evil"dir'] }),
    );
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    // The literal " inside the path must be escaped to \"
    expect(profile).toContain('\\"');
  });

  it("terminates with bash -c <command>", () => {
    const cmd = "bun run build";
    const plan = planSandboxedExec(req({ mode: "best-effort", command: cmd }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[plan.argv.length - 1]).toBe(cmd);
    expect(plan.argv[plan.argv.length - 2]).toBe("-c");
  });

  it("required mode succeeds (exec) when mechanism is available", () => {
    const plan = planSandboxedExec(req({ mode: "required" }));
    expect(plan.kind).toBe("exec");
  });
});

// ── detectSandboxMechanism — reset seam ─────────────────────────────────────

describe("detectSandboxMechanism — reset seam", () => {
  it("after reset, re-detection picks up the mocked state", () => {
    forceMechanism("linux", true);
    const first: SandboxMechanism = detectSandboxMechanism();
    expect(first).toBe("bwrap");

    // Switch mock to no binary → should detect none after reset
    existsSyncResult = false;
    resetSandboxMechanismCache();
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const second: SandboxMechanism = detectSandboxMechanism();
    Object.defineProperty(process, "platform", { value: orig, configurable: true });

    expect(second).toBe("none");
  });
});
