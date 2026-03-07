export type ToolCategory =
  | "research"
  | "code"
  | "analytics"
  | "fileops"
  | "system"
  | "memory"
  | "ideas"
  | "social";

export interface ToolResult {
  readonly output: string;
  readonly isError: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly categories: readonly ToolCategory[];
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}