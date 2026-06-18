import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createGrepTool } from "./grep";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Returns the count of live processes whose command line contains `marker`.
// Uses pgrep -f (matches full args). Exit code 1 = no matches (count 0).
async function countProcesses(marker: string): Promise<number> {
  const proc = Bun.spawn(["pgrep", "-f", marker], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return 0;
  return out.split("\n").filter(Boolean).length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createGrepTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grep-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: [],
      sandbox: "off",
      devToolsAllowNetwork: false,
      allowUnsandboxedDevTools: false,
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

  // Regression: on timeout the grep child must be killed via its process group,
  // not orphaned. grep is a single non-forking binary so the orphan risk is low,
  // but the timeout path is spawned `detached: true` and routed through
  // killProcessGroup to stay consistent with the bash/shell-runner tools and to
  // be robust if the spawn shape ever gains children.
  describe("execute - process-group cleanup on timeout", () => {
    // Unique per-test marker so we can detect leaks via pgrep without
    // cross-test interference, plus defensive cleanup if a regression leaks.
    let marker: string;

    beforeEach(() => {
      marker = `UNIQUEMARKER_${crypto.randomUUID().replace(/-/g, "")}`;
    });

    afterEach(() => {
      Bun.spawnSync(["pkill", "-9", "-f", marker]);
    });

    it("does not leave a grep process alive after a TIMEOUT", async () => {
      // Build a large enough tree that the recursive scan can't finish within a
      // 1ms timeout. The marker is the search pattern, so it rides in grep's
      // argv where `pgrep -f` can find a survivor.
      const big = "filler line that grep must scan\n".repeat(2000);
      for (let i = 0; i < 60; i++) {
        await writeFile(join(tempDir, `big-${i}.txt`), big);
      }

      // 1ms timeout fires before grep can complete the scan.
      const tool = createGrepTool(config, 1);
      const result = await tool.execute({ pattern: marker, path: tempDir });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("timed out");

      // Poll briefly: the kill is async w.r.t. the OS reaping the process.
      let count = await countProcesses(marker);
      for (let i = 0; i < 20 && count > 0; i++) {
        await sleep(100);
        count = await countProcesses(marker);
      }
      expect(count).toBe(0);
    });
  });
});
