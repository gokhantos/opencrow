import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "path";
import {
  runShell,
  truncateOutput,
  resetAllowedDirsCache,
  SHELL_MAX_BYTES,
  BASH_MAX_BYTES,
  BASH_HEAD_BYTES,
  BASH_TAIL_BYTES,
  VALIDATE_MAX_BYTES,
  TEST_MAX_BYTES,
} from "./shell-runner";

// Returns the count of live processes whose command line contains `marker`.
// Uses pgrep -f (matches full args). Exit code 1 = no matches (count 0).
async function countProcesses(marker: string): Promise<number> {
  const proc = Bun.spawn(["pgrep", "-f", marker], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return 0;
  return out.split("\n").filter(Boolean).length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shell-runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    // runShell now enforces config.tools.allowedDirectories, which defaults to
    // the agent workspace under $HOME. Create temp dirs inside it so commands
    // are permitted.
    const home = process.env.HOME ?? "";
    const workspace = join(home, ".opencrow", "workspace");
    await mkdir(workspace, { recursive: true });
    tempDir = await mkdtemp(join(workspace, "shell-runner-test-"));
    resetAllowedDirsCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("runShell - basic execution", () => {
    it("should execute a simple echo command", async () => {
      const result = await runShell("echo hello", { cwd: tempDir });
      expect(result.stdout.trim()).toBe("hello");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it("should capture stderr output", async () => {
      const result = await runShell("echo error >&2", { cwd: tempDir });
      expect(result.stderr.trim()).toBe("error");
      expect(result.exitCode).toBe(0);
    });

    it("should capture both stdout and stderr", async () => {
      const result = await runShell("echo out && echo err >&2", {
        cwd: tempDir,
      });
      expect(result.stdout.trim()).toBe("out");
      expect(result.stderr.trim()).toBe("err");
    });

    it("should return non-zero exit code for failing commands", async () => {
      const result = await runShell("exit 42", { cwd: tempDir });
      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
    });

    it("should track duration in milliseconds", async () => {
      const result = await runShell("echo fast", { cwd: tempDir });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(10000); // should be fast
    });

    it("should use the specified working directory", async () => {
      const result = await runShell("pwd", { cwd: tempDir });
      // realpath may resolve symlinks (e.g., /tmp -> /private/tmp on macOS)
      expect(result.stdout.trim()).toContain(
        tempDir.split("/").pop() as string,
      );
    });

    it("should handle commands that produce no output", async () => {
      const result = await runShell("true", { cwd: tempDir });
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multi-line output", async () => {
      const result = await runShell("echo line1 && echo line2 && echo line3", {
        cwd: tempDir,
      });
      const lines = result.stdout.trim().split("\n");
      expect(lines).toEqual(["line1", "line2", "line3"]);
    });
  });

  describe("runShell - timeout behavior", () => {
    it("should time out when command exceeds timeout", async () => {
      const result = await runShell("sleep 30", {
        cwd: tempDir,
        timeoutMs: 200,
      });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
    });

    it("should not time out for fast commands with generous timeout", async () => {
      const result = await runShell("echo fast", {
        cwd: tempDir,
        timeoutMs: 30000,
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it("should default to 60s timeout when not specified", async () => {
      // We just verify a quick command doesn't time out with the default
      const result = await runShell("echo default-timeout", { cwd: tempDir });
      expect(result.timedOut).toBe(false);
    });

    // Regression: on timeout, bash forks the pipeline (e.g. `yes | head`) as
    // children. SIGKILLing only the bash PID re-parents those children to PID 1
    // where they spin forever (`yes` pins a CPU core). Spawning detached +
    // killing the whole process group must reap them too.
    describe("process-group cleanup", () => {
      // Unique per-test marker so we can detect leaks via pgrep without
      // cross-test interference, plus defensive cleanup if a regression leaks.
      let marker: string;

      beforeEach(() => {
        marker = `UNIQUEMARKER_${crypto.randomUUID().replace(/-/g, "")}`;
      });

      afterEach(() => {
        // Best-effort: reap anything this test may have leaked so a regression
        // can't bleed CPU-spinning processes across the suite.
        Bun.spawnSync(["pkill", "-9", "-f", marker]);
      });

      it("does not leave child processes alive after a TIMEOUT", async () => {
        // `yes <marker>` is a long-lived, CPU-spinning producer; `head` caps
        // the buffer so it doesn't fill memory. The marker rides in argv so
        // pgrep -f can find a survivor.
        const result = await runShell(`yes ${marker} | head -n 100000000`, {
          cwd: tempDir,
          timeoutMs: 100,
        });

        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(-1);

        // Poll briefly: the kill is async w.r.t. the OS reaping the group.
        // Assert the producer is fully gone within a ~2s budget.
        let count = await countProcesses(marker);
        for (let i = 0; i < 20 && count > 0; i++) {
          await sleep(100);
          count = await countProcesses(marker);
        }
        expect(count).toBe(0);
      });
    });
  });

  describe("runShell - environment safety", () => {
    it("should not expose DATABASE_URL in env", async () => {
      // Set a secret in process.env temporarily
      const original = process.env.DATABASE_URL;
      process.env.DATABASE_URL = "postgres://secret:password@localhost/db";
      try {
        const result = await runShell("env", { cwd: tempDir });
        expect(result.stdout).not.toContain("DATABASE_URL");
        expect(result.stdout).not.toContain("secret:password");
      } finally {
        if (original !== undefined) {
          process.env.DATABASE_URL = original;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });

    it("should not expose API keys in env", async () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-secret-key-12345";
      try {
        const result = await runShell("env", { cwd: tempDir });
        expect(result.stdout).not.toContain("OPENAI_API_KEY");
        expect(result.stdout).not.toContain("sk-secret-key-12345");
      } finally {
        if (original !== undefined) {
          process.env.OPENAI_API_KEY = original;
        } else {
          delete process.env.OPENAI_API_KEY;
        }
      }
    });

    it("should include HOME in env", async () => {
      const result = await runShell("echo $HOME", { cwd: tempDir });
      expect(result.stdout.trim()).not.toBe("");
    });

    it("should include PATH in env", async () => {
      const result = await runShell("echo $PATH", { cwd: tempDir });
      expect(result.stdout.trim()).not.toBe("");
    });

    it("should allow custom env overrides", async () => {
      const result = await runShell("echo $MY_VAR", {
        cwd: tempDir,
        env: { MY_VAR: "custom_value" },
      });
      expect(result.stdout.trim()).toBe("custom_value");
    });
  });

  describe("truncateOutput", () => {
    it("should return text unchanged if within limit", () => {
      const text = "short text";
      expect(truncateOutput(text, 1000)).toBe(text);
    });

    it("should truncate text exceeding the limit", () => {
      const text = "a".repeat(200);
      const result = truncateOutput(text, 100);
      expect(result.length).toBeLessThan(250); // truncated + message
      expect(result).toContain("truncated");
      expect(result).toContain("100 bytes omitted");
    });

    it("should include omitted byte count in truncation message", () => {
      const text = "x".repeat(500);
      const result = truncateOutput(text, 300);
      expect(result).toContain("200 bytes omitted");
    });

    it("should use SHELL_MAX_BYTES as default limit", () => {
      const text = "y".repeat(SHELL_MAX_BYTES + 100);
      const result = truncateOutput(text);
      expect(result).toContain("truncated");
    });

    it("should not truncate text exactly at the limit", () => {
      const text = "z".repeat(100);
      const result = truncateOutput(text, 100);
      expect(result).toBe(text);
    });

    it("should handle empty string", () => {
      expect(truncateOutput("", 100)).toBe("");
    });
  });

  describe("named output limits", () => {
    it("SHELL_MAX_BYTES should be 10000", () => {
      expect(SHELL_MAX_BYTES).toBe(10_000);
    });

    it("BASH_MAX_BYTES should be 120000", () => {
      expect(BASH_MAX_BYTES).toBe(120_000);
    });

    it("BASH_HEAD_BYTES should be 80000", () => {
      expect(BASH_HEAD_BYTES).toBe(80_000);
    });

    it("BASH_TAIL_BYTES should be 35000", () => {
      expect(BASH_TAIL_BYTES).toBe(35_000);
    });

    it("VALIDATE_MAX_BYTES should be 3000", () => {
      expect(VALIDATE_MAX_BYTES).toBe(3_000);
    });

    it("TEST_MAX_BYTES should be 5000", () => {
      expect(TEST_MAX_BYTES).toBe(5_000);
    });
  });
});
