import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
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

async function verifyGitRepo(path: string): Promise<ToolResult | null> {
  const result = await runShell(
    `git -C ${shellEscape(path)} rev-parse --git-dir`,
    { cwd: path, timeoutMs: 10_000, env: GIT_ENV },
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

async function runStatus(path: string): Promise<ToolResult> {
  const result = await runShell(
    gitCmd(path, "status --porcelain=v2 --branch"),
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );
  return handleShellResult(result, "status");
}

async function runDiff(path: string, input: GitInput): Promise<ToolResult> {
  const maxLines = input.max_lines ?? 200;
  const modifier = input.staged
    ? " --staged"
    : input.branch
      ? ` ${shellEscape(input.branch)}`
      : "";

  const statResult = await runShell(gitCmd(path, `diff${modifier} --stat`), {
    cwd: path,
    timeoutMs: 30_000,
    env: GIT_ENV,
  });

  if (statResult.timedOut) {
    return err("Git diff timed out");
  }

  const diffResult = await runShell(gitCmd(path, `diff${modifier}`), {
    cwd: path,
    timeoutMs: 30_000,
    env: GIT_ENV,
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

async function runLog(path: string, input: GitInput): Promise<ToolResult> {
  const count = input.max_lines ?? 20;
  const result = await runShell(
    gitCmd(path, `log --oneline --no-decorate -n ${count}`),
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );
  return handleShellResult(result, "log");
}

async function runCommit(path: string, input: GitInput): Promise<ToolResult> {
  if (!input.message) {
    return err("Error: commit message is required");
  }

  const addCmd =
    input.files && input.files.length > 0
      ? `git -C ${shellEscape(path)} add -- ${input.files.map(shellEscape).join(" ")}`
      : `git -C ${shellEscape(path)} add -A`;

  const addResult = await runShell(addCmd, {
    cwd: path,
    timeoutMs: 30_000,
    env: GIT_ENV,
  });

  if (addResult.exitCode !== 0) {
    return handleShellResult(addResult, "add");
  }

  const commitResult = await runShell(
    `git -C ${shellEscape(path)} commit -m ${shellEscape(input.message)} --no-color`,
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );

  return handleShellResult(commitResult, "commit");
}

async function runPush(path: string, input: GitInput): Promise<ToolResult> {
  const branchResult = await runShell(
    `git -C ${shellEscape(path)} branch --show-current`,
    { cwd: path, timeoutMs: 10_000, env: GIT_ENV },
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

  const result = await runShell(
    `git -C ${shellEscape(path)} push origin ${shellEscape(branch)} --no-color`,
    { cwd: path, timeoutMs: 60_000, env: GIT_ENV },
  );

  return handleShellResult(result, "push");
}

async function runPull(path: string): Promise<ToolResult> {
  const branchResult = await runShell(
    `git -C ${shellEscape(path)} branch --show-current`,
    { cwd: path, timeoutMs: 10_000, env: GIT_ENV },
  );

  if (branchResult.exitCode !== 0) {
    return handleShellResult(branchResult, "branch detection");
  }

  const branch = branchResult.stdout.trim();
  const result = await runShell(
    `git -C ${shellEscape(path)} pull --rebase origin ${shellEscape(branch)} --no-color`,
    { cwd: path, timeoutMs: 60_000, env: GIT_ENV },
  );

  return handleShellResult(result, "pull");
}

async function runBranchList(path: string): Promise<ToolResult> {
  const result = await runShell(
    gitCmd(path, "branch -a --sort=-committerdate"),
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );
  return handleShellResult(result, "branch list");
}

async function runBranchCreate(
  path: string,
  input: GitInput,
): Promise<ToolResult> {
  if (!input.branch) {
    return err("Error: branch name is required for branch_create");
  }

  const result = await runShell(
    `git -C ${shellEscape(path)} checkout -b ${shellEscape(input.branch)} --no-color`,
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );

  return handleShellResult(result, "branch create");
}

async function runStash(path: string): Promise<ToolResult> {
  const result = await runShell(
    `git -C ${shellEscape(path)} stash push -m 'auto-stash' --no-color`,
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );
  return handleShellResult(result, "stash");
}

async function runStashPop(path: string): Promise<ToolResult> {
  const result = await runShell(
    `git -C ${shellEscape(path)} stash pop --no-color`,
    { cwd: path, timeoutMs: 30_000, env: GIT_ENV },
  );
  return handleShellResult(result, "stash pop");
}

const ACTION_HANDLERS: Record<
  GitAction,
  (path: string, input: GitInput) => Promise<ToolResult>
> = {
  status: (path) => runStatus(path),
  diff: (path, input) => runDiff(path, input),
  log: (path, input) => runLog(path, input),
  commit: (path, input) => runCommit(path, input),
  push: (path, input) => runPush(path, input),
  pull: (path) => runPull(path),
  branch_list: (path) => runBranchList(path),
  branch_create: (path, input) => runBranchCreate(path, input),
  stash: (path) => runStash(path),
  stash_pop: (path) => runStashPop(path),
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

      log.debug("Git operation", { action: input.action, path: input.path });

      try {
        const repoError = await verifyGitRepo(input.path);
        if (repoError) {
          return repoError;
        }

        const handler = ACTION_HANDLERS[input.action];
        return await handler(input.path, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Git operation failed", error);
        return serviceError(`Git operation error: ${message}`);
      }
    },
  };
}
