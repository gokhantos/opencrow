import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import type { SandboxMode } from "./sandbox";
import { checkDevToolSandboxPosture } from "./sandbox";
import { runShell, truncateOutput } from "./shell-runner";
import { resolveAllowedDirs, isPathAllowedSync } from "./path-utils";
import { createLogger } from "../logger";
import {
  inputError,
  notFoundError,
  permissionError,
  timeoutError,
  serviceError,
} from "./error-helpers";

const log = createLogger("tool:git");

const VALID_ACTIONS = [
  "status",
  "diff",
  "log",
  "commit",
  "push",
  "pull",
  "branch_list",
  "branch_create",
  "stash",
  "stash_pop",
] as const;

type GitAction = (typeof VALID_ACTIONS)[number];

const PROTECTED_BRANCHES = ["main", "master"] as const;

const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
};

const ANSI_REGEX = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Per-invocation sandbox settings threaded to every git subcommand. A workspace
 * `.git/config` is attacker-authorable and git can execute arbitrary code via
 * its pager / hooks / aliases / core.fsmonitor even during read-only commands
 * (status/diff/log). So EVERY git invocation runs filesystem-confined to the
 * allowed directories via the OS sandbox. Only push/pull additionally need the
 * network; read-only/local subcommands keep `allowNetwork: false`.
 */
interface GitShellConfig {
  readonly mode: SandboxMode;
  readonly allowedDirs: readonly string[];
}

/**
 * Run a git command with the same OS sandbox + allowed-directory confinement as
 * the other dev tools. `allowNetwork` defaults false; push/pull pass true.
 */
function gitShell(
  cfg: GitShellConfig,
  command: string,
  opts: { cwd: string; timeoutMs: number; allowNetwork?: boolean },
): ReturnType<typeof runShell> {
  return runShell(command, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: GIT_ENV,
    allowedDirs: cfg.allowedDirs,
    sandbox: cfg.mode,
    allowNetwork: opts.allowNetwork === true,
  });
}

function isValidAction(action: string): action is GitAction {
  return (VALID_ACTIONS as readonly string[]).includes(action);
}

function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(
    branch.trim() as (typeof PROTECTED_BRANCHES)[number],
  );
}

