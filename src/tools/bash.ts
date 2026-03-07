import { resolve } from "path";
import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import {
  resolveAllowedDirs,
  expandHome,
  isPathAllowedSync,
} from "./path-utils";
import { BASH_MAX_BYTES, BASH_HEAD_BYTES, BASH_TAIL_BYTES } from "./shell-runner";
import { createLogger } from "../logger";

const log = createLogger("tool:bash");

const SAFE_ENV_KEYS = [
  "HOME",
  "USER",
  "PATH",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
];

function getSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val) {
      env[key] = val;
    }
  }
  return env;
}

function isCommandBlocked(
  command: string,
  blockedCommands: readonly string[],
): boolean {
  const trimmed = command.trim().toLowerCase();

  // Split on shell metacharacters (including newlines) to check each segment
  const segments = trimmed
    .split(/[;&|`$()\n\r]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.some((segment) =>
    blockedCommands.some((blocked) => {
      const lower = blocked.toLowerCase();
      // Get basename to catch absolute paths like /usr/bin/sudo
      const firstToken = segment.split(/\s+/)[0] ?? "";
      const basename = firstToken.split("/").pop() ?? firstToken;
      return (
        basename === lower ||
        segment === lower ||
        segment.startsWith(lower + " ")
      );
    }),
  );
}

function truncateBashOutput(text: string, label: string): string {
  if (text.length <= BASH_MAX_BYTES) return text;
  const omitted = text.length - BASH_HEAD_BYTES - BASH_TAIL_BYTES;
  const head = text.slice(0, BASH_HEAD_BYTES);
  const tail = text.slice(-BASH_TAIL_BYTES);
  return `${head}\n\n[... ${omitted} bytes omitted from ${label} ...]\n\n${tail}`;
}

export function createBashTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);

  return {
    name: "bash",
    description:
      "Execute a shell command and return the output. Use for running scripts, installing packages, checking system state, etc.",
    categories: ["code", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        workingDirectory: {
          type: "string",
          description: "Working directory for the command (default: $HOME)",
        },
      },
      required: ["command"],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const command = String(input.command ?? "");
      const home = process.env.HOME ?? "";
      const workDir = input.workingDirectory
        ? resolve(expandHome(String(input.workingDirectory)))
        : home;

      if (!command.trim()) {
        return { output: "Error: empty command", isError: true };
      }

      if (isCommandBlocked(command, config.blockedCommands)) {
        return {
          output: `Error: command blocked for safety: ${command}`,
          isError: true,
        };
      }

      {
        const normalized = command.replace(/["'\\`]/g, "");
        const GUARDIAN_PATTERNS = [/guardian\.sh/, /guardian-web\.sh/];
        const DESTRUCTIVE_OPS =
          /\b(rm|mv|cp|chmod|chown|sed|awk|tee|truncate|dd|install)\b|>/;
        if (
          GUARDIAN_PATTERNS.some((p) => p.test(normalized)) &&
          DESTRUCTIVE_OPS.test(normalized)
        ) {
          return {
            output:
              "Error: guardian scripts are protected system files and cannot be modified via bash",
            isError: true,
          };
        }
      }

      if (!isPathAllowedSync(workDir, allowedDirs)) {
        return {
          output: `Error: working directory not allowed: ${workDir}`,
          isError: true,
        };
      }

      log.debug("Executing bash command", { command: command.slice(0, 200) });

      try {
        const proc = Bun.spawn(["bash", "-c", command], {
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
          env: getSafeEnv(),
        });

        const timeout = config.maxBashTimeout;

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
          }>((res) =>
            setTimeout(() => {
              proc.kill(9); // SIGKILL
              res({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
            }, timeout),
          ),
        ]);

        if (result.timedOut) {
          return {
            output: `Error: command timed out after ${timeout}ms`,
            isError: true,
          };
        }

        const output = [
          result.stdout.trim()
            ? truncateBashOutput(result.stdout.trim(), "stdout")
            : null,
          result.stderr.trim()
            ? `stderr: ${truncateBashOutput(result.stderr.trim(), "stderr")}`
            : null,
          `exit code: ${result.exitCode}`,
        ]
          .filter(Boolean)
          .join("\n");

        log.debug("Bash command completed", { exitCode: result.exitCode });

        return { output, isError: result.exitCode !== 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Bash execution error", error);
        return { output: `Error executing command: ${message}`, isError: true };
      }
    },
  };
}
