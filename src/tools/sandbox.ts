/**
 * OS-level sandbox wrapper for shell execution.
 *
 * THREAT: the bash tool (and the dev-tool exec path) run shell commands chosen
 * by an LLM that ingests untrusted scraped content. cwd confinement and string
 * blocklists are trivially bypassable (env ssh, nested sh -c, base64, /dev/tcp).
 * The real boundary is an OS sandbox that restricts the *filesystem* to the
 * allowed directories and disables/filters *network* egress.
 *
 * Mechanisms (detected at runtime):
 *   - macOS:  `sandbox-exec` (Seatbelt) with a generated profile.
 *   - Linux:  `bwrap` (bubblewrap) with bind mounts + `--unshare-net`.
 *
 * Modes come from ToolsConfig.sandbox:
 *   - "off":         never wrap.
 *   - "best-effort": wrap when a mechanism exists; else warn loudly + run raw.
 *   - "required":    fail closed (refuse) when no mechanism exists.
 *
 * This module is PURE w.r.t. execution: it only *builds* an argv (and decides
 * whether to refuse). The caller spawns it. That keeps it composable with the
 * process-group-kill work happening on bash.ts in parallel.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createLogger } from "../logger";

const log = createLogger("tool:sandbox");

export type SandboxMode = "off" | "best-effort" | "required";

export type SandboxMechanism = "sandbox-exec" | "bwrap" | "none";

export interface SandboxRequest {
  /** The raw shell command the agent wants to run. */
  readonly command: string;
  /** Working directory (already validated to be inside allowedDirs). */
  readonly cwd: string;
  /** Resolved, absolute allowed directories the command may read/write. */
  readonly allowedDirs: readonly string[];
  /** Configured mode. */
  readonly mode: SandboxMode;
  /**
   * Allow outbound network from inside the sandbox. Default false (deny).
   * Dev tools that must fetch (e.g. `npm install`) can opt in; the agent bash
   * tool should keep this false.
   */
  readonly allowNetwork?: boolean;
  /**
   * Optional per-invocation private temp directory the caller has already
   * created (and will set as TMPDIR for the child). It is granted read+write
   * inside the sandbox so commands that scribble into TMPDIR keep working
   * WITHOUT the sandbox handing out a blanket grant to the host's shared
   * /tmp, /private/tmp and /var/folders (which let writes land outside the
   * workspace). Should live inside one of `allowedDirs`; the planner does not
   * create it (it stays pure) and does not require it.
   */
  readonly privateTmpDir?: string;
}

export type SandboxPlan =
  | {
      /** Run this argv via Bun.spawn — already sandbox-wrapped (or raw). */
      readonly kind: "exec";
      readonly argv: readonly string[];
      readonly mechanism: SandboxMechanism;
    }
  | {
      /** Refuse to run (mode "required" with no mechanism available). */
      readonly kind: "refuse";
      readonly reason: string;
    };

let cachedMechanism: SandboxMechanism | null = null;

/** Look up an executable on PATH (and well-known absolute locations). */
function isOnPath(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  if (dirs.some((d) => existsSync(join(d, bin)))) return true;
  // Common absolute fallbacks for sandbox binaries.
  return [
    `/usr/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/opt/homebrew/bin/${bin}`,
    `/bin/${bin}`,
  ].some((p) => existsSync(p));
}

/** Detect the best available sandbox mechanism for this host (cached). */
export function detectSandboxMechanism(): SandboxMechanism {
  if (cachedMechanism !== null) return cachedMechanism;

  let mechanism: SandboxMechanism = "none";
  if (process.platform === "darwin" && isOnPath("sandbox-exec")) {
    mechanism = "sandbox-exec";
  } else if (process.platform === "linux" && isOnPath("bwrap")) {
    mechanism = "bwrap";
  }

  cachedMechanism = mechanism;
  return mechanism;
}

/** Test seam: reset the cached mechanism detection. */
export function resetSandboxMechanismCache(): void {
  cachedMechanism = null;
}

/**
 * A per-invocation private temp directory the caller binds into the sandbox and
 * sets as TMPDIR for the child, plus a cleanup handle. Keeping TMPDIR inside the
 * workspace means temp scribbles by the command cannot land outside the
 * confined directories (the sandbox no longer grants the host's shared /tmp).
 */
export interface PrivateTmp {
  readonly dir: string;
  /** Remove the temp dir. Safe to call multiple times; never throws. */
  cleanup(): void;
}

/**
 * Create a fresh, agent-scoped temp dir UNDER `baseDir` (which must be inside
 * the sandbox's allowedDirs). Returns null if it cannot be created — callers
 * then run without a private TMPDIR (commands needing temp may fail, but no
 * containment is lost). This is an explicit FS side effect, kept OUT of the
 * pure planner so `planSandboxedExec` stays side-effect-free and testable.
 */
