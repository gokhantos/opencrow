import { z } from "zod";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";
import { createLogger } from "../logger";

import {
  computeToolResultBudget,
  truncateToolResult,
} from "./tool-result-budget";

import { getErrorMessage } from "../lib/error-serialization";
const log = createLogger("mcp-bridge");

/**
 * Default context window assumed for sizing the per-result truncation budget.
 * Matches the value used by the OpenRouter/stream paths (openrouter.ts /
 * stream.ts) so all providers cap oversized tool output consistently.
 */
const DEFAULT_CONTEXT_WINDOW = 180_000;

/**
 * Max chars any single MCP tool result may contribute before truncation. The
 * Agent SDK path does not run the message-array guards (sliding-window /
 * context-pruning) the OpenRouter path does, so without this an oversized tool
 * output (a large file read, a verbose API response) lands in the model's
 * context untruncated and can blow the window. Computed once at module load.
 */
const MCP_TOOL_RESULT_BUDGET = computeToolResultBudget(DEFAULT_CONTEXT_WINDOW)
  .maxSingleResultChars;

/**
 * Tools the Agent SDK already provides natively — skip these in the MCP bridge.
 */
const SDK_NATIVE_TOOLS = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "grep",
  "glob",
]);

/**
 * Apply a JSON Schema string `format` to a Zod string schema, using Zod's
 * built-in format validators where one exists. Unknown formats are passed
 * through unchanged (JSON Schema treats unrecognized formats as annotations).
 */
function applyStringFormat(s: z.ZodString, format: string): z.ZodString {
  switch (format) {
    case "email":
      return s.email();
    case "uri":
    case "url":
      return s.url();
    case "uuid":
      return s.uuid();
    case "date-time":
      return s.datetime();
    default:
      return s;
  }
}

/**
 * Convert a JSON Schema property definition to a Zod type.
 * Handles the common types used by OpenCrow's tool schemas.
 *
 * Exported for unit testing only — not part of the public API.
 */
export function jsonSchemaPropertyToZod(
  prop: Record<string, unknown>,
): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  let schema: z.ZodTypeAny;

  switch (type) {
    case "string": {
      if (prop.enum) {
        const values = prop.enum as [string, ...string[]];
        schema = z.enum(values);
      } else {
        let s = z.string();
        // Carry string constraints through to validation. The MCP bridge
        // validates tool inputs against this schema before execute() runs, so
        // dropping these would let malformed inputs reach the tool.
        if (typeof prop.minLength === "number") s = s.min(prop.minLength);
        if (typeof prop.maxLength === "number") s = s.max(prop.maxLength);
        if (typeof prop.pattern === "string") s = s.regex(new RegExp(prop.pattern));
        if (typeof prop.format === "string") s = applyStringFormat(s, prop.format);
        schema = s;
      }
      break;
    }
    case "number":
    case "integer": {
      let n = z.number();
      if (type === "integer") n = n.int();
      if (typeof prop.minimum === "number") n = n.min(prop.minimum);
      if (typeof prop.maximum === "number") n = n.max(prop.maximum);
      schema = n;
      break;
    }
    case "boolean":
      schema = z.boolean();
      break;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      let arr = items
        ? z.array(jsonSchemaPropertyToZod(items))
        : z.array(z.unknown());
      if (typeof prop.minItems === "number") arr = arr.min(prop.minItems);
      if (typeof prop.maxItems === "number") arr = arr.max(prop.maxItems);
      schema = arr;
      break;
    }
    case "object": {
      const nested = prop.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (nested) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const nestedRequired = new Set(
          (prop.required as string[] | undefined) ?? [],
        );
        for (const [key, val] of Object.entries(nested)) {
          const field = jsonSchemaPropertyToZod(val);
          shape[key] = nestedRequired.has(key) ? field : field.optional();
        }
        schema = z.object(shape);
      } else {
        schema = z.record(z.string(), z.unknown());
      }
      break;
    }
    default:
      schema = z.unknown();
  }

  if (description) {
    schema = schema.describe(description);
  }

  return schema;
}

/**
 * Convert a ToolDefinition's JSON Schema inputSchema to a Zod raw shape
 * suitable for the Agent SDK's tool() function.
 *
 * Exported for unit testing only — not part of the public API.
 */
export function inputSchemaToZodShape(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties = inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return {};

  const required = new Set(
    (inputSchema.required as string[] | undefined) ?? [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const field = jsonSchemaPropertyToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }

  return shape;
}

/**
 * Raw MCP tool definition shape expected by createSdkMcpServer's registerTool.
 *
 * We bypass the SDK's `tool()` helper because it returns a broken structure
 * (`.name` is the entire config object instead of a string) in v0.2.x.
 * Passing raw objects with `{ name, description, inputSchema, handler }` works
 * correctly — `registerTool` validates via `.safeParseAsync()` on the Zod schema.
 */
interface RawSdkTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly handler: (
    input: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

/**
 * Convert a single OpenCrow ToolDefinition into a raw SDK MCP tool definition.
 *
 * Exported for unit testing only — not part of the public API.
 */
export function opencrowToolToSdkTool(toolDef: ToolDefinition): RawSdkTool {
  const zodShape = inputSchemaToZodShape(toolDef.inputSchema);

  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: z.object(zodShape),
    handler: async (args: Record<string, unknown>) => {
      try {
        const result = await toolDef.execute(args);
        // Cap oversized output so a single tool result can't blow the model's
        // context on the Agent SDK path (which has no message-array guards).
        const output = truncateToolResult(
          result.output,
          MCP_TOOL_RESULT_BUDGET,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: output,
            },
          ],
          isError: result.isError,
        };
      } catch (err) {
        const message = getErrorMessage(err);
        log.error("MCP tool execution error", {
          tool: toolDef.name,
          error: message,
        });
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Wrap OpenCrow's ToolRegistry as an in-process MCP server for the Agent SDK.
 *
 * Filters out tools the SDK already provides natively (bash, file ops, grep, glob).
 * Returns a server config that can be passed directly to query()'s mcpServers option.
 */
export function createOpenCrowMcpServer(
  registry: ToolRegistry,
): ReturnType<typeof createSdkMcpServer> {
  const customTools = registry.definitions.filter(
    (t) => !SDK_NATIVE_TOOLS.has(t.name),
  );

  log.info("Creating OpenCrow MCP server", {
    totalTools: registry.definitions.length,
    filteredNative: registry.definitions.length - customTools.length,
    customTools: customTools.map((t) => t.name),
  });

  const sdkTools = customTools.map(opencrowToolToSdkTool);

  return createSdkMcpServer({
    name: "opencrow-tools",
    version: "1.0.0",
    tools: sdkTools as unknown as Parameters<typeof createSdkMcpServer>[0]["tools"],
  });
}
