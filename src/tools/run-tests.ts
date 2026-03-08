import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import { expandHome, isPathAllowedSync, resolveAllowedDirs } from "./path-utils";
import { detectProjectContext } from "./project-context";
import { runShell, truncateOutput, TEST_MAX_BYTES } from "./shell-runner";
import { createLogger } from "../logger";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("tool:run-tests");

interface TestResults {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: ReadonlyArray<{ test: string; error: string }>;
  readonly raw: string;
}

function parseTestOutput(
  runner: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): TestResults {
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
            failures.push({ test: currentTest, error: currentError.join("\n").trim() });
          }
          inFailure = true;
          currentTest = line.replace(/^\s*[✗✕×]\s*/, "").replace(/FAIL\s*/, "").trim();
          currentError = [];
        } else if (inFailure) {
          if (/^\s*[✓✅]|^\s*PASS\s|^\s*Test Suites:/.test(line)) {
            failures.push({ test: currentTest, error: currentError.join("\n").trim() });
            inFailure = false;
            currentTest = "";
            currentError = [];
          } else {
            currentError.push(line);
          }
        }
      }
      if (inFailure && currentTest) {
        failures.push({ test: currentTest, error: currentError.join("\n").trim() });
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
      const section = combined.match(/={3,}\s*FAILURES\s*={3,}([\s\S]*?)(?:={3,}\s*short test summary|$)/);
      if (section?.[1]) {
        const blocks = section[1].split(/_{3,}\s+/);
        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed) continue;
          const firstLine = trimmed.split("\n")[0]?.replace(/\s*_{3,}\s*$/, "").trim() ?? "";
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
            failures.push({ test: currentTest, error: currentError.join("\n").trim() });
          }
          inFailure = true;
          currentTest = failMatch[1];
          currentError = [];
        } else if (inFailure) {
          if (/^---\s/.test(line) || /^(ok|FAIL)\s/.test(line)) {
            failures.push({ test: currentTest, error: currentError.join("\n").trim() });
            inFailure = false;
            currentTest = "";
            currentError = [];
          } else {
            currentError.push(line);
          }
        }
      }
      if (inFailure && currentTest) {
        failures.push({ test: currentTest, error: currentError.join("\n").trim() });
      }

      return { passed, failed, skipped, failures, raw };
    }

    if (runner === "cargo test") {
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      const sm = combined.match(/test result: \w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/);
      if (sm) {
        passed = parseInt(sm[1]!, 10);
        failed = parseInt(sm[2]!, 10);
        skipped = parseInt(sm[3]!, 10);
      }

      const failures: Array<{ test: string; error: string }> = [];
      const section = combined.match(/failures:\s*\n([\s\S]*?)(?:\ntest result:)/);
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
  } catch (err) {
    log.warn("Test output parsing failed, using fallback", { runner, error: err });
  }

  // Fallback
  return {
    passed: exitCode === 0 ? -1 : 0,
    failed: exitCode !== 0 ? -1 : 0,
    skipped: 0,
    failures: [],
    raw,
  };
}

/** Shell-quote a string to prevent command injection */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildCommand(runnerName: string, runnerCommand: string, filter?: string): string {
  if (!filter) return runnerCommand;

  // Sanitize filter to prevent command injection
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
      return runnerCommand; // custom runners don't support filter
  }
}

function formatSummaryCount(count: number, label: string): string {
  if (count === -1) return `? ${label}`;
  return `${count} ${label}`;
}

function formatResults(
  path: string,
  runner: string,
  command: string,
  durationMs: number,
  results: TestResults,
  timedOut: boolean,
  timeoutMs: number,
): string {
  const durationSec = (durationMs / 1000).toFixed(1);
  const lines: string[] = [];

  lines.push(`Test results: ${path}`);
  lines.push(`  Runner: ${runner} | Command: ${command} | Duration: ${durationSec}s`);

  if (timedOut) {
    lines.push("");
    lines.push(`  TIMEOUT — tests did not complete within ${Math.round(timeoutMs / 1000)}s.`);
    if (results.raw.trim()) {
      lines.push("  Partial output:");
      lines.push("  " + results.raw.split("\n").join("\n  "));
    }
    return lines.join("\n");
  }

  lines.push("");
  lines.push(
    `  Summary: ${formatSummaryCount(results.passed, "passed")}, ${formatSummaryCount(results.failed, "failed")}, ${formatSummaryCount(results.skipped, "skipped")}`,
  );

  if (results.failures.length > 0) {
    lines.push("");
    lines.push("  Failures:");
    for (let i = 0; i < results.failures.length; i++) {
      const f = results.failures[i]!;
      lines.push(`    ${i + 1}. ${f.test}`);
      if (f.error) {
        for (const el of f.error.split("\n").slice(0, 5)) {
          lines.push(`       ${el}`);
        }
      }
    }
  } else if (results.failed === 0) {
    lines.push("");
    lines.push("  All tests passed.");
  }

  return lines.join("\n");
}

export function createRunTestsTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);

  return {
    name: "run_tests",
    description:
      "Run the project's test suite and return structured results. Auto-detects the test runner (bun, jest, vitest, pytest, go test, cargo test, etc.). Supports filtering by file path or test name. Returns pass/fail counts and failure details.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the project root. Defaults to current working directory.",
        },
        filter: {
          type: "string",
          description: "Filter tests by file path or test name pattern. Passed to the test runner's native filter mechanism.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds. Default: 120000 (2 minutes).",
        },
      },
      required: [],
    },

    categories: ["code"] as readonly ToolCategory[],
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = (args.path as string) || process.cwd();
      const filter = args.filter as string | undefined;
      const timeout = typeof args.timeout === "number" ? args.timeout : 120_000;

      const path = expandHome(rawPath);
      if (!isPathAllowedSync(path, allowedDirs)) {
        return { output: `Error: path not allowed: ${path}`, isError: true };
      }

      let context;
      try {
        context = await detectProjectContext(path);
      } catch (err) {
        const msg = getErrorMessage(err);
        return { output: `Error detecting project: ${msg}`, isError: true };
      }

      if (!context.testRunner) {
        const langs = context.languages.length > 0 ? context.languages.join(", ") : "none";
        return {
          output: `No test runner detected. Languages found: [${langs}]. Consider adding test configuration (e.g., a test script in package.json, pytest.ini, or a Makefile with a test target).`,
          isError: false,
        };
      }

      const { name: runnerName, command: runnerCommand } = context.testRunner;
      const command = buildCommand(runnerName, runnerCommand, filter);

      log.info("Running tests", { runner: runnerName, command });

      const result = await runShell(command, { cwd: path, timeoutMs: timeout });
      const { stdout, stderr, exitCode, timedOut, durationMs } = result;

      // Check for command not found
      if (stderr.includes("command not found") || stderr.includes("not recognized")) {
        return {
          output: `Error: test runner "${runnerName}" not found. Ensure it is installed.\n\nstderr: ${truncateOutput(stderr, TEST_MAX_BYTES)}`,
          isError: true,
        };
      }

      const results = parseTestOutput(runnerName, stdout, stderr, exitCode);
      const output = formatResults(path, runnerName, command, durationMs, results, timedOut, timeout);

      log.info("Tests completed", {
        runner: runnerName,
        passed: results.passed,
        failed: results.failed,
        exitCode,
        durationMs,
      });

      return { output, isError: timedOut || exitCode !== 0 };
    },
  };
}
