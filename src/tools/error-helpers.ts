import type { ToolResult, ToolErrorCode } from "./types";

interface ErrorOpts {
  readonly retriable?: boolean;
  readonly retryAfterMs?: number;
}

export function toolError(
  output: string,
  code: ToolErrorCode,
  opts?: ErrorOpts,
): ToolResult {
  return {
    output,
    isError: true,
    errorCode: code,
    ...(opts?.retriable !== undefined && { retriable: opts.retriable }),
    ...(opts?.retryAfterMs !== undefined && {
      retryAfterMs: opts.retryAfterMs,
    }),
  };
}

export function inputError(msg: string): ToolResult {
  return toolError(msg, "INVALID_INPUT", { retriable: false });
}

export function notFoundError(msg: string): ToolResult {
  return toolError(msg, "NOT_FOUND", { retriable: false });
}

export function rateLimitError(msg: string, retryAfterMs?: number): ToolResult {
  return toolError(msg, "RATE_LIMITED", { retriable: true, retryAfterMs });
}

export function serviceError(msg: string, retriable = true): ToolResult {
  return toolError(msg, "EXTERNAL_SERVICE", { retriable });
}

export function timeoutError(msg: string): ToolResult {
  return toolError(msg, "TIMEOUT", { retriable: true });
}

export function permissionError(msg: string): ToolResult {
  return toolError(msg, "PERMISSION_DENIED", { retriable: false });
}