function gitCmd(path: string, subcommand: string): string {
  return `git -C ${shellEscape(path)} ${subcommand} --no-color`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ok(output: string): ToolResult {
  return { output: stripAnsi(output), isError: false };
}

function err(message: string): ToolResult {
  return { output: message, isError: true };
}

interface GitInput {
  readonly action: string;
  readonly path: string;
  readonly message?: string;
  readonly branch?: string;
  readonly files?: readonly string[];
  readonly staged?: boolean;
  readonly max_lines?: number;
  readonly confirm_main?: boolean;
}

function parseInput(
  raw: Record<string, unknown>,
  defaultPath: string,
): GitInput {
  return {
    action: String(raw.action ?? ""),
    path: raw.path ? String(raw.path) : defaultPath,
    message: raw.message ? String(raw.message) : undefined,
    branch: raw.branch ? String(raw.branch) : undefined,
    files: Array.isArray(raw.files)
      ? raw.files.map((f) => String(f))
      : undefined,
    staged: raw.staged === true,
    max_lines: typeof raw.max_lines === "number" ? raw.max_lines : undefined,
    confirm_main: raw.confirm_main === true,
  };
}

async function verifyGitRepo(
  cfg: GitShellConfig,
  path: string,
): Promise<ToolResult | null> {
  const result = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} rev-parse --git-dir`,
    { cwd: path, timeoutMs: 10_000 },
  );

  if (result.exitCode !== 0) {
    return notFoundError(
      `Path is not a git repository: ${path}\n${stripAnsi(result.stderr)}`,
    );
  }
  return null;
}

function handleShellResult(
  result: Awaited<ReturnType<typeof runShell>>,
  label: string,
): ToolResult {
  if (result.timedOut) {
    return timeoutError(`Git ${label} timed out`);
  }
  if (result.exitCode !== 0) {
    const output = stripAnsi(result.stderr || result.stdout);
    return err(`Git ${label} failed (exit ${result.exitCode}):\n${output}`);
  }
  return ok(result.stdout);
}

// --- Action handlers ---

async function runStatus(
  cfg: GitShellConfig,
  path: string,
): Promise<ToolResult> {
  const result = await gitShell(
    cfg,
    gitCmd(path, "status --porcelain=v2 --branch"),
    { cwd: path, timeoutMs: 30_000 },
  );
  return handleShellResult(result, "status");
}

async function runDiff(
  cfg: GitShellConfig,
  path: string,
  input: GitInput,
): Promise<ToolResult> {
  const maxLines = input.max_lines ?? 200;
  const modifier = input.staged
    ? " --staged"
    : input.branch
      ? ` ${shellEscape(input.branch)}`
      : "";

  const statResult = await gitShell(cfg, gitCmd(path, `diff${modifier} --stat`), {
    cwd: path,
    timeoutMs: 30_000,
  });

  if (statResult.timedOut) {
    return err("Git diff timed out");
  }

  const diffResult = await gitShell(cfg, gitCmd(path, `diff${modifier}`), {
    cwd: path,
    timeoutMs: 30_000,
  });

  if (diffResult.timedOut) {
    return err("Git diff timed out");
  }

  if (diffResult.exitCode !== 0) {
    return handleShellResult(diffResult, "diff");
  }

  const stat = stripAnsi(statResult.stdout.trim());
  const maxBytes = maxLines * 120;
  const diff = truncateOutput(stripAnsi(diffResult.stdout), maxBytes);
  const combined = stat ? `${stat}\n\n${diff}` : diff;

  return ok(combined || "No changes");
}

async function runLog(
  cfg: GitShellConfig,
  path: string,
  input: GitInput,
): Promise<ToolResult> {
  const count = input.max_lines ?? 20;
  const result = await gitShell(
    cfg,
    gitCmd(path, `log --oneline --no-decorate -n ${count}`),
    { cwd: path, timeoutMs: 30_000 },
  );
  return handleShellResult(result, "log");
}

async function runCommit(
  cfg: GitShellConfig,
  path: string,
  input: GitInput,
): Promise<ToolResult> {
  if (!input.message) {
    return err("Error: commit message is required");
  }

  const addCmd =
    input.files && input.files.length > 0
      ? `git -C ${shellEscape(path)} add -- ${input.files.map(shellEscape).join(" ")}`
      : `git -C ${shellEscape(path)} add -A`;

  const addResult = await gitShell(cfg, addCmd, {
    cwd: path,
    timeoutMs: 30_000,
  });

  if (addResult.exitCode !== 0) {
    return handleShellResult(addResult, "add");
  }

  const commitResult = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} commit -m ${shellEscape(input.message)} --no-color`,
    { cwd: path, timeoutMs: 30_000 },
  );

  return handleShellResult(commitResult, "commit");
}

async function runPush(
  cfg: GitShellConfig,
  path: string,
  input: GitInput,
): Promise<ToolResult> {
  const branchResult = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} branch --show-current`,
    { cwd: path, timeoutMs: 10_000 },
  );

  if (branchResult.exitCode !== 0) {
    return handleShellResult(branchResult, "branch detection");
  }

  const branch = branchResult.stdout.trim();

  if (isProtectedBranch(branch) && !input.confirm_main) {
    return err(
      `Refusing to push to ${branch}. Set confirm_main=true to override.`,
    );
  }

  // push needs the network; keep filesystem confinement, allow egress.
  const result = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} push origin ${shellEscape(branch)} --no-color`,
    { cwd: path, timeoutMs: 60_000, allowNetwork: true },
  );

  return handleShellResult(result, "push");
}

async function runPull(cfg: GitShellConfig, path: string): Promise<ToolResult> {
  const branchResult = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} branch --show-current`,
    { cwd: path, timeoutMs: 10_000 },
  );

  if (branchResult.exitCode !== 0) {
    return handleShellResult(branchResult, "branch detection");
  }

  const branch = branchResult.stdout.trim();
  // pull needs the network; keep filesystem confinement, allow egress.
  const result = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} pull --rebase origin ${shellEscape(branch)} --no-color`,
    { cwd: path, timeoutMs: 60_000, allowNetwork: true },
  );

  return handleShellResult(result, "pull");
}

async function runBranchList(
  cfg: GitShellConfig,
  path: string,
): Promise<ToolResult> {
  const result = await gitShell(
    cfg,
    gitCmd(path, "branch -a --sort=-committerdate"),
    { cwd: path, timeoutMs: 30_000 },
  );
  return handleShellResult(result, "branch list");
}

