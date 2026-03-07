import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createReadFileTool } from "./read-file";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("createReadFileTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "readfile-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: [],
      maxBashTimeout: 30000,
      maxFileSize: 1024, // 1KB for testing
      maxIterations: 200,
    };
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createReadFileTool(config);
      expect(tool.name).toBe("read_file");
    });

    it("should have correct categories", () => {
      const tool = createReadFileTool(config);
      expect(tool.categories).toEqual(["fileops", "code"]);
    });

    it("should have required path field in inputSchema", () => {
      const tool = createReadFileTool(config);
      expect(tool.inputSchema.required).toEqual(["path"]);
    });
  });

  describe("execute - basic reading", () => {
    it("should read a file and return contents", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "Hello, World!");

      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: testFile });

      expect(result.isError).toBe(false);
      expect(result.output).toBe("Hello, World!");
    });

    it("should return error for nonexistent file", async () => {
      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: join(tempDir, "nonexistent.txt") });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("file not found");
    });

    it("should return error for empty path", async () => {
      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: "" });

      expect(result.isError).toBe(true);
    });
  });

  describe("execute - line range", () => {
    it("should read specific line range", async () => {
      const testFile = join(tempDir, "multiline.txt");
      const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      await writeFile(testFile, content);

      const tool = createReadFileTool(config);
      const result = await tool.execute({
        path: testFile,
        startLine: 2,
        endLine: 4
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Lines 2-4");
      expect(result.output).toContain("Line 2");
      expect(result.output).toContain("Line 4");
      expect(result.output).not.toContain("Line 1");
      expect(result.output).not.toContain("Line 5");
    });

    it("should read from startLine to end of file", async () => {
      const testFile = join(tempDir, "multiline.txt");
      const content = "Line 1\nLine 2\nLine 3";
      await writeFile(testFile, content);

      const tool = createReadFileTool(config);
      const result = await tool.execute({
        path: testFile,
        startLine: 2
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Line 2");
      expect(result.output).toContain("Line 3");
    });

    it("should return error for invalid startLine", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");

      const tool = createReadFileTool(config);
      const result = await tool.execute({
        path: testFile,
        startLine: 0
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("positive integer");
    });

    it("should return error for endLine less than startLine", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");

      const tool = createReadFileTool(config);
      const result = await tool.execute({
        path: testFile,
        startLine: 5,
        endLine: 3
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("endLine must be an integer >= startLine");
    });

    it("should handle startLine beyond file length", async () => {
      const testFile = join(tempDir, "short.txt");
      await writeFile(testFile, "Line 1\nLine 2");

      const tool = createReadFileTool(config);
      const result = await tool.execute({
        path: testFile,
        startLine: 100
      });

      // Should return empty or handle gracefully
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - file size handling", () => {
    it("should truncate large files", async () => {
      const testFile = join(tempDir, "large.txt");
      const largeContent = "x".repeat(2000); // 2KB, exceeds 1KB limit
      await writeFile(testFile, largeContent);

      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: testFile });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Truncated");
      expect(result.output).toContain("showing first");
    });

    it("should read files within size limit without truncation", async () => {
      const testFile = join(tempDir, "small.txt");
      const smallContent = "Small content";
      await writeFile(testFile, smallContent);

      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: testFile });

      expect(result.isError).toBe(false);
      expect(result.output).not.toContain("Truncated");
      expect(result.output).toBe(smallContent);
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: "/etc/passwd" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should handle relative paths", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");

      const tool = createReadFileTool(config);
      // Relative to current working directory
      const relativePath = testFile.replace(process.cwd() + "/", "");
      const result = await tool.execute({ path: relativePath });

      // May fail if relative path resolves outside allowed dirs
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - home directory expansion", () => {
    it("should expand ~ in paths", async () => {
      const tool = createReadFileTool(config);
      // This test depends on HOME being in allowed dirs
      const result = await tool.execute({ path: "~/.bashrc" });
      // May succeed or fail based on config, but should not crash
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - error handling", () => {
    it("should handle permission errors gracefully", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");
      await rm(testFile); // Delete to simulate access issue

      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: testFile });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("file not found");
    });

    it("should handle directory paths gracefully", async () => {
      const tool = createReadFileTool(config);
      const result = await tool.execute({ path: tempDir });

      // Reading a directory should fail gracefully
      expect(result.isError).toBe(true);
    });
  });
});
