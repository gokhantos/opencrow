import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  runShell,
  truncateOutput,
  SHELL_MAX_BYTES,
  BASH_MAX_BYTES,
  BASH_HEAD_BYTES,
  BASH_TAIL_BYTES,
  VALIDATE_MAX_BYTES,
  TEST_MAX_BYTES,
} from "./shell-runner";

describe("shell-runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shell-runner-test-"));
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