async function runBranchCreate(
  cfg: GitShellConfig,
  path: string,
  input: GitInput,
): Promise<ToolResult> {
  if (!input.branch) {
    return err("Error: branch name is required for branch_create");
  }

  const result = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} checkout -b ${shellEscape(input.branch)} --no-color`,
    { cwd: path, timeoutMs: 30_000 },
  );

  return handleShellResult(result, "branch create");
}

async function runStash(cfg: GitShellConfig, path: string): Promise<ToolResult> {
  const result = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} stash push -m 'auto-stash' --no-color`,
    { cwd: path, timeoutMs: 30_000 },
  );
  return handleShellResult(result, "stash");
}

async function runStashPop(
  cfg: GitShellConfig,
  path: string,
): Promise<ToolResult> {
  const result = await gitShell(
    cfg,
    `git -C ${shellEscape(path)} stash pop --no-color`,
    { cwd: path, timeoutMs: 30_000 },
  );
  return handleShellResult(result, "stash pop");
}

const ACTION_HANDLERS: Record<
  GitAction,
  (cfg: GitShellConfig, path: string, input: GitInput) => Promise<ToolResult>
> = {
  status: (cfg, path) => runStatus(cfg, path),
  diff: (cfg, path, input) => runDiff(cfg, path, input),
  log: (cfg, path, input) => runLog(cfg, path, input),
  commit: (cfg, path, input) => runCommit(cfg, path, input),
  push: (cfg, path, input) => runPush(cfg, path, input),
  pull: (cfg, path) => runPull(cfg, path),
  branch_list: (cfg, path) => runBranchList(cfg, path),
  branch_create: (cfg, path, input) => runBranchCreate(cfg, path, input),
  stash: (cfg, path) => runStash(cfg, path),
  stash_pop: (cfg, path) => runStashPop(cfg, path),
};

export function createGitOperationsTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);
  const defaultPath = allowedDirs[0] ?? process.env.HOME ?? "/";

  return {
    name: "git_operations",
    description:
      "Perform git operations safely. Supports status, diff, log, commit, push, pull, branch management, and stash.",
    categories: ["code"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_ACTIONS],
          description: "The git operation to perform",
        },
        path: {
          type: "string",
          description:
            "Path to the git repository. Defaults to first allowed directory.",
        },
        message: {
          type: "string",
          description: "Commit message (required for commit action)",
        },
        branch: {
          type: "string",
          description: "Branch name (for branch_create, or diff target)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Files to stage for commit. Omit to stage all tracked changes.",
        },
        staged: {
          type: "boolean",
          description: "Show only staged changes (for diff action)",
        },
        max_lines: {
          type: "number",
          description:
            "Maximum output lines for diff/log (default: 200 for diff, 20 for log)",
        },
        confirm_main: {
          type: "boolean",
          description: "Must be true to push to main/master branch",
        },
      },
      required: ["action"],
    },

    async execute(rawInput: Record<string, unknown>): Promise<ToolResult> {
      const input = parseInput(rawInput, defaultPath);

      if (!isValidAction(input.action)) {
        return inputError(
          `Unsupported action: ${input.action}. Valid actions: ${VALID_ACTIONS.join(", ")}`,
        );
      }

      if (!isPathAllowedSync(input.path, allowedDirs)) {
        return permissionError(`Error: path not allowed: ${input.path}`);
      }

      // Validate required fields before hitting the filesystem
      if (input.action === "commit" && !input.message) {
        return inputError("Error: commit message is required");
      }
      if (input.action === "branch_create" && !input.branch) {
        return inputError("Error: branch name is required for branch_create");
      }

      // Fail closed: git can execute attacker-authored code from a workspace
      // .git/config (pager / hooks / aliases / core.fsmonitor) even during
      // read-only commands. The OS sandbox is the boundary that contains it; when
      // it is not active and the operator has not opted in, refuse.
      const posture = checkDevToolSandboxPosture(
        config.sandbox,
        config.allowUnsandboxedDevTools === true,
      );
      if (posture.refusalReason) {
        log.warn("git_operations refused: sandbox not active", {
          sandbox: config.sandbox,
          action: input.action,
        });
        return permissionError(posture.refusalReason);
      }

      log.debug("Git operation", { action: input.action, path: input.path });

      const shellCfg: GitShellConfig = {
        mode: config.sandbox,
        allowedDirs,
      };

      try {
        const repoError = await verifyGitRepo(shellCfg, input.path);
        if (repoError) {
          return repoError;
        }

        const handler = ACTION_HANDLERS[input.action];
        return await handler(shellCfg, input.path, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Git operation failed", error);
        return serviceError(`Git operation error: ${message}`);
      }
    },
  };
}
