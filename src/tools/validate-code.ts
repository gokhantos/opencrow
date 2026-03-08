import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import { expandHome, isPathAllowedSync, resolveAllowedDirs } from "./path-utils";
import { detectProjectContext } from "./project-context";
import type { ProjectContext } from "./project-context";
import { runShell, truncateOutput, VALIDATE_MAX_BYTES } from "./shell-runner";
import { createLogger } from "../logger";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("tool:validate-code");

type StepName = "typecheck" | "lint" | "test";

interface StepResult {
  readonly step: StepName;
  readonly tool: string;
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly errorCount: number;
  readonly durationMs: number;
  readonly output: string;
  readonly timedOut: boolean;
  readonly execError?: string;
}

function countErrors(
  step: StepName,
  tool: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): number {
  const combined = stdout + "\n" + stderr;

  try {
    if (step === "typecheck") {
      if (tool.includes("tsc")) {
        return (combined.match(/error TS\d+/g) ?? []).length || (exitCode !== 0 ? 1 : 0);
      }
      if (tool.includes("mypy")) {
        return (combined.match(/: error:/g) ?? []).length || (exitCode !== 0 ? 1 : 0);
      }
      if (tool.includes("cargo")) {
        return (combined.match(/^error\[/gm) ?? []).length || (exitCode !== 0 ? 1 : 0);
      }
      if (tool.includes("go")) {
        return (combined.match(/^\.\//gm) ?? []).length || (exitCode !== 0 ? 1 : 0);
      }
    }

    if (step === "lint") {
      if (tool.includes("eslint") || tool.includes("biome")) {
        const m = combined.match(/(\d+) error/);
        if (m) return parseInt(m[1]!, 10);
        return combined.split("\n").filter((l) => /\berror\b/i.test(l)).length || (exitCode !== 0 ? 1 : 0);
      }
      if (tool.includes("ruff")) {
        return exitCode !== 0
          ? Math.max(combined.split("\n").filter((l) => l.trim()).length, 1)
          : 0;
      }
      if (tool.includes("clippy") || tool.includes("cargo")) {
        return (combined.match(/^error\[/gm) ?? []).length || (exitCode !== 0 ? 1 : 0);
      }
      if (tool.includes("golangci")) {
        return (combined.match(/^\.\//gm) ?? []).length || (exitCode !== 0 ? 1 : 0);
      }
    }
  } catch {
    log.debug("Error parsing output for step", { step, tool });
  }

  return exitCode !== 0 ? 1 : 0;
}

function applyFixMode(step: StepName, command: string): string {
  if (step !== "lint") return command;
  if (command.includes("eslint")) return command.replace(/(\beslint\b.*)$/, "$1 --fix");
  if (command.includes("ruff")) return command.replace("ruff check", "ruff check --fix");
  if (command.includes("biome")) return command.replace(/(\bbiome\b.*)$/, "$1 --write");
  return command;
}

function formatDuration(ms: number): string {
  return (ms / 1000).toFixed(1) + "s";
}

function formatStepOutput(result: StepResult, index: number): string {
  const prefix = `${index}. ${result.step} (${result.command})`;

  if (result.timedOut) {
    return `${prefix}: TIMEOUT (${formatDuration(result.durationMs)})`;
  }
  if (result.execError) {
    return `${prefix}: ERROR — ${result.execError} (${formatDuration(result.durationMs)})`;
  }
  if (result.passed) {
    return `${prefix}: PASS (${formatDuration(result.durationMs)})`;
  }

  let line = `${prefix}: FAIL`;
  if (result.errorCount > 0) {
    line += ` — ${result.errorCount} error${result.errorCount === 1 ? "" : "s"}`;
  }
  line += ` (${formatDuration(result.durationMs)})`;

  if (result.output.trim()) {
    const outputLines = result.output.trim().split("\n");
    const maxLines = 10;
    const shown = outputLines.slice(0, maxLines);
    line += "\n" + shown.map((l) => "   " + l).join("\n");
    if (outputLines.length > maxLines) {
      line += `\n   ... (${outputLines.length - maxLines} more)`;
    }
  }

  return line;
}

export function createValidateCodeTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);

  return {
    name: "validate_code",
    description:
      "Run type checking, linting, and tests in one call. Auto-detects the project's stack and runs each available validation step in sequence. Returns structured pass/fail results per step. Use after making code changes to verify nothing is broken.",
    categories: ["code"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the project root. Defaults to current working directory.",
        },
        steps: {
          type: "array",
          items: { type: "string", enum: ["typecheck", "lint", "test"] },
          description:
            "Which validation steps to run. Defaults to all available: ['typecheck', 'lint', 'test'].",
        },
        timeout: {
          type: "number",
          description: "Timeout per step in milliseconds. Default: 60000 (60s).",
        },
        fix: {
          type: "boolean",
          description:
            "If true, run linter in fix mode where supported (e.g. eslint --fix). Default: false.",
        },
      },
      required: [],
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = (args.path as string) || process.cwd();
      const resolvedPath = expandHome(rawPath);

      if (!isPathAllowedSync(resolvedPath, allowedDirs)) {
        return { output: `Error: path not allowed: ${resolvedPath}`, isError: true };
      }

      let ctx: ProjectContext;
      try {
        ctx = await detectProjectContext(resolvedPath);
      } catch (err) {
        const msg = getErrorMessage(err);
        return { output: `Error detecting project: ${msg}`, isError: true };
      }

      const requestedSteps: StepName[] =
        Array.isArray(args.steps) && args.steps.length > 0
          ? (args.steps as StepName[])
          : ["typecheck", "lint", "test"];

      const timeout = typeof args.timeout === "number" ? args.timeout : 60_000;
      const fix = args.fix === true;

      // Map steps to their detected commands
      const stepToolMap: Record<StepName, { name: string; command: string } | null> = {
        typecheck: ctx.typeChecker,
        lint: ctx.linter,
        test: ctx.testRunner,
      };

      const availableSteps: { step: StepName; name: string; command: string }[] = [];
      const missingSteps: StepName[] = [];

      for (const step of requestedSteps) {
        const tool = stepToolMap[step];
        if (tool) {
          availableSteps.push({ step, name: tool.name, command: tool.command });
        } else {
          missingSteps.push(step);
        }
      }

      // Context description for header
      const ctxParts: string[] = [...ctx.languages];
      if (ctx.packageManager) ctxParts.push(ctx.packageManager);
      if (ctx.framework) ctxParts.push(ctx.framework);
      const ctxDesc = ctxParts.length > 0 ? ` (${ctxParts.join(", ")})` : "";

      if (availableSteps.length === 0) {
        let output = `Validation: ${resolvedPath}${ctxDesc}\n\n`;
        output += `No validation tools detected for steps: ${requestedSteps.join(", ")}.\n`;
        if (ctx.languages.length > 0) {
          output += `Detected languages: ${ctx.languages.join(", ")}.\n`;
        }
        output += "\nOverall: PASS (no checks to run)";
        return { output, isError: false };
      }

      // Run each step
      const results: StepResult[] = [];

      for (const { step, name, command: rawCommand } of availableSteps) {
        const command = fix ? applyFixMode(step, rawCommand) : rawCommand;

        let exitCode = 0;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let execError: string | undefined;
        let durationMs = 0;

        try {
          const result = await runShell(command, { cwd: resolvedPath, timeoutMs: timeout });
          exitCode = result.exitCode;
          stdout = result.stdout;
          stderr = result.stderr;
          timedOut = result.timedOut;
          durationMs = result.durationMs;
        } catch (err) {
          const msg = getErrorMessage(err);
          execError = msg;
          exitCode = 1;
        }

        const combined = (stdout + "\n" + stderr).trim();
        const truncated = truncateOutput(combined, VALIDATE_MAX_BYTES);
        const errorCount = timedOut || execError ? 0 : countErrors(step, name, stdout, stderr, exitCode);
        const passed = !timedOut && !execError && exitCode === 0;

        results.push({
          step,
          tool: name,
          command,
          passed,
          exitCode,
          errorCount,
          durationMs,
          output: truncated,
          timedOut,
          execError,
        });
      }

      const overallPassed = results.every((r) => r.passed);

      let output = `Validation: ${resolvedPath}${ctxDesc}\n\n`;
      if (missingSteps.length > 0) {
        output += `No tools detected for: ${missingSteps.join(", ")}.\n`;
      }

      for (let i = 0; i < results.length; i++) {
        output += formatStepOutput(results[i]!, i + 1) + "\n";
      }

      if (overallPassed) {
        output += "\nOverall: PASS";
      } else {
        const failNames = results
          .filter((r) => !r.passed)
          .map((r) => r.step + (r.timedOut ? " timed out" : " failed"))
          .join(", ");
        output += `\nOverall: FAIL (${failNames})`;
      }

      return { output, isError: !overallPassed };
    },
  };
}
