import { describe, it, expect } from "bun:test";
import { createAgentTemplatesTool } from "./agent-templates";
import type { ToolDefinition } from "./types";

describe("createAgentTemplatesTool", () => {
  let tool: ToolDefinition;

  // Fresh tool instance per describe block (stateless tool, no need for beforeEach)
  tool = createAgentTemplatesTool();

  describe("tool definition", () => {
    it("should have the correct name", () => {
      expect(tool.name).toBe("agent_templates");
    });

    it("should have a description mentioning templates", () => {
      expect(tool.description).toBeTruthy();
      expect(tool.description.toLowerCase()).toContain("template");
    });

    it("should have system category", () => {
      expect(tool.categories).toEqual(["system"]);
    });

    it("should have an inputSchema with action and template_id properties", () => {
      expect(tool.inputSchema.type).toBe("object");
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.action).toBeDefined();
      expect(props.template_id).toBeDefined();

      const required = tool.inputSchema.required as string[];
      expect(required).toContain("action");
    });

    it("should define action as enum with list and get", () => {
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      const actionDef = props.action!;
      expect(actionDef.type).toBe("string");
      expect(actionDef.enum).toEqual(["list", "get"]);
    });

    it("should have an execute function", () => {
      expect(typeof tool.execute).toBe("function");
    });
  });

  describe("execute — list action", () => {
    it("should return all templates in brief format", async () => {
      const result = await tool.execute({ action: "list" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("chatbot");
      expect(result.output).toContain("opencrow");
      expect(result.output).toContain("custom");
    });

    it("should include template names and descriptions", async () => {
      const result = await tool.execute({ action: "list" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("Chatbot");
      expect(result.output).toContain("OpenCrow");
      expect(result.output).toContain("Simple conversational bot");
    });

    it("should not include full config in list output", async () => {
      const result = await tool.execute({ action: "list" });
      // List should be brief — no maxIterations or toolFilter details
      expect(result.output).not.toContain("maxIterations");
      expect(result.output).not.toContain("toolFilter");
    });
  });

  describe("execute — get action", () => {
    it("should return full config for a valid template_id", async () => {
      const result = await tool.execute({
        action: "get",
        template_id: "opencrow",
      });
      expect(result.isError).toBe(false);

      const parsed = JSON.parse(result.output);
      expect(parsed.templateId).toBe("opencrow");
      expect(parsed.name).toBe("OpenCrow");
      expect(parsed.config.provider).toBe("agent-sdk");
      expect(parsed.config.model).toBe("claude-sonnet-4-6");
      expect(parsed.config.maxIterations).toBe(150);
      expect(parsed.config.toolFilter.mode).toBe("all");
    });

    it("should include a hint about manage_agent", async () => {
      const result = await tool.execute({
        action: "get",
        template_id: "chatbot",
      });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.output);
      expect(parsed.hint).toContain("manage_agent");
    });

    it("should return error for unknown template_id", async () => {
      const result = await tool.execute({
        action: "get",
        template_id: "nonexistent",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("nonexistent");
    });

    it("should return error when template_id is missing", async () => {
      const result = await tool.execute({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.output.toLowerCase()).toContain("template_id");
    });
  });

  describe("execute — invalid action", () => {
    it("should return error for unknown action", async () => {
      const result = await tool.execute({ action: "delete" });
      expect(result.isError).toBe(true);
    });

    it("should return error when action is missing", async () => {
      const result = await tool.execute({});
      expect(result.isError).toBe(true);
    });
  });

  describe("template data integrity", () => {
    const templateIds = [
      "chatbot",
      "opencrow",
      "custom",
    ];

    for (const id of templateIds) {
      it(`template "${id}" should have all required config fields`, async () => {
        const result = await tool.execute({ action: "get", template_id: id });
        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.output);
        const config = parsed.config;

        expect(config.provider).toBe("agent-sdk");
        expect(typeof config.model).toBe("string");
        expect(typeof config.maxIterations).toBe("number");
        expect(config.maxIterations).toBeGreaterThan(0);
        expect(typeof config.stateless).toBe("boolean");
        expect(typeof config.reasoning).toBe("boolean");
        expect(config.toolFilter).toBeDefined();
        expect(config.toolFilter.mode).toBeDefined();
        expect(config.modelParams).toBeDefined();
      });
    }
  });
});
