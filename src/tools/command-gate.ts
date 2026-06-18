/**
 * Shared shell-command safety gate.
 *
 * Both the agent `bash` tool and the dev-tool exec path (run_tests,
 * validate_code) screen commands through THIS module so a dev tool cannot be
 * used to bypass the bash gate. It combines:
 *   1. the config blocklist (basename/prefix match per shell segment), and
 *   2. the regex-based dangerous-command check (src/agent/hooks.ts).
 *
 * IMPORTANT: this gate is defense-in-depth, NOT the security boundary. String
 * matching on shell is fundamentally bypassable. The real boundary is the OS
 * sandbox (see ./sandbox.ts). Keep that framing when extending these checks.
 */
import { isDangerousCommand } from "../agent/hooks";

/**
 * True if any shell segment's leading token (basename-aware) matches a blocked
 * command literal, or the segment equals/starts-with a blocked literal.
 *
 * Mirrors the historical isCommandBlocked in bash.ts so behavior is unchanged;
 * now shared so dev tools enforce the same list.
 */
export function isCommandBlocked(
  command: string,
  blockedCommands: readonly string[],
): boolean {
  const trimmed = command.trim().toLowerCase();

  const segments = trimmed
    .split(/[;&|`$()\n\r]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.some((segment) =>
    blockedCommands.some((blocked) => {
      const lower = blocked.toLowerCase();
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

export interface GateOptions {
  readonly blockedCommands: readonly string[];
  /** When false, skip the regex dangerous-command check. Default: enabled. */
  readonly dangerousCommandBlocking?: boolean;
}

export interface GateResult {
  readonly blocked: boolean;
  /** Human-readable reason when blocked. */
  readonly reason?: string;
}

/**
 * Screen a shell command. Returns `{ blocked: true, reason }` if either the
 * blocklist or the dangerous-command check rejects it.
 */
export function screenCommand(
  command: string,
  opts: GateOptions,
): GateResult {
  if (isCommandBlocked(command, opts.blockedCommands)) {
    return { blocked: true, reason: `Error: command blocked for safety: ${command}` };
  }
  if (opts.dangerousCommandBlocking !== false && isDangerousCommand(command)) {
    return { blocked: true, reason: `Error: command blocked for safety: ${command}` };
  }
  return { blocked: false };
}