export function createPrivateTmp(baseDir: string): PrivateTmp | null {
  try {
    const root = join(baseDir, ".opencrow-tmp");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "run-"));
    return {
      dir,
      cleanup(): void {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; a leaked temp dir is non-fatal.
        }
      },
    };
  } catch (error) {
    log.warn("Failed to create private sandbox temp dir; running without TMPDIR", {
      baseDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Startup posture check. Surfaces — loudly — the dangerous configuration where
 * the OS sandbox (the real boundary) is NOT in effect and only the bypassable
 * string blocklists protect shell execution. Operators should not be lulled by
 * the "sandbox is the real boundary" framing when no mechanism exists.
 *
 * Returns the posture so callers/tests can assert on it. Side effect is only
 * logging; it never throws (mode "required" already fails closed per-command in
 * planSandboxedExec, so refusing here would just duplicate that).
 */
export function assertSandboxPosture(mode: SandboxMode): {
  readonly mode: SandboxMode;
  readonly mechanism: SandboxMechanism;
  readonly protected: boolean;
} {
  const mechanism = detectSandboxMechanism();
  const isProtected = mode === "required" || (mode !== "off" && mechanism !== "none");

  if (mode === "off") {
    log.warn(
      "tools.sandbox is 'off': shell execution is UNSANDBOXED. Only the " +
        "bypassable command blocklist protects file reads/exfiltration. Set " +
        "tools.sandbox to 'required' (or install a sandbox mechanism) to harden.",
      { platform: process.platform },
    );
  } else if (mechanism === "none" && mode === "best-effort") {
    log.warn(
      "tools.sandbox is 'best-effort' but NO sandbox mechanism " +
        "(sandbox-exec/bwrap) is available: shell commands run UNSANDBOXED and " +
        "the ONLY protection is the bypassable command blocklist. Install " +
        "bubblewrap (Linux) or set tools.sandbox='required' to fail closed.",
      { platform: process.platform },
    );
  } else if (mechanism === "none" && mode === "required") {
    log.warn(
      "tools.sandbox is 'required' but NO sandbox mechanism is available: " +
        "every shell command will be REFUSED until bubblewrap/sandbox-exec is " +
        "installed.",
      { platform: process.platform },
    );
  } else {
    log.info("OS sandbox active for shell execution", { mode, mechanism });
  }

  return { mode, mechanism, protected: isProtected };
}

/**
 * Fail-closed posture check for dev tools that inherently execute
 * workspace-authored, attacker-controllable code (run_tests, validate_code's
 * lint/typecheck/test steps, git_operations). The OS sandbox is the boundary
 * that contains that code; when it is NOT in effect these tools would execute
 * arbitrary code directly on the host.
 *
 * Returns a refusal reason string when the tool MUST refuse (sandbox inactive
 * and the operator has not opted in), or `null` when it is allowed to proceed.
 * Pure (only reads cached mechanism detection) so it is trivially testable.
 *
 * "Sandbox active" means: mode "required" (which itself fails closed per-command
 * if no mechanism exists), OR mode "best-effort" with a real mechanism present.
 * Mode "off", and "best-effort" with mechanism "none", are NOT active.
 */
export function checkDevToolSandboxPosture(
  mode: SandboxMode,
  allowUnsandboxed: boolean,
): { readonly refusalReason: string | null } {
  const mechanism = detectSandboxMechanism();
  const active = mode === "required" || (mode !== "off" && mechanism !== "none");

  if (active || allowUnsandboxed) {
    return { refusalReason: null };
  }

  return {
    refusalReason:
      "Error: refusing to run dev tools (test/lint/typecheck/git) without an " +
      "active OS sandbox. These tools execute workspace-authored code " +
      "(package.json scripts, eslint/tsconfig/biome configs, .git/config " +
      "hooks/aliases/pager) that is attacker-controllable, and the sandbox is " +
      "the boundary that contains it. Current posture: sandbox=" +
      `${mode}, mechanism=${mechanism}. Install a sandbox mechanism ` +
      "(bubblewrap on Linux / sandbox-exec on macOS), set tools.sandbox to " +
      "'required', or explicitly opt in with tools.allowUnsandboxedDevTools=true " +
      "to accept the arbitrary-code-execution risk.",
  };
}

// --- macOS Seatbelt profile -------------------------------------------------

/**
 * Secret/user trees whose READS are explicitly DENIED. These overlap with the
 * broad system read grant below, but Seatbelt applies the LAST matching rule, so
 * placing these denies AFTER the system allow (and the workspace re-allow AFTER
 * these denies) gives: system readable, secrets unreadable, workspace readable
 * even if it lives under a denied tree (e.g. ~/.opencrow/workspace under /Users).
 * Without this an agent confined to a workspace could still `cat /etc/passwd`,
 * read ~/.ssh, ~/.aws, other users' homes, etc.
 */
const SEATBELT_SECRET_DENY_SUBPATHS: readonly string[] = [
  "/etc",
  "/private/etc",
  "/Users",
  "/var/root",
  "/private/var/root",
  "/var/folders",
  "/private/var/folders",
  "/tmp",
  "/private/tmp",
];

/**
 * Build a Seatbelt (.sb) profile string that:
 *  - imports the OS base BSD profile (so dyld / shared-cache plumbing works —
 *    hand-rolling those read grants reliably SIGABRTs the child),
 *  - denies everything else by default,
 *  - allows process exec + basic system facilities,
 *  - allows broad system READS but then explicitly DENIES the secret/user trees
 *    (/etc, /Users, /var/root, shared temp, …) so a confined agent cannot read
 *    arbitrary host files,
 *  - RE-allows read+write ONLY within the allowed directories and a
 *    per-invocation private temp dir (no blanket /tmp, /var/folders write), so a
 *    workspace under a denied tree still works,
 *  - denies network unless explicitly allowed.
 *
 * Rule ORDER matters: Seatbelt uses the last matching rule, so the workspace
 * allow lines come AFTER the secret denies.
 *
 * Quoting note: directory literals are wrapped in (subpath "…"). We escape any
 * embedded double-quotes/backslashes so a crafted path cannot break out of the
 * profile string.
 */
function buildSeatbeltProfile(
  allowedDirs: readonly string[],
  allowNetwork: boolean,
  privateTmpDir?: string,
): string {
  const escape = (p: string): string => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const subpath = (p: string): string => `(subpath "${escape(p)}")`;

  // Writable surface: the agent's allowed dirs + an optional private temp dir.
  const writeDirs = privateTmpDir ? [...allowedDirs, privateTmpDir] : [...allowedDirs];
  const writeSubpaths = writeDirs.map(subpath).join(" ");
  const denySubpaths = SEATBELT_SECRET_DENY_SUBPATHS.map(subpath).join(" ");

  const lines = [
    "(version 1)",
    // Base profile supplies the dyld shared-cache / system read plumbing a
    // process needs just to start; without it the child SIGABRTs on launch.
    '(import "/System/Library/Sandbox/Profiles/bsd.sb")',
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // Broad system read so toolchains (bun/node/npm/tsc/eslint) resolve...
    "(allow file-read*)",
    // ...but then DENY the secret/user trees (last-match-wins).
    `(deny file-read* ${denySubpaths})`,
    // RE-allow read+write inside the agent's dirs + private temp ONLY. Placed
    // after the deny so a workspace under e.g. /Users is still usable.
    `(allow file-read* ${writeSubpaths})`,
    `(allow file-write* ${writeSubpaths})`,
    // Devices the shell needs to write to (stdout/stderr/null), never the FS.
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr"))',
    allowNetwork ? "(allow network*)" : "(deny network*)",
  ];
  return lines.join("\n");
}

// --- Public API -------------------------------------------------------------

/**
 * Decide how to run `command`: wrapped in a sandbox, raw (best-effort fallback),
 * or refused (required mode, no mechanism).
 */
export function planSandboxedExec(req: SandboxRequest): SandboxPlan {
  const allowNetwork = req.allowNetwork === true;
  const rawArgv: readonly string[] = ["bash", "-c", req.command];

  if (req.mode === "off") {
    return { kind: "exec", argv: rawArgv, mechanism: "none" };
  }

  const mechanism = detectSandboxMechanism();

  if (mechanism === "none") {
    if (req.mode === "required") {
      log.error(
        "Sandbox required but no mechanism available — refusing to run shell command",
        { platform: process.platform },
      );
      return {
        kind: "refuse",
        reason:
          "Error: sandbox required but no sandbox mechanism (sandbox-exec/bwrap) is available on this host; refusing to run shell command",
      };
    }
    // best-effort: loud warning, fall back to raw.
    log.warn(
      "No OS sandbox mechanism available; running shell command UNSANDBOXED (best-effort mode). " +
        "Install bubblewrap (Linux) or run on macOS, or set tools.sandbox to 'required' to fail closed.",
      { platform: process.platform },
    );
    return { kind: "exec", argv: rawArgv, mechanism: "none" };
  }

  if (mechanism === "sandbox-exec") {
    const profile = buildSeatbeltProfile(
      req.allowedDirs,
      allowNetwork,
      req.privateTmpDir,
    );
    // -p <profile> runs the inline profile string.
    return {
      kind: "exec",
      argv: ["sandbox-exec", "-p", profile, "bash", "-c", req.command],
      mechanism,
    };
  }

  // bwrap (Linux / Docker).
  const bwrapArgs: string[] = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    // Read-only system mounts so tools resolve and run.
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];

  if (!allowNetwork) {
    bwrapArgs.push("--unshare-net");
  } else {
    // Network needs resolver config; bind it read-only.
    bwrapArgs.push("--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf");
  }

  // Read-write bind ONLY the allowed directories.
  for (const dir of req.allowedDirs) {
    bwrapArgs.push("--bind-try", dir, dir);
  }
  // Bind the per-invocation private temp dir read-write if the caller provided
  // one (it lives inside allowedDirs; binding it keeps TMPDIR usable while the
  // host's shared /tmp stays a namespace-private tmpfs above).
  if (req.privateTmpDir) {
    bwrapArgs.push("--bind-try", req.privateTmpDir, req.privateTmpDir);
  }

  bwrapArgs.push("--chdir", req.cwd, "bash", "-c", req.command);

  return {
    kind: "exec",
    argv: ["bwrap", ...bwrapArgs],
    mechanism,
  };
}
