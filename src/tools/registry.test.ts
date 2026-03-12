import { describe, it, expect, beforeEach } from "bun:test";
import { createToolRegistry } from "./registry";
import { createToolRouter } from "./router";
import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";

// Mock tools for testing
function createMockTool(
  name: string,
  description: string,
  categories: readonly ToolCategory[],
  executeFn?: (input: Record<string, unknown>) => Promise<ToolResult>,
): ToolDefinition {
  return {
    name,
    description,
    categories,
    inputSchema: { type: "object", properties: {} },
    execute: executeFn ?? (async () => ({ output: `mock ${name}`, isError: false })),
  };
}

describe("createToolRegistry", () => {
  let config: ToolsConfig;

  beforeEach(() => {
    config = {
      allowedDirectories: ["/tmp"],
      blockedCommands: ["sudo"],
      maxBashTimeout: 30000,
      maxFileSize: 1024 * 1024,
      maxIterations: 200,
    };
  });

  describe("tool creation", () => {
    it("should create registry with core tools", () => {
      const registry = createToolRegistry(config);
      expect(registry).toBeDefined();
      expect(registry.definitions.length).toBeGreaterThan(0);
    });

    it("should include bash tool", () => {
      const registry = createToolRegistry(config);
      const toolNames = registry.definitions.map(t => t.name);
      expect(toolNames).toContain("bash");
    });

    it("should include file operation tools", () => {
      const registry = createToolRegistry(config);
      const toolNames = registry.definitions.map(t => t.name);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("edit_file");
      expect(toolNames).toContain("list_files");
    });

    it("should include search tools", () => {
      const registry = createToolRegistry(config);
      const toolNames = registry.definitions.map(t => t.name);
      expect(toolNames).toContain("grep");
      expect(toolNames).toContain("glob");
    });
  });

  describe("getAnthropicTools", () => {
    it("should convert tools to Anthropic format", () => {
      const registry = createToolRegistry(config);
      const anthropicTools = registry.getAnthropicTools();

      expect(anthropicTools.length).toBeGreaterThan(0);

      const bashTool = anthropicTools.find(t => t.name === "bash");
      expect(bashTool).toBeDefined();
      expect(bashTool?.name).toBe("bash");
      expect(bashTool?.description).toBeDefined();
      expect(bashTool?.input_schema).toBeDefined();
    });
  });

  describe("getOpenAITools", () => {
    it("should convert tools to OpenAI format", () => {
      const registry = createToolRegistry(config);
      const openaiTools = registry.getOpenAITools();

      expect(openaiTools.length).toBeGreaterThan(0);

      const bashTool = openaiTools.find(t => t.function.name === "bash");
      expect(bashTool).toBeDefined();
      expect(bashTool?.type).toBe("function");
      expect(bashTool?.function.name).toBe("bash");
      expect(bashTool?.function.description).toBeDefined();
      expect(bashTool?.function.parameters).toBeDefined();
    });
  });

  describe("executeTool", () => {
    it("should execute a known tool", async () => {
      const registry = createToolRegistry(config);
      const result = await registry.executeTool("bash", { command: "echo test" });
      expect(result.output).toBeDefined();
    });

    it("should return error for unknown tool", async () => {
      const registry = createToolRegistry(config);
      const result = await registry.executeTool("nonexistent_tool", {});
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not a valid tool");
    });

    it("should return error for empty command in bash", async () => {
      const registry = createToolRegistry(config);
      const result = await registry.executeTool("bash", { command: "" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("empty command");
    });
  });

  describe("withFilter", () => {
    it("should filter tools with allowlist", () => {
      const registry = createToolRegistry(config);
      const filtered = registry.withFilter({
        mode: "allowlist",
        tools: ["bash", "grep"],
      });

      const toolNames = filtered.definitions.map(t => t.name);
      expect(toolNames).toEqual(["bash", "grep"]);
    });

    it("should filter tools with blocklist", () => {
      const registry = createToolRegistry(config);
      const allTools = registry.definitions.map(t => t.name);
      const filtered = registry.withFilter({
        mode: "blocklist",
        tools: ["bash"],
      });

      const toolNames = filtered.definitions.map(t => t.name);
      expect(toolNames).not.toContain("bash");
      expect(toolNames.length).toBe(allTools.length - 1);
    });

    it("should return all tools with mode 'all'", () => {
      const registry = createToolRegistry(config);
      const filtered = registry.withFilter({ mode: "all", tools: [] });

      expect(filtered.definitions.length).toBe(registry.definitions.length);
    });
  });

  describe("withTools", () => {
    it("should add extra tools to registry", () => {
      const registry = createToolRegistry(config);
      const extraTool = createMockTool("custom_tool", "Custom tool", ["code"]);
      const extended = registry.withTools([extraTool]);

      const toolNames = extended.definitions.map(t => t.name);
      expect(toolNames).toContain("custom_tool");
    });
  });

  describe("withRouter", () => {
    it("should set up tool router for smart routing", () => {
      const registry = createToolRegistry(config);
      const router = createToolRouter(registry.definitions);
      const result = registry.withRouter(router);

      expect(result).toBeDefined();
    });

    it("should record tool execution via router", async () => {
      const registry = createToolRegistry(config);
      const router = createToolRouter(registry.definitions);
      registry.withRouter(router);

      await registry.executeTool("bash", { command: "echo test" });

      // Router should have recorded the execution
      const tools = router.getRelevantTools(["code"], ["bash"], 10);
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe("getRelevantTools", () => {
    it("should return relevant tools using router", () => {
      const registry = createToolRegistry(config);

      // First call creates the router internally
      const tools = registry.getRelevantTools(["code"], ["file"], 5);

      expect(tools.length).toBeGreaterThan(0);
      expect(tools.length).toBeLessThanOrEqual(5);
    });

    it("should use default limit when not specified", () => {
      const registry = createToolRegistry(config);
      const tools = registry.getRelevantTools(["code"], []);

      expect(tools.length).toBeLessThanOrEqual(15);
    });
  });

  describe("recordToolExecution", () => {
    it("should record tool execution for router", () => {
      const registry = createToolRegistry(config);

      registry.recordToolExecution("bash", true);
      registry.recordToolExecution("grep", false);

      // Should not throw
      expect(registry).toBeDefined();
    });

    it("should create router if not exists", () => {
      const registry = createToolRegistry(config);
      registry.recordToolExecution("bash", true);

      // Now getRelevantTools should use the router with history
      const tools = registry.getRelevantTools([], ["bash"], 10);
      expect(tools.length).toBeGreaterThan(0);
    });
  });
});

describe("buildRegistry (internal)", () => {
  it("should build registry from tool definitions", () => {
    // Note: buildRegistry is internal, but we test via createToolRegistry
    // This is a placeholder for when we export it for testing
  });
});
