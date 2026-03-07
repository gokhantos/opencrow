import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createEditFileTool } from "./edit-file";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("createEditFileTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "editfile-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: [],
      maxBashTimeout: 30000,
      maxFileSize: 1024 * 1024,
      maxIterations: 200,
    };
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createEditFileTool(config);
      expect(tool.name).toBe("edit_file");
    });

    it("should have correct categories", () => {
      const tool = createEditFileTool(config);
      expect(tool.categories).toEqual(["fileops", "code"]);
    });

    it("should have required fields in inputSchema", () => {
      const tool = createEditFileTool(config);
      expect(tool.inputSchema.required).toEqual(["path", "old_string", "new_string"]);
    });
  });

  describe("execute - basic editing", () => {
    it("should replace a string in a file", async () => {
      const testFile = join(tempDir, "test.txt");
      const content = "Hello, World! This is a test.";
      await writeFile(testFile, content);

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "World",
        new_string: "Universe"
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Edited");
      expect(result.output).toContain("line 1");

      // Verify the change
      const updated = await readFile(testFile, "utf-8");
      expect(updated).toBe("Hello, Universe! This is a test.");
    });

    it("should handle multi-line replacements", async () => {
      const testFile = join(tempDir, "multiline.txt");
      const content = "Line 1\nLine 2\nLine 3";
      await writeFile(testFile, content);

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "Line 2",
        new_string: "New Line 2\nExtra Line"
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("2 lines");

      const updated = await readFile(testFile, "utf-8");
      expect(updated).toBe("Line 1\nNew Line 2\nExtra Line\nLine 3");
    });

    it("should return error for empty old_string", async () => {
      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: join(tempDir, "test.txt"),
        old_string: "",
        new_string: "something"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("old_string is required");
    });

    it("should return error when old_string equals new_string", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "same",
        new_string: "same"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("identical");
    });
  });

  describe("execute - string occurrence validation", () => {
    it("should return error when old_string not found", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "Hello World");

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "NotFound",
        new_string: "Something"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("should return error when old_string appears multiple times", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "test test test");

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "test",
        new_string: "prod"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("appears");
      expect(result.output).toContain("times");
    });

    it("should succeed when old_string is unique", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "one two three");

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "two",
        new_string: "TWO"
      });

      expect(result.isError).toBe(false);
      const updated = await readFile(testFile, "utf-8");
      expect(updated).toBe("one TWO three");
    });
  });

  describe("execute - protected files", () => {
    it("should block editing guardian.sh", async () => {
      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: join(tempDir, "guardian.sh"),
        old_string: "x",
        new_string: "y"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("protected system file");
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: "/etc/passwd",
        old_string: "x",
        new_string: "y"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should return error for nonexistent file", async () => {
      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: join(tempDir, "nonexistent.txt"),
        old_string: "x",
        new_string: "y"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("file not found");
    });
  });

  describe("execute - output details", () => {
    it("should report line number where edit occurred", async () => {
      const testFile = join(tempDir, "test.txt");
      const content = "Line 1\nLine 2\nLine 3\nTarget\nLine 5";
      await writeFile(testFile, content);

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "Target",
        new_string: "CHANGED"
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("line 4");
    });

    it("should report line count change", async () => {
      const testFile = join(tempDir, "test.txt");
      const content = "one line";
      await writeFile(testFile, content);

      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: testFile,
        old_string: "one line",
        new_string: "two\nlines"
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("1 lines → 2 lines");
    });
  });

  describe("execute - error handling", () => {
    it("should handle permission errors gracefully", async () => {
      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: "/root/test.txt",
        old_string: "x",
        new_string: "y"
      });

      expect(result.isError).toBe(true);
    });

    it("should handle directory paths gracefully", async () => {
      const tool = createEditFileTool(config);
      const result = await tool.execute({
        path: tempDir,
        old_string: "x",
        new_string: "y"
      });

      expect(result.isError).toBe(true);
    });
  });
});
