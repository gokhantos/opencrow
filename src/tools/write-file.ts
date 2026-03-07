import { resolve, dirname, basename, join } from "path";
import { mkdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import { resolveAllowedDirs, expandHome, isPathAllowed } from "./path-utils";
import { createLogger } from "../logger";

const log = createLogger("tool:write-file");

const PROTECTED_FILES = ["guardian.sh", ".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", "authorized_keys"];

export function createWriteFileTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);

  return {
    name: "write_file",
    description:
      "Write content to a file at the given path. Creates the file if it does not exist, overwrites if it does. Creates parent directories as needed.",
    categories: ["fileops", "code"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = String(input.path ?? "");
      const filePath = resolve(expandHome(rawPath));
      const content = String(input.content ?? "");

      if (PROTECTED_FILES.includes(basename(filePath))) {
        return {
          output: `Error: ${basename(filePath)} is a protected system file and cannot be modified`,
          isError: true,
        };
      }

      if (!(await isPathAllowed(filePath, allowedDirs))) {
        return {
          output: `Error: path not allowed: ${filePath}`,
          isError: true,
        };
      }

      log.debug("Writing file", { filePath, bytes: content.length });

      try {
        const dir = dirname(filePath);
        await mkdir(dir, { recursive: true });

        const tmpPath = join(
          dir,
          `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
        );
        try {
          const bytesWritten = await Bun.write(tmpPath, content);
          await rename(tmpPath, filePath);
          return {
            output: `Successfully wrote ${bytesWritten} bytes to ${filePath}`,
            isError: false,
          };
        } catch (writeErr) {
          await unlink(tmpPath).catch(() => {});
          throw writeErr;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Write file error", error);
        return { output: `Error writing file: ${message}`, isError: true };
      }
    },
  };
}
