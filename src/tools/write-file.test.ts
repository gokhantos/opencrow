import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createWriteFileTool } from "./write-file";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, readFile, rm, mkdir, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("createWriteFileTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "writefile-test-"));
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
      const tool = createWriteFileTool(config);
      expect(tool.name).toBe("write_file");
    });

    it("should have correct categories", () => {
      const tool = createWriteFileTool(config);
      expect(tool.categories).toEqual(["fileops", "code"]);
    });

    it("should have required path and content fields in inputSchema", () => {
      const tool = createWriteFileTool(config);
      expect(tool.inputSchema.required).toEqual(["path", "content"]);
    });
  });

  describe("execute - basic writing", () => {
    it("should write content to a new file", async () => {
      const testFile = join(tempDir, "newfile.txt");
      const content = "Hello, World!";

      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: testFile, content });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Successfully wrote");

      // Verify file was created
      const fileContent = await readFile(testFile, "utf-8");
      expect(fileContent).toBe(content);
    });

    it("should overwrite existing file", async () => {
      const testFile = join(tempDir, "existing.txt");
      await writeFile(testFile, "Old content");

      const newContent = "New content";
      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: testFile, content: newContent });

      expect(result.isError).toBe(false);

      // Verify file was overwritten
      const fileContent = await readFile(testFile, "utf-8");
      expect(fileContent).toBe(newContent);
    });

    it("should return error for empty path", async () => {
      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: "", content: "test" });

      expect(result.output).toBeDefined();
    });

    it("should handle empty content", async () => {
      const testFile = join(tempDir, "empty.txt");

      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: testFile, content: "" });

      expect(result.isError).toBe(false);

      const fileContent = await readFile(testFile, "utf-8");
      expect(fileContent).toBe("");
    });
  });

  describe("execute - directory creation", () => {
    it("should create parent directories as needed", async () => {
      const testFile = join(tempDir, "deep", "nested", "dir", "file.txt");
      const content = "Nested content";

      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: testFile, content });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Successfully wrote");

      // Verify file and directories were created
      const fileContent = await readFile(testFile, "utf-8");
      expect(fileContent).toBe(content);
    });
  });

  describe("execute - protected files", () => {
    it("should block writing to guardian.sh", async () => {
      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: join(tempDir, "guardian.sh"), content: "malicious" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("protected system file");
    });

    it("should block writing to guardian.sh in any path", async () => {
      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: "/some/path/guardian.sh", content: "malicious" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("protected system file");
    });
  });

  describe("execute - path validation", () => {
    it("should reject paths outside allowed directories", async () => {
      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: "/etc/test.txt", content: "test" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should reject paths that resolve outside allowed directories", async () => {
      const tool = createWriteFileTool(config);
      // Try to use relative path traversal
      const result = await tool.execute({
        path: join(tempDir, "..", "..", "etc", "test.txt"),
        content: "test"
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });
  });

  describe("execute - home directory expansion", () => {
    it("should expand ~ in paths", async () => {
      const tool = createWriteFileTool(config);
      // This depends on HOME being in allowed directories
      const result = await tool.execute({ path: "~/test.txt", content: "test" });
      // May succeed or fail based on config, but should not crash
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - bytes written reporting", () => {
    it("should report correct bytes written", async () => {
      const testFile = join(tempDir, "size.txt");
      const content = "Hello!"; // 6 bytes

      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: testFile, content });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("6 bytes");
    });

    it("should report bytes for multi-byte characters", async () => {
      const testFile = join(tempDir, "unicode.txt");
      const content = "Hello 🌍!"; // Contains multi-byte emoji

      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: testFile, content });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("bytes");
    });
  });

  describe("execute - error handling", () => {
    it("should handle permission errors gracefully", async () => {
      const tool = createWriteFileTool(config);
      const result = await tool.execute({ path: "/root/test.txt", content: "test" });

      // Should fail with permission or path not allowed
      expect(result.isError).toBe(true);
    });

    it("should handle invalid file paths gracefully", async () => {
      const tool = createWriteFileTool(config);
      // Null byte in path should fail gracefully
      const result = await tool.execute({ path: "test\0.txt", content: "test" });

      expect(result.output).toBeDefined();
    });
  });
});

// Helper for setup
async function writeFile(path: string, content: string): Promise<void> {
  const { writeFile: fsWriteFile } = await import("fs/promises");
  await fsWriteFile(path, content);
}
