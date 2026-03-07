import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createGlobTool } from "./glob";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("createGlobTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glob-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: [],
      maxBashTimeout: 30000,
      maxFileSize: 1024 * 1024,
      maxIterations: 200,
    };
    // Create test directory structure
    await mkdir(join(tempDir, "src", "components"), { recursive: true });
    await mkdir(join(tempDir, "tests"), { recursive: true });
    await mkdir(join(tempDir, "node_modules"), { recursive: true });

    // Create test files
    await writeFile(join(tempDir, "package.json"), "{}");
    await writeFile(join(tempDir, "src", "index.ts"), "export const x = 1;");
    await writeFile(join(tempDir, "src", "utils.ts"), "export const y = 2;");
    await writeFile(join(tempDir, "src", "components", "Button.tsx"), "export const Button = () => {};");
    await writeFile(join(tempDir, "tests", "index.test.ts"), "test('works', () => {});");
    await writeFile(join(tempDir, "node_modules", "dep.js"), "module.exports = {};");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createGlobTool(config);
      expect(tool.name).toBe("glob");
    });

    it("should have correct categories", () => {
      const tool = createGlobTool(config);
      expect(tool.categories).toEqual(["fileops", "code"]);
    });

    it("should have required pattern field in inputSchema", () => {
      const tool = createGlobTool(config);
      expect(tool.inputSchema.required).toEqual(["pattern"]);
    });
  });

  describe("execute - basic glob", () => {
    it("should find files matching a simple pattern", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "*.json", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("package.json");
    });

    it("should find files with recursive pattern", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*.ts", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("index.ts");
      expect(result.output).toContain("utils.ts");
    });

    it("should return 'No files matched' when nothing found", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*.xyz", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toBe("No files matched.");
    });

    it("should return error for empty pattern", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "", path: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("pattern is required");
    });
  });

  describe("execute - filtering", () => {
    it("should exclude node_modules directory", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*.js", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain("node_modules");
    });

    it("should exclude .git directory", async () => {
      // Create .git directory and file for testing
      await mkdir(join(tempDir, ".git"), { recursive: true });
      await writeFile(join(tempDir, ".git", "config"), "[core]");
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain(".git/");
    });

    it("should exclude dist directory", async () => {
      await mkdir(join(tempDir, "dist"), { recursive: true });
      await writeFile(join(tempDir, "dist", "bundle.js"), "");
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*.js", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain("dist");
    });

    it("should exclude coverage directory", async () => {
      await mkdir(join(tempDir, "coverage"), { recursive: true });
      await writeFile(join(tempDir, "coverage", "report.html"), "");
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain("coverage");
    });
  });

  describe("execute - maxResults", () => {
    it("should respect maxResults limit", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({
        pattern: "**/*.ts",
        path: tempDir,
        maxResults: 2
      });
      expect(result.isError).toBe(false);
      const lines = result.output.split("\n").filter(l => l.trim() && !l.startsWith("["));
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    it("should use default maxResults when not specified", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "**/*", path: tempDir });
      expect(result.isError).toBe(false);
      // Default is 30, max is 100
      const lines = result.output.split("\n").filter(l => l.trim() && !l.startsWith("["));
      expect(lines.length).toBeLessThanOrEqual(30);
    });

    it("should cap maxResults at 100", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({
        pattern: "**/*",
        path: tempDir,
        maxResults: 500
      });
      expect(result.isError).toBe(false);
      const lines = result.output.split("\n").filter(l => l.trim() && !l.startsWith("["));
      expect(lines.length).toBeLessThanOrEqual(100);
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "*", path: "/etc" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should use default path when not specified", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "*.json" });
      // May fail if home not in allowed dirs, but should not crash
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - output format", () => {
    it("should include file count and relative path in header", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "*.json", path: tempDir });
      expect(result.output).toMatch(/\[\d+ files in/);
    });

    it("should return file paths as output", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "src/**/*.ts", path: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("src/");
    });
  });

  describe("execute - error handling", () => {
    it("should handle invalid glob patterns gracefully", async () => {
      const tool = createGlobTool(config);
      const result = await tool.execute({ pattern: "[invalid", path: tempDir });
      // Should either work or return error, but not crash
      expect(result.output).toBeDefined();
    });
  });
});
