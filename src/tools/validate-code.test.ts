import { describe, it, expect } from "bun:test";
import { createValidateCodeTool } from "./validate-code";
import type { ToolsConfig } from "../config/schema";

const config: ToolsConfig = {
  allowedDirectories: ["/tmp"],
  blockedCommands: [],
  maxBashTimeout: 30000,
  maxFileSize: 1024 * 1024,
  maxIterations: 200,
};

describe("createValidateCodeTool", () => {
  describe("tool definition", () => {
    it("should have the correct name", () => {
      const tool = createValidateCodeTool(config);
      expect(tool.name).toBe("validate_code");
    });

    it("should have a description mentioning validation", () => {
      const tool = createValidateCodeTool(config);
      expect(tool.description).toBeTruthy();
      expect(tool.description.toLowerCase()).toContain("type checking");
      expect(tool.description.toLowerCase()).toContain("linting");
    });

    it("should have code category", () => {
      const tool = createValidateCodeTool(config);
      expect(tool.categories).toEqual(["code"]);
    });

    it("should have an execute function", () => {
      const tool = createValidateCodeTool(config);
      expect(typeof tool.execute).toBe("function");
    });

    it("should have no required inputs", () => {
      const tool = createValidateCodeTool(config);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.required).toEqual([]);
    });
  });

  describe("inputSchema properties", () => {
    it("should define path property", () => {
      const tool = createValidateCodeTool(config);
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.path).toBeDefined();
    });

    it("should define steps property as array", () => {
      const tool = createValidateCodeTool(config);
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.steps).toBeDefined();
      expect(props.steps.type).toBe("array");
    });

    it("should define steps with valid enum values", () => {
      const tool = createValidateCodeTool(config);
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.steps.items.enum).toEqual(["typecheck", "lint", "test"]);
    });

    it("should define timeout property as number", () => {
      const tool = createValidateCodeTool(config);
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.timeout).toBeDefined();
      expect(props.timeout.type).toBe("number");
    });

    it("should define fix property as boolean", () => {
      const tool = createValidateCodeTool(config);
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.fix).toBeDefined();
      expect(props.fix.type).toBe("boolean");
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const restrictedConfig: ToolsConfig = {
        allowedDirectories: ["/tmp/allowed-only-xyz"],
        blockedCommands: [],
        maxBashTimeout: 30000,
        maxFileSize: 1024 * 1024,
        maxIterations: 200,
      };
      const tool = createValidateCodeTool(restrictedConfig);
      const result = await tool.execute({ path: "/home/not-allowed" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should handle non-existent but allowed path gracefully", async () => {
      const tool = createValidateCodeTool(config);
      // A non-existent path under /tmp - should not crash, just report no tools found
      const result = await tool.execute({
        path: "/tmp/nonexistent-project-xyzzy-" + Date.now(),
      });
      // Should succeed with "no validation tools detected" or similar
      expect(result.isError).toBe(false);
      expect(result.output.toLowerCase()).toContain("no validation tools detected");
    });
  });
});
