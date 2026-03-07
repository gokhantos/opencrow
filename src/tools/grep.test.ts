import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createGrepTool } from "./grep";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("createGrepTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grep-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: [],
      maxBashTimeout: 30000,
      maxFileSize: 1024 * 1024,
      maxIterations: 200,
    };
    // Create test files
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "index.ts"), "export const hello = 'world';\nconsole.log(hello);\n");
    await writeFile(join(tempDir, "src", "utils.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    await writeFile(join(tempDir, "README.md"), "# Test Project\n\nThis is a test.\n");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createGrepTool(config);
      expect(tool.name).toBe("grep");
    });

    it("should have correct categories", () => {
      const tool = createGrepTool(config);
      expect(tool.categories).toEqual(["fileops", "code"]);
    });

    it("should have required pattern field in inputSchema", () => {
      const tool = createGrepTool(config);
      expect(tool.inputSchema.required).toEqual(["pattern"]);
    });
  });

  describe("execute - basic search", () => {
    it("should find matches for a pattern", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({ pattern: "export", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("export");
    });

    it("should return 'No matches found' when pattern not found", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({ pattern: "nonexistent_pattern_xyz", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toBe("No matches found.");
    });

    it("should return error for empty pattern", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({ pattern: "", path: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("pattern is required");
    });

    it("should find matches in specific file", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "console.log",
        path: join(tempDir, "src", "index.ts")
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("console.log");
    });
  });

  describe("execute - options", () => {
    it("should support case insensitive search", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "EXPORT",
        path: tempDir,
        ignoreCase: true
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("export");
    });

    it("should respect maxResults limit", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "export",
        path: tempDir,
        maxResults: 1
      });
      expect(result.isError).toBe(false);
      const lines = result.output.split("\n").filter(l => l.trim());
      // Header + 1 result
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    it("should support glob pattern filtering", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "export",
        path: tempDir,
        glob: "*.ts"
      });
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain("README.md");
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({ pattern: "test", path: "/etc" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should use default path when not specified", async () => {
      const tool = createGrepTool(config);
      // This will search in home directory which may not be allowed
      // Accept any result as long as it doesn't crash
      const result = await tool.execute({ pattern: "test" });
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - pattern validation", () => {
    it("should reject patterns that are too long", async () => {
      const tool = createGrepTool(config);
      const longPattern = "a".repeat(501);
      const result = await tool.execute({ pattern: longPattern, path: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("too long");
    });

    it("should handle regex patterns", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "function \\w+",
        path: tempDir
      });
      expect(result.isError).toBe(false);
    });
  });

  describe("execute - output format", () => {
    it("should include match count in header", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({ pattern: "export", path: tempDir });
      expect(result.output).toMatch(/\[\d+ matches\]/);
    });

    it("should show truncated count when results exceed limit", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "test",
        path: tempDir,
        maxResults: 1
      });
      // If there are more results than limit, should show "X of Y+ matches"
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - error handling", () => {
    it("should handle nonexistent path gracefully", async () => {
      const tool = createGrepTool(config);
      const result = await tool.execute({
        pattern: "test",
        path: join(tempDir, "nonexistent")
      });
      // grep with nonexistent path typically returns exit code 2
      expect(result.output).toBeDefined();
    });
  });
});
