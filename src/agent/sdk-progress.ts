/**
 * Progress/display formatting utilities for the Agent SDK.
 * Pure functions with no external dependencies on agent state.
 */

export const MAX_DETAIL_LENGTH = 60;
export const MAX_THINKING_SUMMARY = 100;

export function truncate(str: string, max: number = MAX_DETAIL_LENGTH): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function summarizeThinking(text: string): string {
  const firstSentence = text.match(/^[^.!?\n]+[.!?]?/)?.[0] ?? text;
  return truncate(firstSentence.trim(), MAX_THINKING_SUMMARY);
}

export function shortenPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  const short = parts.length > 3 ? parts.slice(-3).join("/") : parts.join("/");
  return truncate(short);
}

export function formatToolProgress(
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name) {
    case "Read":
      return input.file_path
        ? `Reading ${shortenPath(String(input.file_path))}`
        : "Reading file";
    case "Write":
      return input.file_path
        ? `Writing ${shortenPath(String(input.file_path))}`
        : "Writing file";
    case "Edit":
      return input.file_path
        ? `Editing ${shortenPath(String(input.file_path))}`
        : "Editing file";
    case "Bash":
      if (input.description) return truncate(String(input.description));
      if (input.command) return `Running: ${truncate(String(input.command))}`;
      return "Running command";
    case "Grep":
      return input.pattern
        ? `Searching "${truncate(String(input.pattern), 40)}"`
        : "Searching";
    case "Glob":
      return input.pattern
        ? `Finding ${truncate(String(input.pattern), 40)}`
        : "Finding files";
    case "WebSearch":
      return input.query
        ? `Web: ${truncate(String(input.query), 45)}`
        : "Web search";
    case "WebFetch":
      return input.url
        ? `Fetching ${truncate(String(input.url), 45)}`
        : "Fetching URL";
    case "Task":
      if (input.description)
        return `Agent: ${truncate(String(input.description), 45)}`;
      if (input.prompt) return `Agent: ${truncate(String(input.prompt), 45)}`;
      return "Running agent";
    default: {
      const clean = name.replace(/^mcp__[^_]+__/, "");
      return clean;
    }
  }
}
