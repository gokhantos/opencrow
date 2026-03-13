import type { ToolDefinition, ToolResult } from "./types";
import type { ToolsConfig } from "../config/schema";
import type { ToolFilter } from "../agents/types";
import { createBashTool } from "./bash";
import { createReadFileTool } from "./read-file";
import { createWriteFileTool } from "./write-file";
import { createEditFileTool } from "./edit-file";
import { createListFilesTool } from "./list-files";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createSelfRestartTool } from "./self-restart";
import { createCronTriggerTool } from "./cron-trigger";

import { createLogger } from "../logger";

const log = createLogger("tool:registry");

export interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  getAnthropicTools(): readonly AnthropicTool[];
  getOpenAITools(): readonly OpenAITool[];
  executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult>;
  withFilter(filter: ToolFilter): ToolRegistry;
  withTools(extraTools: readonly ToolDefinition[]): ToolRegistry;
}

interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export function createToolRegistry(config: ToolsConfig): ToolRegistry {
  const tools: readonly ToolDefinition[] = [
    createBashTool(config),
    createReadFileTool(config),
    createWriteFileTool(config),
    createEditFileTool(config),
    createListFilesTool(config),
    createGrepTool(config),
    createGlobTool(config),
    createSelfRestartTool(),
    createCronTriggerTool(),
  ];

  return buildRegistry(tools);
}

function buildRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  // Deduplicate tools by name (last occurrence wins)
  const seen = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    seen.set(tool.name, tool);
  }
  const dedupedTools = Array.from(seen.values());
  const toolMap = seen;

  return {
    definitions: dedupedTools,

    getAnthropicTools(): readonly AnthropicTool[] {
      return dedupedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    },

    getOpenAITools(): readonly OpenAITool[] {
      return dedupedTools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },

    async executeTool(
      name: string,
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      const tool = toolMap.get(name);
      if (!tool) {
        const available = dedupedTools.map((t) => t.name).join(", ");
        log.error("Unknown tool requested", { name, available });
        return {
          output: `Error: "${name}" is not a valid tool. Available tools: ${available}. Only use tools from this list.`,
          isError: true,
        };
      }

      log.debug("Executing tool", { name, input });
      const result = await tool.execute(input);
      log.debug("Tool result", { name, isError: result.isError });

      // Prepend structured error prefix so the AI model can see the code
      if (result.isError && result.errorCode) {
        const parts: string[] = [result.errorCode];
        if (result.retriable) parts.push("retriable");
        const prefix = `[${parts.join(", ")}] `;
        return { ...result, output: `${prefix}${result.output}` };
      }

      return result;
    },

    withFilter(filter: ToolFilter): ToolRegistry {
      if (filter.mode === "all") return this;

      const filtered =
        filter.mode === "allowlist"
          ? dedupedTools.filter((t) => filter.tools.includes(t.name))
          : dedupedTools.filter((t) => !filter.tools.includes(t.name));

      return buildRegistry(filtered);
    },

    withTools(extraTools: readonly ToolDefinition[]): ToolRegistry {
      return buildRegistry([...dedupedTools, ...extraTools]);
    },
  };
}
