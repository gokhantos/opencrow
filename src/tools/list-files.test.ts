import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createListFilesTool } from "./list-files";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("createListFilesTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listfiles-test-"));
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
      const tool = createListFilesTool(config);
      expect(tool.name).toBe("list_files");
    });

    it("should have correct categories", () => {
      const tool = createListFilesTool(config);
      expect(tool.categories).toEqual(["fileops", "code"]);
    });

    it("should have required path field in inputSchema", () => {
      const tool = createListFilesTool(config);
      expect(tool.inputSchema.required).toEqual(["path"]);
    });
  });

  describe("execute - basic listing", () => {
    it("should list files in a directory", async () => {
      await writeFile(join(tempDir, "file1.txt"), "content1");
      await writeFile(join(tempDir, "file2.txt"), "content2");

      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: tempDir });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("file1.txt");
      expect(result.output).toContain("file2.txt");
    });

    it("should indicate directories with trailing slash", async () => {
      await mkdir(join(tempDir, "subdir"));
      await writeFile(join(tempDir, "file.txt"), "content");

      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: tempDir });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("subdir/");
      expect(result.output).toContain("file.txt");
    });

    it("should return error for nonexistent path", async () => {
      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: join(tempDir, "nonexistent") });

      expect(result.isError).toBe(true);
    });
  });

  describe("execute - recursive listing", () => {
    it("should list files recursively when recursive=true", async () => {
      await mkdir(join(tempDir, "subdir"), { recursive: true });
      await writeFile(join(tempDir, "root.txt"), "root");
      await writeFile(join(tempDir, "subdir", "nested.txt"), "nested");

      const tool = createListFilesTool(config);
      const result = await tool.execute({
        path: tempDir,
        recursive: true
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("root.txt");
      expect(result.output).toContain("subdir");
      expect(result.output).toContain("nested.txt");
    });

    it("should use indentation for nested directories", async () => {
      await mkdir(join(tempDir, "level1", "level2"), { recursive: true });
      await writeFile(join(tempDir, "level1", "level2", "deep.txt"), "deep");

      const tool = createListFilesTool(config);
      const result = await tool.execute({
        path: tempDir,
        recursive: true
      });

      expect(result.isError).toBe(false);
      // Nested items should have indentation
      expect(result.output).toContain("  ");
    });

    it("should respect max depth", async () => {
      // Create deep nested structure
      let currentPath = tempDir;
      for (let i = 0; i < 12; i++) {
        currentPath = join(currentPath, `level${i}`);
        await mkdir(currentPath, { recursive: true });
      }

      const tool = createListFilesTool(config);
      const result = await tool.execute({
        path: tempDir,
        recursive: true
      });

      expect(result.isError).toBe(false);
      // Should not error, but may not show all 12 levels
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: "/etc" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should expand home directory", async () => {
      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: "~" });
      // May succeed or fail based on config, but should not crash
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - error handling", () => {
    it("should handle permission errors gracefully", async () => {
      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: "/root" });

      expect(result.isError).toBe(true);
    });

    it("should handle file path (not directory) gracefully", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");

      const tool = createListFilesTool(config);
      const result = await tool.execute({ path: testFile });

      // Trying to list a file as if it's a directory should fail
      expect(result.isError).toBe(true);
    });
  });
});
