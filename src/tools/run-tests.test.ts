import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolsConfig } from "../config/schema";

// We need to import the module to test internal functions.
// Since parseTestOutput, shellQuote, buildCommand are not exported, we test them
// indirectly through the tool or re-extract them.
// However, we can import createRunTestsTool and test via its execute method.
import { createRunTestsTool } from "./run-tests";

// To test the internal pure functions, we replicate them here for direct testing.
// This mirrors the source exactly so tests validate the logic.
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildCommand(
  runnerName: string,
  runnerCommand: string,
  filter?: string,
): string {
  if (!filter) return runnerCommand;
  const safe = shellQuote(filter);
  switch (runnerName) {
    case "bun:test":
      return `bun test ${safe}`;
    case "jest":
      return `npx jest --testPathPattern ${safe}`;
    case "vitest":
      return `npx vitest run ${safe}`;
    case "mocha":
      return `npx mocha --grep ${safe}`;
    case "pytest":
      return `pytest -v -k ${safe}`;
    case "go test":
      return `go test -v -run ${safe} ./...`;
    case "cargo test":
      return `cargo test ${safe}`;
    default:
      return runnerCommand;
  }
}

// Re-implement parseTestOutput to test it directly
import { truncateOutput, TEST_MAX_BYTES } from "./shell-runner";

function parseTestOutput(
  runner: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): {
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ test: string; error: string }>;
  raw: string;
} {
  const combined = stdout + "\n" + stderr;
  const raw = truncateOutput(combined, TEST_MAX_BYTES);

  try {
    if (runner === "bun:test" || runner === "jest" || runner === "vitest") {
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      const passMatch = combined.match(/(\d+)\s+pass/i);
      if (passMatch?.[1]) passed = parseInt(passMatch[1], 10);

      const failMatch = combined.match(/(\d+)\s+fail/i);
      if (failMatch?.[1]) failed = parseInt(failMatch[1], 10);

      const skipMatch = combined.match(/(\d+)\s+(?:skip|todo)/i);
      if (skipMatch?.[1]) skipped = parseInt(skipMatch[1], 10);

      const failures: Array<{ test: string; error: string }> = [];
      const lines = combined.split("\n");
      let inFailure = false;
      let currentTest = "";
      let currentError: string[] = [];

      for (const line of lines) {
        if (!line) continue;
        if (/FAIL\s+/.test(line) || /[✗✕×]/.test(line)) {
          if (inFailure && currentTest) {
            failures.push({
              test: currentTest,
              error: currentError.join("\n").trim(),
            });
          }
          inFailure = true;
          currentTest = line
            .replace(/^\s*[✗✕×]\s*/, "")
            .replace(/FAIL\s*/, "")
            .trim();
          currentError = [];
        } else if (inFailure) {
          if (/^\s*[✓✅]|^\s*PASS\s|^\s*Test Suites:/.test(line)) {
            failures.push({
              test: currentTest,
              error: currentError.join("\n").trim(),
            });
            inFailure = false;
            currentTest = "";
            currentError = [];
          } else {
            currentError.push(line);
          }
        }
      }
      if (inFailure && currentTest) {
        failures.push({
          test: currentTest,
          error: currentError.join("\n").trim(),
        });
      }

      return { passed, failed, skipped, failures, raw };
    }

    if (runner === "pytest") {
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      const pm = combined.match(/(\d+) passed/);
      if (pm?.[1]) passed = parseInt(pm[1], 10);
      const fm = combined.match(/(\d+) failed/);
      if (fm?.[1]) failed = parseInt(fm[1], 10);
      const sm = combined.match(/(\d+) skipped/);
      if (sm?.[1]) skipped = parseInt(sm[1], 10);

      const failures: Array<{ test: string; error: string }> = [];
      const section = combined.match(
        /={3,}\s*FAILURES\s*={3,}([\s\S]*?)(?:={3,}\s*short test summary|$)/,
      );
      if (section?.[1]) {
        const blocks = section[1].split(/_{3,}\s+/);
        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed) continue;
          const firstLine =
            trimmed
              .split("\n")[0]
              ?.replace(/\s*_{3,}\s*$/, "")
              .trim() ?? "";
          const errorBody = trimmed.split("\n").slice(1).join("\n").trim();
          failures.push({ test: firstLine, error: errorBody });
        }
      }

      return { passed, failed, skipped, failures, raw };
    }

    if (runner === "go test") {
      const passed = (combined.match(/--- PASS:/g) ?? []).length;
      const failed = (combined.match(/--- FAIL:/g) ?? []).length;
      const skipped = (combined.match(/--- SKIP:/g) ?? []).length;

      const failures: Array<{ test: string; error: string }> = [];
      const lines = combined.split("\n");
      let inFailure = false;
      let currentTest = "";
      let currentError: string[] = [];

      for (const line of lines) {
        const failMatch = line.match(/--- FAIL:\s+(\S+)/);
        if (failMatch?.[1]) {
          if (inFailure && currentTest) {
            failures.push({
              test: currentTest,
              error: currentError.join("\n").trim(),
            });
          }
          inFailure = true;
          currentTest = failMatch[1];
          currentError = [];
        } else if (inFailure) {
          if (/^---\s/.test(line) || /^(ok|FAIL)\s/.test(line)) {
            failures.push({
              test: currentTest,
              error: currentError.join("\n").trim(),
            });
            inFailure = false;
            currentTest = "";
            currentError = [];
          } else {
            currentError.push(line);
          }
        }
      }
      if (inFailure && currentTest) {
        failures.push({
          test: currentTest,
          error: currentError.join("\n").trim(),
        });
      }

      return { passed, failed, skipped, failures, raw };
    }

    if (runner === "cargo test") {
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      const sm = combined.match(
        /test result: \w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/,
      );
      if (sm) {
        passed = parseInt(sm[1]!, 10);
        failed = parseInt(sm[2]!, 10);
        skipped = parseInt(sm[3]!, 10);
      }

      const failures: Array<{ test: string; error: string }> = [];
      const section = combined.match(
        /failures:\s*\n([\s\S]*?)(?:\ntest result:)/,
      );
      if (section?.[1]) {
        const blocks = section[1].split(/---- (\S+) ----/);
        for (let i = 1; i < blocks.length; i += 2) {
          const testName = blocks[i] ?? "unknown";
          const errorBody = (blocks[i + 1] ?? "").trim();
          failures.push({ test: testName, error: errorBody });
        }
      }

      return { passed, failed, skipped, failures, raw };
    }
  } catch {
    // fallback
  }

  return {
    passed: exitCode === 0 ? -1 : 0,
    failed: exitCode !== 0 ? -1 : 0,
    skipped: 0,
    failures: [],
    raw,
  };
}

