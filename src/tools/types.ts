export type ToolCategory =
  | "research"
  | "code"
  | "analytics"
  | "fileops"
  | "system"
  | "memory"
  | "social";

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "EXTERNAL_SERVICE"
  | "INTERNAL";

export interface ToolResult {
  readonly output: string;
  readonly isError: boolean;
  readonly errorCode?: ToolErrorCode;
  readonly retriable?: boolean;
  readonly retryAfterMs?: number;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly categories: readonly ToolCategory[];
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}