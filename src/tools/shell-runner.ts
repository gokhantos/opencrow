/**
 * Shared shell execution utility for development tools.
 * Unlike the bash tool, this runs known safe commands (tsc, eslint, etc.)
 * and inherits the full process.env so tools like cargo, go, python work.
 */
import { loadConfig } from "../config/loader";
import { resolveAllowedDirs, isPathAllowedSync } from "./path-utils";
import { createLogger } from "../logger";
import { killProcessGroup } from "./process-group";

const log = createLogger("tool:shell-runner");

// ---------------------------------------------------------------------------
// Allowed-directory enforcement
// ---------------------------------------------------------------------------
//
// Dev tools (git/validate/test) historically relied only on shellEscape and
// bypassed the bash tool's allowlist, so they could operate on any path on
// disk. We reuse the same config.tools.allowedDirectories here so runShell
// cannot execute outside permitted directories.

let cachedAllowedDirs: readonly string[] | null = null;

function getAllowedDirs(): readonly string[] {
  if (cachedAllowedDirs) return cachedAllowedDirs;
  try {
    const config = loadConfig();
    cachedAllowedDirs = resolveAllowedDirs(config.tools.allowedDirectories);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to load allowed directories; denying runShell", {
      error: message,
    });
    cachedAllowedDirs = [];
  }
  return cachedAllowedDirs;
}

/** Exported for tests that need to reset the cached allowlist. */
export function resetAllowedDirsCache(): void {
  cachedAllowedDirs = null;
}

/** Safe env keys for dev tool subprocesses — no secrets */
const DEV_SAFE_ENV_KEYS = [
  "HOME", "USER", "PATH", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "XDG_RUNTIME_DIR", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
  "VIRTUAL_ENV", "CONDA_PREFIX", "NVM_DIR", "BUN_INSTALL",
];

function getSafeDevEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEV_SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export async function runShell(
  command: string,
  opts: {
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    /**
     * Allowed directories the command may run in. Callers that already resolved
     * their own allowlist (e.g. validate_code, run_tests) should pass it here;
     * otherwise the global config.tools.allowedDirectories is used.
     */
    allowedDirs?: readonly string[];
  },
): Promise<ShellResult> {
  const timeout = opts.timeoutMs ?? 60_000;
  const start = Date.now();

  // Enforce the configured allowed-directory boundary. Dev tools (git, validate,
  // test) previously relied only on shellEscape and could run anywhere on disk.
  const allowedDirs = opts.allowedDirs ?? getAllowedDirs();
  if (!isPathAllowedSync(opts.cwd, allowedDirs)) {
    log.warn("runShell blocked: cwd outside allowed directories", {
      cwd: opts.cwd,
    });
    return {
      stdout: "",
      stderr: `Error: working directory not allowed: ${opts.cwd}`,
      exitCode: 126,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  }

  const proc = Bun.spawn(["bash", "-c", command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...getSafeDevEnv(), ...opts.env },
    // setsid() the child so it leads its own process group; lets us kill the
    // whole pipeline (forked children included) via `process.kill(-pid)` on
    // timeout instead of orphaning them. Works natively on macOS and Linux.
    detached: true,
  });

  const result = await Promise.race([
    (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode, timedOut: false };
    })(),
    new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    }>((resolve) =>
      setTimeout(() => {
        // Kill the whole process group, not just bash, so forked children
        // (e.g. the producer in `yes | head`) die too instead of re-parenting
        // to PID 1 and spinning a CPU core.
        killProcessGroup(proc.pid);
        resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
      }, timeout),
    ),
  ]);

  // Defensive sweep: even on a clean exit a forked child can outlive bash via
  // a pipe-close race. Reap any strays in the group. Best-effort.
  killProcessGroup(proc.pid);

  return { ...result, durationMs: Date.now() - start };
}

// --- Named output limits (importable by specific tools) ---
export const SHELL_MAX_BYTES = 10_000;
export const BASH_MAX_BYTES = 120_000;
export const BASH_HEAD_BYTES = 80_000;
export const BASH_TAIL_BYTES = 35_000;
export const VALIDATE_MAX_BYTES = 3_000;
export const TEST_MAX_BYTES = 5_000;

export function truncateOutput(
  text: string,
  maxBytes: number = SHELL_MAX_BYTES,
): string {
  if (text.length <= maxBytes) return text;
  const omitted = text.length - maxBytes;
  return (
    text.slice(0, maxBytes) + `\n... (truncated, ${omitted} bytes omitted)`
  );
}