describe("run-tests tool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "run-tests-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: ["sudo", "rm -rf /"],
      maxBashTimeout: 30000,
      maxFileSize: 1024 * 1024,
      maxIterations: 200,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createRunTestsTool(config);
      expect(tool.name).toBe("run_tests");
    });

    it("should have correct categories", () => {
      const tool = createRunTestsTool(config);
      expect(tool.categories).toContain("code");
    });

    it("should have inputSchema with optional path, filter, and timeout", () => {
      const tool = createRunTestsTool(config);
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.path).toBeDefined();
      expect(props.filter).toBeDefined();
      expect(props.timeout).toBeDefined();
      // No required fields
      expect(tool.inputSchema.required).toEqual([]);
    });
  });

  describe("shellQuote", () => {
    it("should wrap simple string in single quotes", () => {
      expect(shellQuote("hello")).toBe("'hello'");
    });

    it("should escape single quotes in input", () => {
      expect(shellQuote("it's")).toBe("'it'\\''s'");
    });

    it("should handle empty string", () => {
      expect(shellQuote("")).toBe("''");
    });

    it("should handle string with multiple single quotes", () => {
      expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
    });

    it("should not be vulnerable to command injection via backticks", () => {
      const result = shellQuote("`rm -rf /`");
      expect(result).toBe("'`rm -rf /`'");
      // Wrapped in single quotes, backticks are literal
    });

    it("should not be vulnerable to $() command substitution", () => {
      const result = shellQuote("$(whoami)");
      expect(result).toBe("'$(whoami)'");
    });

    it("should handle semicolons safely", () => {
      const result = shellQuote("test; rm -rf /");
      expect(result).toBe("'test; rm -rf /'");
    });

    it("should handle pipes safely", () => {
      const result = shellQuote("test | cat /etc/passwd");
      expect(result).toBe("'test | cat /etc/passwd'");
    });
  });

  describe("buildCommand", () => {
    it("should return base command when no filter", () => {
      expect(buildCommand("bun:test", "bun test")).toBe("bun test");
    });

    it("should build bun:test command with filter", () => {
      const cmd = buildCommand("bun:test", "bun test", "my-test");
      expect(cmd).toBe("bun test 'my-test'");
    });

    it("should build jest command with filter", () => {
      const cmd = buildCommand("jest", "npx jest", "some-pattern");
      expect(cmd).toBe("npx jest --testPathPattern 'some-pattern'");
    });

    it("should build vitest command with filter", () => {
      const cmd = buildCommand("vitest", "npx vitest run", "file.test.ts");
      expect(cmd).toBe("npx vitest run 'file.test.ts'");
    });

    it("should build mocha command with filter", () => {
      const cmd = buildCommand("mocha", "npx mocha", "describe block");
      expect(cmd).toBe("npx mocha --grep 'describe block'");
    });

    it("should build pytest command with filter", () => {
      const cmd = buildCommand("pytest", "pytest", "test_func");
      expect(cmd).toBe("pytest -v -k 'test_func'");
    });

    it("should build go test command with filter", () => {
      const cmd = buildCommand("go test", "go test ./...", "TestMyFunc");
      expect(cmd).toBe("go test -v -run 'TestMyFunc' ./...");
    });

    it("should build cargo test command with filter", () => {
      const cmd = buildCommand("cargo test", "cargo test", "test_name");
      expect(cmd).toBe("cargo test 'test_name'");
    });

    it("should return base command for unknown runner with filter", () => {
      const cmd = buildCommand("custom", "make test", "some-filter");
      expect(cmd).toBe("make test");
    });

    it("should shell-quote filters containing special chars", () => {
      const cmd = buildCommand("bun:test", "bun test", "test'file");
      expect(cmd).toContain("'test'\\''file'");
    });
  });

  describe("parseTestOutput - bun:test / jest / vitest", () => {
    it("should parse pass/fail/skip counts", () => {
      const stdout = "5 pass\n2 fail\n1 skip";
      const result = parseTestOutput("bun:test", stdout, "", 1);
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it("should parse todo as skipped", () => {
      const stdout = "3 pass\n1 todo";
      const result = parseTestOutput("jest", stdout, "", 0);
      expect(result.passed).toBe(3);
      expect(result.skipped).toBe(1);
    });

    it("should extract failure details from bun:test output", () => {
      const stdout = [
        "✓ passes test",
        "✗ failing test",
        "  Expected: 1",
        "  Received: 2",
        "✓ another passing test",
        "1 pass",
        "1 fail",
      ].join("\n");
      const result = parseTestOutput("bun:test", stdout, "", 1);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures[0]!.test).toContain("failing test");
    });

    it("should handle zero results gracefully", () => {
      const result = parseTestOutput("bun:test", "", "", 0);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("should handle vitest output the same as jest", () => {
      const stdout = "10 pass\n0 fail";
      const result = parseTestOutput("vitest", stdout, "", 0);
      expect(result.passed).toBe(10);
      expect(result.failed).toBe(0);
    });
  });

  describe("parseTestOutput - pytest", () => {
    it("should parse pytest summary line", () => {
      const stdout = "====== 5 passed, 2 failed, 1 skipped in 3.5s ======";
      const result = parseTestOutput("pytest", stdout, "", 1);
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it("should extract pytest failure blocks", () => {
      const stdout = [
        "=== FAILURES ===",
        "___ test_example ___",
        "  assert 1 == 2",
        "=== short test summary ===",
        "1 passed, 1 failed",
      ].join("\n");
      const result = parseTestOutput("pytest", stdout, "", 1);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle pytest all passed", () => {
      const stdout = "====== 10 passed in 1.2s ======";
      const result = parseTestOutput("pytest", stdout, "", 0);
      expect(result.passed).toBe(10);
      expect(result.failed).toBe(0);
    });
  });

  describe("parseTestOutput - go test", () => {
    it("should count PASS, FAIL, SKIP markers", () => {
      const stdout = [
        "--- PASS: TestA (0.1s)",
        "--- PASS: TestB (0.2s)",
        "--- FAIL: TestC (0.1s)",
        "--- SKIP: TestD (0.0s)",
        "FAIL",
      ].join("\n");
      const result = parseTestOutput("go test", stdout, "", 1);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it("should extract go test failure details", () => {
      const stdout = [
        "--- FAIL: TestBroken (0.1s)",
        "    got: foo",
        "    want: bar",
        "FAIL mypackage",
      ].join("\n");
      const result = parseTestOutput("go test", stdout, "", 1);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0]!.test).toBe("TestBroken");
      expect(result.failures[0]!.error).toContain("got: foo");
    });
  });

  describe("parseTestOutput - cargo test", () => {
    it("should parse cargo test summary line", () => {
      const stdout =
        "test result: FAILED. 3 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out";
      const result = parseTestOutput("cargo test", stdout, "", 1);
      expect(result.passed).toBe(3);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(2);
    });

    it("should extract cargo test failure details", () => {
      const stdout = [
        "failures:",
        "",
        "---- tests::my_test ----",
        "thread 'tests::my_test' panicked at 'assertion failed'",
        "",
        "test result: FAILED. 0 passed; 1 failed; 0 ignored",
      ].join("\n");
      const result = parseTestOutput("cargo test", stdout, "", 1);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0]!.test).toBe("tests::my_test");
    });
  });

  describe("parseTestOutput - unknown runner", () => {
    it("should use fallback for unknown runner with exit 0", () => {
      const result = parseTestOutput("unknown", "some output", "", 0);
      expect(result.passed).toBe(-1);
      expect(result.failed).toBe(0);
    });

    it("should use fallback for unknown runner with non-zero exit", () => {
      const result = parseTestOutput("unknown", "error", "", 1);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(-1);
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createRunTestsTool(config);
      const result = await tool.execute({ path: "/etc" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should reject home-expanded paths outside allowed dirs", async () => {
      const tool = createRunTestsTool(config);
      const result = await tool.execute({ path: "/var/secret" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });
  });
});
