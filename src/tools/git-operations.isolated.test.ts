import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { ToolsConfig } from "../config/schema";
import type { ShellResult } from "./shell-runner";

// --- Mocks ---

const mockRunShell =
  mock<
    (
      command: string,
      opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
    ) => Promise<ShellResult>
  >();

const mockTruncateOutput = mock<(text: string, maxBytes?: number) => string>();

mock.module("./shell-runner", () => ({
  runShell: mockRunShell,
  truncateOutput: (...args: [string, number?]) => mockTruncateOutput(...args),
  SHELL_MAX_BYTES: 10_000,
  BASH_MAX_BYTES: 120_000,
  BASH_HEAD_BYTES: 80_000,
  BASH_TAIL_BYTES: 35_000,
  VALIDATE_MAX_BYTES: 3_000,
  TEST_MAX_BYTES: 5_000,
}));

// Import after mocking
const { createGitOperationsTool } = await import("./git-operations");

const DEFAULT_CONFIG: ToolsConfig = {
  allowedDirectories: ["/home/test/projects"],
  blockedCommands: [],
  maxBashTimeout: 600_000,
  maxFileSize: 10_485_760,
  maxIterations: 200,
};

function shellOk(stdout: string): ShellResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 50 };
}

function shellErr(stderr: string, exitCode = 1): ShellResult {
  return { stdout: "", stderr, exitCode, timedOut: false, durationMs: 50 };
}

function shellTimeout(): ShellResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: -1,
    timedOut: true,
    durationMs: 30000,
  };
}

describe("createGitOperationsTool", () => {
  const tool = createGitOperationsTool(DEFAULT_CONFIG);

  test("returns correct tool metadata", () => {
    expect(tool.name).toBe("git_operations");
    expect(tool.categories).toContain("code");
    expect(tool.description).toContain("git");
    expect(tool.inputSchema).toBeDefined();
  });

  test("inputSchema has required action field", () => {
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props.action).toBeDefined();
    expect(schema.required).toContain("action");
  });
});

