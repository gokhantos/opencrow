import { resolve } from "path";
import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import { resolveAllowedDirs, expandHome, isPathAllowed } from "./path-utils";
import { isProtectedFile, protectedFileReason } from "./protected-paths";
import { createLogger } from "../logger";

const log = createLogger("tool:read-file");

export function createReadFileTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);

  return {
    name: "read_file",
    description: "Read file contents. Use startLine/endLine for large files.",
    categories: ["fileops", "code"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path",
        },
        startLine: {
          type: "number",
          description: "Start line (1-indexed)",
        },
        endLine: {
          type: "number",
          description: "End line (inclusive)",
        },
      },
      required: ["path"],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = String(input.path ?? "");
      const filePath = resolve(expandHome(rawPath));

      // Deny credential/secret material regardless of containing directory,
      // before any fs op. This is IN ADDITION to allowedDirectories containment.
      if (isProtectedFile(filePath)) {
        return { output: protectedFileReason(filePath), isError: true };
      }

      if (!(await isPathAllowed(filePath, allowedDirs))) {
        return {
          output: `Error: path not allowed: ${filePath}`,
          isError: true,
        };
      }

      log.debug("Reading file", { filePath });

      try {
        const file = Bun.file(filePath);
        const exists = await file.exists();

        if (!exists) {
          return {
            output: `Error: file not found: ${filePath}`,
            isError: true,
          };
        }

        const size = file.size;
        if (size > config.maxFileSize) {
          const truncated = await file.slice(0, config.maxFileSize).text();
          return {
            output: `${truncated}\n\n[Truncated: file is ${size} bytes, showing first ${config.maxFileSize} bytes]`,
            isError: false,
          };
        }

        const content = await file.text();

        const rawStart =
          input.startLine != null ? Number(input.startLine) : undefined;
        if (rawStart !== undefined) {
          if (!Number.isInteger(rawStart) || rawStart < 1) {
            return {
              output: "Error: startLine must be a positive integer",
              isError: true,
            };
          }
          const rawEnd =
            input.endLine != null ? Number(input.endLine) : undefined;
          if (
            rawEnd !== undefined &&
            (!Number.isInteger(rawEnd) || rawEnd < rawStart)
          ) {
            return {
              output: "Error: endLine must be an integer >= startLine",
              isError: true,
            };
          }
          const lines = content.split("\n");
          const start = Math.max(0, rawStart - 1);
          const end =
            rawEnd != null ? Math.min(lines.length, rawEnd) : lines.length;
          const slice = lines.slice(start, end);
          return {
            output: `[Lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]\n${slice.join("\n")}`,
            isError: false,
          };
        }

        return { output: content, isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Read file error", error);
        return { output: `Error reading file: ${message}`, isError: true };
      }
    },
  };
}
