/**
 * Unit tests for sandbox.ts — planSandboxedExec() and detectSandboxMechanism().
 *
 * Lane: unit (*.test.ts) — no DB, no FS writes, no real sandbox execution.
 * We only assert on the *plan* (argv shape, kind, mechanism) that the module
 * produces, never on whether the OS sandbox actually blocks anything.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  planSandboxedExec,
  detectSandboxMechanism,
  resetSandboxMechanismCache,
  assertSandboxPosture,
  checkDevToolSandboxPosture,
} from "./sandbox";
import type { SandboxRequest } from "./sandbox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    command: "echo hello",
    cwd: "/tmp/work",
    allowedDirs: ["/tmp/work"],
    mode: "best-effort",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mode: "off"
// ---------------------------------------------------------------------------

describe('planSandboxedExec — mode "off"', () => {
  beforeEach(() => resetSandboxMechanismCache());

  it("returns exec plan with raw bash argv", () => {
    const plan = planSandboxedExec(makeReq({ mode: "off" }));
    expect(plan.kind).toBe("exec");
    if (plan.kind !== "exec") return;
    expect(plan.argv).toEqual(["bash", "-c", "echo hello"]);
    expect(plan.mechanism).toBe("none");
  });

  it("never wraps regardless of platform", () => {
    // Even if the platform is darwin we should still get a raw plan.
    const plan = planSandboxedExec(makeReq({ mode: "off", command: "ls" }));
    expect(plan.kind).toBe("exec");
    if (plan.kind !== "exec") return;
    expect(plan.argv[0]).toBe("bash");
    expect(plan.mechanism).toBe("none");
  });

  it("preserves the exact command string in the argv tail", () => {
    const cmd = 'find /tmp -name "*.log" | head -20';
    const plan = planSandboxedExec(makeReq({ mode: "off", command: cmd }));
    if (plan.kind !== "exec") return;
    expect(plan.argv[plan.argv.length - 1]).toBe(cmd);
  });

  it("returns mechanism none even with allowNetwork:true", () => {
    const plan = planSandboxedExec(makeReq({ mode: "off", allowNetwork: true }));
    if (plan.kind !== "exec") return;
    expect(plan.mechanism).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Mode: "best-effort" — no mechanism available (simulate by cache override)
// ---------------------------------------------------------------------------

describe('planSandboxedExec — mode "best-effort", no mechanism', () => {
  // We use resetSandboxMechanismCache() + a workaround to force "none".
  // Since detectSandboxMechanism() caches the result and we cannot set the
  // cache directly (it's module-private), we rely on the ACTUAL host state for
  // this group: if the CI host has neither sandbox-exec nor bwrap, the plan
  // will be raw. We test the *contract* given no mechanism rather than
  // hard-wiring a platform assumption.
  //
  // For determinism we only run the "fallback to raw" assertion on hosts where
  // the detected mechanism IS "none". On macOS (sandbox-exec) or Linux (bwrap)
  // the plan will be wrapped — both outcomes are valid.

  beforeEach(() => resetSandboxMechanismCache());

  it("returns exec plan (either wrapped or raw) — never refuses", () => {
    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    expect(plan.kind).toBe("exec");
  });

  it("when mechanism is none, falls back to raw bash argv", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "none") {
      // Skip on hosts with a real mechanism — the plan will be wrapped.
      return;
    }
    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toEqual(["bash", "-c", "echo hello"]);
    expect(plan.mechanism).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Mode: "required" — no mechanism → refuse
// ---------------------------------------------------------------------------

describe('planSandboxedExec — mode "required", no mechanism', () => {
  beforeEach(() => resetSandboxMechanismCache());

  it("refuses when mechanism is none", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "none") {
      // Host has a real sandbox — skip this assertion.
      return;
    }
    const plan = planSandboxedExec(makeReq({ mode: "required" }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.reason).toContain("Error:");
    expect(plan.reason.toLowerCase()).toContain("sandbox");
  });

  it("exec plan (wrapped) when mechanism is available", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism === "none") {
      // No mechanism on this host — tested above.
      return;
    }
    const plan = planSandboxedExec(makeReq({ mode: "required" }));
    expect(plan.kind).toBe("exec");
  });
});

// ---------------------------------------------------------------------------
// Mechanism: sandbox-exec (macOS Seatbelt)
// ---------------------------------------------------------------------------

describe("planSandboxedExec — sandbox-exec mechanism", () => {
  beforeEach(() => resetSandboxMechanismCache());

  it("uses sandbox-exec as argv[0] on darwin with mechanism=sandbox-exec", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return; // only run on macOS with sandbox-exec

    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    expect(plan.kind).toBe("exec");
    if (plan.kind !== "exec") return;
    expect(plan.argv[0]).toBe("sandbox-exec");
    expect(plan.mechanism).toBe("sandbox-exec");
  });

  it("includes inline -p profile flag", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    // argv: ["sandbox-exec", "-p", <profile>, "bash", "-c", <command>]
    expect(plan.argv[1]).toBe("-p");
    expect(typeof plan.argv[2]).toBe("string");
  });

  it("profile contains '(deny default)'", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    expect(profile).toContain("(deny default)");
  });

  it("profile contains '(deny network*)' when allowNetwork is false", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort", allowNetwork: false }));
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    expect(profile).toContain("(deny network*)");
  });

  it("profile contains '(allow network*)' when allowNetwork is true", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort", allowNetwork: true }));
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    expect(profile).toContain("(allow network*)");
  });

  it("profile includes subpath for each allowed directory", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const plan = planSandboxedExec(
      makeReq({ mode: "best-effort", allowedDirs: ["/workspace/project", "/tmp/output"] }),
    );
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    expect(profile).toContain("/workspace/project");
    expect(profile).toContain("/tmp/output");
  });

  it("escapes double-quotes in directory paths to prevent profile injection", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const plan = planSandboxedExec(
      makeReq({ mode: "best-effort", allowedDirs: ['/tmp/evil"dir'] }),
    );
    if (plan.kind !== "exec") return;
    const profile = plan.argv[2] as string;
    // The raw double-quote inside the directory name must be escaped.
    expect(profile).toContain('\\"');
  });

  it("terminates with bash -c <command> as the trailing argv", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return;

    const cmd = "ls -la";
    const plan = planSandboxedExec(makeReq({ mode: "best-effort", command: cmd }));
    if (plan.kind !== "exec") return;
    const last = plan.argv[plan.argv.length - 1];
    const secondLast = plan.argv[plan.argv.length - 2];
    expect(secondLast).toBe("-c");
    expect(last).toBe(cmd);
  });
});

// ---------------------------------------------------------------------------
// Mechanism: bwrap (Linux)
// ---------------------------------------------------------------------------

describe("planSandboxedExec — bwrap mechanism", () => {
  beforeEach(() => resetSandboxMechanismCache());

  it("uses bwrap as argv[0] on linux with mechanism=bwrap", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return; // only run on Linux with bwrap

    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    expect(plan.kind).toBe("exec");
    if (plan.kind !== "exec") return;
    expect(plan.argv[0]).toBe("bwrap");
    expect(plan.mechanism).toBe("bwrap");
  });

  it("includes --unshare-net when allowNetwork is false", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort", allowNetwork: false }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("--unshare-net");
  });

  it("does NOT include --unshare-net when allowNetwork is true", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort", allowNetwork: true }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).not.toContain("--unshare-net");
  });

  it("includes --bind-try for each allowed directory", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const dir = "/workspace/myproject";
    const plan = planSandboxedExec(makeReq({ mode: "best-effort", allowedDirs: [dir] }));
    if (plan.kind !== "exec") return;
    const argv = plan.argv as string[];
    const bindIdx = argv.indexOf("--bind-try");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(argv[bindIdx + 1]).toBe(dir);
  });

  it("includes --die-with-parent flag", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("--die-with-parent");
  });

  it("includes --unshare-pid", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const plan = planSandboxedExec(makeReq({ mode: "best-effort" }));
    if (plan.kind !== "exec") return;
    expect(plan.argv).toContain("--unshare-pid");
  });

  it("sets --chdir to the requested cwd", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const cwd = "/workspace/project";
    const plan = planSandboxedExec(makeReq({ mode: "best-effort", cwd }));
    if (plan.kind !== "exec") return;
    const argv = plan.argv as string[];
    const chdirIdx = argv.indexOf("--chdir");
    expect(chdirIdx).toBeGreaterThan(-1);
    expect(argv[chdirIdx + 1]).toBe(cwd);
  });

  it("terminates with bash -c <command>", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;

    const cmd = "npm test";
    const plan = planSandboxedExec(makeReq({ mode: "best-effort", command: cmd }));
    if (plan.kind !== "exec") return;
    const last = plan.argv[plan.argv.length - 1];
    const secondLast = plan.argv[plan.argv.length - 2];
    expect(secondLast).toBe("-c");
    expect(last).toBe(cmd);
  });
});

// ---------------------------------------------------------------------------
// Seatbelt read/write confinement (PR-2 hardening)
// ---------------------------------------------------------------------------

describe("planSandboxedExec — Seatbelt read confinement", () => {
  beforeEach(() => resetSandboxMechanismCache());

  function profileFor(req: Partial<SandboxRequest>): string | null {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "sandbox-exec") return null;
    const plan = planSandboxedExec(makeReq({ mode: "best-effort", ...req }));
    if (plan.kind !== "exec") return null;
    return plan.argv[2] as string;
  }

  it("explicitly DENIES reads of the secret/user trees", () => {
    const profile = profileFor({ allowedDirs: ["/workspace"] });
    if (profile === null) return; // not macOS
    const denyLine =
      profile.split("\n").find((l) => l.startsWith("(deny file-read*")) ?? "";
    expect(denyLine).toContain('"/etc"');
    expect(denyLine).toContain('"/Users"');
    expect(denyLine).toContain('"/private/etc"');
  });

  it("re-allows reads of the workspace AFTER the secret deny (order matters)", () => {
    const profile = profileFor({ allowedDirs: ["/workspace/proj"] });
    if (profile === null) return;
    const lines = profile.split("\n");
    const denyIdx = lines.findIndex((l) => l.startsWith("(deny file-read*"));
    const allowIdx = lines.findIndex(
      (l) => l.startsWith("(allow file-read*") && l.includes("/workspace/proj"),
    );
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(denyIdx);
  });

  it("imports the OS base profile for dyld plumbing", () => {
    const profile = profileFor({ allowedDirs: ["/workspace/proj"] });
    if (profile === null) return;
    expect(profile).toContain('(import "/System/Library/Sandbox/Profiles/bsd.sb")');
  });

  it("does NOT grant blanket write to /tmp, /private/tmp, /var/folders", () => {
    const profile = profileFor({ allowedDirs: ["/workspace/proj"] });
    if (profile === null) return;
    // Extract the file-write* line and assert the shared temp dirs are absent.
    const writeLine =
      profile.split("\n").find((l) => l.startsWith("(allow file-write*")) ?? "";
    expect(writeLine).not.toContain('"/tmp"');
    expect(writeLine).not.toContain('"/private/tmp"');
    expect(writeLine).not.toContain('"/var/folders"');
    expect(writeLine).toContain("/workspace/proj");
  });

  it("binds a private temp dir into the write surface when provided", () => {
    const profile = profileFor({
      allowedDirs: ["/workspace/proj"],
      privateTmpDir: "/workspace/proj/.opencrow-tmp/run-abc",
    });
    if (profile === null) return;
    const writeLine =
      profile.split("\n").find((l) => l.startsWith("(allow file-write*")) ?? "";
    expect(writeLine).toContain("/workspace/proj/.opencrow-tmp/run-abc");
  });
});

describe("planSandboxedExec — bwrap private temp bind (PR-2)", () => {
  beforeEach(() => resetSandboxMechanismCache());

  it("binds the private temp dir read-write when provided", () => {
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "bwrap") return;
    const tmp = "/workspace/proj/.opencrow-tmp/run-xyz";
    const plan = planSandboxedExec(
      makeReq({
        mode: "best-effort",
        allowedDirs: ["/workspace/proj"],
        privateTmpDir: tmp,
      }),
    );
    if (plan.kind !== "exec") return;
    const argv = plan.argv as string[];
    const idx = argv.lastIndexOf("--bind-try");
    // The last --bind-try should bind the private temp dir to itself.
    expect(argv).toContain(tmp);
    expect(idx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// assertSandboxPosture (PR-2 MEDIUM — operator-facing posture)
// ---------------------------------------------------------------------------

describe("assertSandboxPosture", () => {
  beforeEach(() => resetSandboxMechanismCache());

  it("reports unprotected for mode 'off'", () => {
    const posture = assertSandboxPosture("off");
    expect(posture.mode).toBe("off");
    expect(posture.protected).toBe(false);
  });

  it("reports protected for mode 'required' regardless of mechanism", () => {
    const posture = assertSandboxPosture("required");
    expect(posture.protected).toBe(true);
  });

  it("best-effort is protected only when a mechanism exists", () => {
    const posture = assertSandboxPosture("best-effort");
    const mechanism = detectSandboxMechanism();
    expect(posture.protected).toBe(mechanism !== "none");
  });
});

// ---------------------------------------------------------------------------
// detectSandboxMechanism — caching
// ---------------------------------------------------------------------------

describe("detectSandboxMechanism — caching", () => {
  beforeEach(() => resetSandboxMechanismCache());
  afterEach(() => resetSandboxMechanismCache());

  it("returns the same value on repeated calls", () => {
    const first = detectSandboxMechanism();
    const second = detectSandboxMechanism();
    expect(first).toBe(second);
  });

  it("returns a valid mechanism string", () => {
    const mechanism = detectSandboxMechanism();
    expect(["sandbox-exec", "bwrap", "none"]).toContain(mechanism);
  });

  it("resetSandboxMechanismCache allows a fresh detection", () => {
    const first = detectSandboxMechanism();
    resetSandboxMechanismCache();
    const second = detectSandboxMechanism();
    // Should be the same host-detected value, but cache was rebuilt.
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Refuse plan contract
// ---------------------------------------------------------------------------

describe("refuse plan — contract", () => {
  it("refuse plan has a non-empty reason string", () => {
    // Simulate: force the host to "none" so required mode refuses.
    // If host has a real mechanism, required won't refuse — skip.
    resetSandboxMechanismCache();
    const mechanism = detectSandboxMechanism();
    if (mechanism !== "none") return;

    const plan = planSandboxedExec(makeReq({ mode: "required" }));
    if (plan.kind !== "refuse") return;
    expect(plan.reason.length).toBeGreaterThan(10);
    expect(plan.reason).toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// checkDevToolSandboxPosture — fail-closed dev-tool gate
// ---------------------------------------------------------------------------

describe("checkDevToolSandboxPosture", () => {
  beforeEach(() => resetSandboxMechanismCache());

  it('mode "off" without opt-in always refuses (regardless of mechanism)', () => {
    const { refusalReason } = checkDevToolSandboxPosture("off", false);
    expect(refusalReason).not.toBeNull();
    expect(refusalReason!).toContain("sandbox");
  });

  it('mode "off" with opt-in is allowed', () => {
    const { refusalReason } = checkDevToolSandboxPosture("off", true);
    expect(refusalReason).toBeNull();
  });

  it('mode "required" is always active (fails closed per-command instead)', () => {
    const { refusalReason } = checkDevToolSandboxPosture("required", false);
    expect(refusalReason).toBeNull();
  });

  it("opt-in is allowed under every mode", () => {
    for (const mode of ["off", "best-effort", "required"] as const) {
      expect(checkDevToolSandboxPosture(mode, true).refusalReason).toBeNull();
    }
  });

  it('mode "best-effort" follows mechanism availability', () => {
    const mechanism = detectSandboxMechanism();
    const { refusalReason } = checkDevToolSandboxPosture("best-effort", false);
    if (mechanism === "none") {
      // No mechanism + no opt-in -> unprotected -> refuse.
      expect(refusalReason).not.toBeNull();
    } else {
      // A real mechanism makes best-effort active -> allowed.
      expect(refusalReason).toBeNull();
    }
  });
});