describe("git_operations execute", () => {
  let tool: ReturnType<typeof createGitOperationsTool>;

  beforeEach(() => {
    mockRunShell.mockReset();
    mockTruncateOutput.mockReset();
    mockTruncateOutput.mockImplementation((text: string) => text);
    tool = createGitOperationsTool(DEFAULT_CONFIG);
  });

  // --- Path validation ---

  test("rejects path outside allowed directories", async () => {
    const result = await tool.execute({
      action: "status",
      path: "/etc/secret",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not allowed");
  });

  // --- Git repo validation ---

  test("rejects path that is not a git repo", async () => {
    mockRunShell.mockResolvedValueOnce(
      shellErr("fatal: not a git repository", 128),
    );

    const result = await tool.execute({
      action: "status",
      path: "/home/test/projects/notgit",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not a git repository");
  });

  // --- Missing required fields ---

  test("rejects commit without message", async () => {
    const result = await tool.execute({
      action: "commit",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("message");
  });

  test("rejects branch_create without branch name", async () => {
    const result = await tool.execute({
      action: "branch_create",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("branch");
  });

  test("rejects invalid action", async () => {
    const result = await tool.execute({
      action: "rebase",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unsupported action");
  });

  // --- Safety checks ---

  test("blocks push to main without confirm_main", async () => {
    // First call: git rev-parse (repo check)
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    // Second call: branch --show-current
    mockRunShell.mockResolvedValueOnce(shellOk("main\n"));

    const result = await tool.execute({
      action: "push",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("main");
    expect(result.output).toContain("confirm_main");
  });

  test("blocks push to master without confirm_main", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("master\n"));

    const result = await tool.execute({
      action: "push",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("confirm_main");
  });

  test("allows push to main with confirm_main=true", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("main\n"));
    mockRunShell.mockResolvedValueOnce(shellOk("Everything up-to-date\n"));

    const result = await tool.execute({
      action: "push",
      path: "/home/test/projects/repo",
      confirm_main: true,
    });
    expect(result.isError).toBe(false);
  });

  test("allows push to feature branch without confirm_main", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("feat/new-tool\n"));
    mockRunShell.mockResolvedValueOnce(shellOk("Everything up-to-date\n"));

    const result = await tool.execute({
      action: "push",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);
  });

  // --- Status ---

  test("status returns parsed output", async () => {
    const porcelainOutput = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -0",
      "1 M. N... 100644 100644 100644 abc def src/file.ts",
      "? untracked.txt",
    ].join("\n");

    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk(porcelainOutput));

    const result = await tool.execute({
      action: "status",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("main");
  });

  // --- Diff ---

  test("diff runs stat and full diff", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    // stat
    mockRunShell.mockResolvedValueOnce(
      shellOk(
        " src/a.ts | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)\n",
      ),
    );
    // full diff
    mockRunShell.mockResolvedValueOnce(
      shellOk("diff --git a/src/a.ts b/src/a.ts\n+added line\n-removed line\n"),
    );

    const result = await tool.execute({
      action: "diff",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("file changed");
  });

  test("diff with staged=true uses --staged flag", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk(""));
    mockRunShell.mockResolvedValueOnce(shellOk(""));

    await tool.execute({
      action: "diff",
      path: "/home/test/projects/repo",
      staged: true,
    });

    const calls = mockRunShell.mock.calls;
    // stat call and diff call should both include --staged
    expect(calls[1]![0]).toContain("--staged");
    expect(calls[2]![0]).toContain("--staged");
  });

  test("diff with branch uses branch as target", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk(""));
    mockRunShell.mockResolvedValueOnce(shellOk(""));

    await tool.execute({
      action: "diff",
      path: "/home/test/projects/repo",
      branch: "develop",
    });

    const calls = mockRunShell.mock.calls;
    expect(calls[1]![0]).toContain("develop");
    expect(calls[2]![0]).toContain("develop");
  });

  // --- Log ---

  test("log returns recent commits", async () => {
    const logOutput = [
      "abc1234 feat: add search",
      "def5678 fix: resolve race condition",
      "ghi9012 refactor: extract utils",
    ].join("\n");

    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk(logOutput));

    const result = await tool.execute({
      action: "log",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("abc1234");
    expect(result.output).toContain("feat: add search");
  });

  test("log respects max_lines parameter", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("abc1234 test\n"));

    await tool.execute({
      action: "log",
      path: "/home/test/projects/repo",
      max_lines: 5,
    });

    const logCmd = mockRunShell.mock.calls[1]![0];
    expect(logCmd).toContain("-n 5");
  });

  // --- Commit ---

  test("commit stages specific files and commits", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    // git add
    mockRunShell.mockResolvedValueOnce(shellOk(""));
    // git commit
    mockRunShell.mockResolvedValueOnce(
      shellOk(
        "[main abc1234] feat: add tool\n 1 file changed, 10 insertions(+)\n",
      ),
    );

    const result = await tool.execute({
      action: "commit",
      path: "/home/test/projects/repo",
      message: "feat: add tool",
      files: ["src/tool.ts"],
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("abc1234");

    const addCmd = mockRunShell.mock.calls[1]![0];
    expect(addCmd).toContain("add --");
    expect(addCmd).toContain("src/tool.ts");
  });

  test("commit stages all tracked files when no files specified", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk(""));
    mockRunShell.mockResolvedValueOnce(
      shellOk("[main def5678] chore: update\n"),
    );

    await tool.execute({
      action: "commit",
      path: "/home/test/projects/repo",
      message: "chore: update",
    });

    const addCmd = mockRunShell.mock.calls[1]![0];
    expect(addCmd).toContain("add -A");
  });

  // --- Pull ---

  test("pull runs pull --rebase", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("main\n"));
    mockRunShell.mockResolvedValueOnce(shellOk("Already up to date.\n"));

    const result = await tool.execute({
      action: "pull",
      path: "/home/test/projects/repo",
    });

    expect(result.isError).toBe(false);
    const pullCmd = mockRunShell.mock.calls[2]![0];
    expect(pullCmd).toContain("pull --rebase");
  });

  // --- Branch list ---

  test("branch_list returns branches", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(
      shellOk("* main\n  feat/search\n  remotes/origin/main\n"),
    );

    const result = await tool.execute({
      action: "branch_list",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("main");
    expect(result.output).toContain("feat/search");
  });

  // --- Branch create ---

  test("branch_create creates new branch", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(
      shellOk("Switched to a new branch 'feat/new'\n"),
    );

    const result = await tool.execute({
      action: "branch_create",
      path: "/home/test/projects/repo",
      branch: "feat/new",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("feat/new");
  });

  // --- Stash ---

  test("stash pushes with message", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(
      shellOk("Saved working directory and index state\n"),
    );

    const result = await tool.execute({
      action: "stash",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);

    const stashCmd = mockRunShell.mock.calls[1]![0];
    expect(stashCmd).toContain("stash push");
    expect(stashCmd).toContain("auto-stash");
  });

  // --- Stash pop ---

  test("stash_pop applies stash", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(
      shellOk("On branch main\nChanges not staged for commit:\n"),
    );

    const result = await tool.execute({
      action: "stash_pop",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(false);

    const popCmd = mockRunShell.mock.calls[1]![0];
    expect(popCmd).toContain("stash pop");
  });

  // --- Timeout handling ---

  test("handles command timeout", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellTimeout());

    const result = await tool.execute({
      action: "status",
      path: "/home/test/projects/repo",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out");
  });

  // --- Shell failure ---

  test("returns error on non-zero exit code", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(
      shellErr("error: pathspec 'nonexistent' did not match any file(s)", 1),
    );

    const result = await tool.execute({
      action: "branch_create",
      path: "/home/test/projects/repo",
      branch: "nonexistent",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("pathspec");
  });

  // --- Environment variables ---

  test("passes GIT_TERMINAL_PROMPT=0 and NO_COLOR=1", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("# branch.head main\n"));

    await tool.execute({
      action: "status",
      path: "/home/test/projects/repo",
    });

    // Check env on the status call (second call, after rev-parse)
    const opts = mockRunShell.mock.calls[1]![1];
    expect(opts.env).toBeDefined();
    expect(opts.env!.GIT_TERMINAL_PROMPT).toBe("0");
    expect(opts.env!.NO_COLOR).toBe("1");
  });

  // --- ANSI stripping ---

  test("strips ANSI escape codes from output", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(
      shellOk("\x1B[32m+ added\x1B[0m\n\x1B[31m- removed\x1B[0m\n"),
    );

    const result = await tool.execute({
      action: "log",
      path: "/home/test/projects/repo",
    });
    expect(result.output).not.toContain("\x1B[");
    expect(result.output).toContain("+ added");
  });

  // --- Default path ---

  test("uses first allowedDirectory when no path provided", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("# branch.head main\n"));

    await tool.execute({ action: "status" });

    const revParseOpts = mockRunShell.mock.calls[0]![1];
    expect(revParseOpts.cwd).toBe("/home/test/projects");
  });

  // --- Diff truncation ---

  test("diff truncates output based on max_lines", async () => {
    mockRunShell.mockResolvedValueOnce(shellOk(".git"));
    mockRunShell.mockResolvedValueOnce(shellOk("stat\n"));
    const longDiff = Array.from({ length: 300 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    mockRunShell.mockResolvedValueOnce(shellOk(longDiff));

    mockTruncateOutput.mockImplementation((text: string) =>
      text.length > 1000 ? text.slice(0, 1000) + "\n... (truncated)" : text,
    );

    await tool.execute({
      action: "diff",
      path: "/home/test/projects/repo",
      max_lines: 50,
    });

    // truncateOutput should have been called
    expect(mockTruncateOutput).toHaveBeenCalled();
  });
});
