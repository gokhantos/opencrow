import { z } from "zod";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";
import { createLogger } from "../logger";

import { getErrorMessage } from "../lib/error-serialization";
const log = createLogger("mcp-bridge");

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
 * Convert a JSON Schema property definition to a Zod type.
 * Handles the common types used by OpenCrow's tool schemas.
 */
function jsonSchemaPropertyToZod(
  prop: Record<string, unknown>,
): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  let schema: z.ZodTypeAny;

  switch (type) {
    case "string": {
      let s = z.string();
      if (prop.enum) {
        const values = prop.enum as [string, ...string[]];
        schema = z.enum(values);
      } else {
        schema = s;
      }
      break;
    }
    case "number":
    case "integer":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        schema = z.array(jsonSchemaPropertyToZod(items));
      } else {
        schema = z.array(z.unknown());
      }
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
 */
function inputSchemaToZodShape(
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
 */
function opencrowToolToSdkTool(toolDef: ToolDefinition): RawSdkTool {
  const zodShape = inputSchemaToZodShape(toolDef.inputSchema);

  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: z.object(zodShape),
    handler: async (args: Record<string, unknown>) => {
      try {
        const result = await toolDef.execute(args);
        return {
          content: [
            {
              type: "text" as const,
              text: result.output,
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
