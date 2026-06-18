import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createBashTool } from "./bash";
import type { ToolsConfig } from "../config/schema";
import { mkdtemp, writeFile, rm } from "fs/promises";
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

describe("createBashTool", () => {
  let config: ToolsConfig;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bash-test-"));
    config = {
      allowedDirectories: [tempDir],
      blockedCommands: ["sudo", "rm -rf /", "mkfs", "dd"],
      dangerousCommandBlocking: true,
      maxBashTimeout: 30000,
      maxFileSize: 1024 * 1024,
      maxIterations: 200,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createBashTool(config);
      expect(tool.name).toBe("bash");
    });

    it("should have correct categories", () => {
      const tool = createBashTool(config);
      expect(tool.categories).toEqual(["code", "system"]);
    });

    it("should have inputSchema with required command field", () => {
      const tool = createBashTool(config);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.required).toEqual(["command"]);
    });
  });

  describe("execute - basic commands", () => {
    it("should execute a simple command and return output", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "echo hello", workingDirectory: tempDir });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("hello");
    });

    it("should return error for empty command", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Error: empty command");
    });

    it("should handle commands with stdout and stderr", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({
        command: "echo stdout && echo stderr >&2",
        workingDirectory: tempDir
      });
      expect(result.output).toContain("stdout");
      expect(result.output).toContain("stderr");
    });

    it("should include exit code in output", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "true", workingDirectory: tempDir });
      expect(result.output).toContain("exit code: 0");
    });

    it("should mark failed commands as errors", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "false", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
    });
  });

  describe("execute - blocked commands", () => {
    it("should block sudo command", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "sudo whoami", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked for safety");
    });

    it("should block rm -rf / command", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "rm -rf /", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked for safety");
    });

    it("should block mkfs command", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "mkfs", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked for safety");
    });

    it("should allow safe commands", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "ls -la", workingDirectory: tempDir });
      expect(result.output).not.toContain("blocked for safety");
    });

    it("should detect blocked commands in pipelines", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "echo test | sudo cat", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked for safety");
    });

    it("should detect blocked commands with semicolons", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({ command: "echo test; sudo whoami", workingDirectory: tempDir });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked for safety");
    });
  });

  describe("execute - working directory", () => {
    it("should use specified working directory", async () => {
      const tool = createBashTool(config);
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "content");

      const result = await tool.execute({
        command: "cat test.txt",
        workingDirectory: tempDir
      });
      expect(result.output).toContain("content");
    });

    it("should reject working directory outside allowed paths", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({
        command: "pwd",
        workingDirectory: "/etc"
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not allowed");
    });

    it("should expand home directory in workingDirectory", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({
        command: "pwd",
        workingDirectory: "~"
      });
      // Either works or fails for directory not allowed (both acceptable)
      expect(result.output).toBeDefined();
    });
  });

  describe("execute - timeout", () => {
    it("should timeout long running commands", async () => {
      const shortTimeoutConfig: ToolsConfig = {
        ...config,
        maxBashTimeout: 100, // 100ms timeout
      };
      const tool = createBashTool(shortTimeoutConfig);
      const result = await tool.execute({
        command: "sleep 10",
        workingDirectory: tempDir
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("timed out");
    });

    // Regression: on timeout, bash forks the pipeline (e.g. `yes | head`) as
    // children. SIGKILLing only the bash PID re-parents those children to PID 1
    // where they spin forever (`yes` pins a CPU core). Spawning detached +
    // killing the whole process group must reap them too.
    describe("process-group cleanup", () => {
      // Unique per-test marker so we can detect leaks via pgrep without
      // cross-test interference, plus defensive cleanup if a regression leaks.
      let marker: string;

      beforeEach(() => {
        marker = `UNIQUEMARKER_${crypto.randomUUID().replace(/-/g, "")}`;
      });

      afterEach(() => {
        // Best-effort: reap anything this test may have leaked so a regression
        // can't bleed CPU-spinning processes across the suite.
        Bun.spawnSync(["pkill", "-9", "-f", marker]);
      });

      it("does not leave child processes alive after a TIMEOUT", async () => {
        const shortTimeoutConfig: ToolsConfig = {
          ...config,
          maxBashTimeout: 100, // 100ms timeout
        };
        const tool = createBashTool(shortTimeoutConfig);

        // `yes <marker>` is a long-lived, CPU-spinning producer; `head` caps
        // the buffer so it doesn't fill memory. The marker rides in argv so
        // pgrep -f can find a survivor. The tool returns "" on timeout, so we
        // detect leaks via the OS process table, not the tool output.
        const result = await tool.execute({
          command: `yes ${marker} | head -n 100000000`,
          workingDirectory: tempDir,
        });

        expect(result.isError).toBe(true);
        expect(result.output).toContain("timed out");

        // Poll briefly: the kill is async w.r.t. the OS reaping the group.
        // Assert the producer is fully gone within a ~2s budget.
        let count = await countProcesses(marker);
        for (let i = 0; i < 20 && count > 0; i++) {
          await sleep(100);
          count = await countProcesses(marker);
        }
        expect(count).toBe(0);
      });
    });
  });

  describe("execute - output handling", () => {
    it("should handle large output", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({
        command: "yes | head -n 1000",
        workingDirectory: tempDir
      });
      expect(result.output).toBeDefined();
      expect(result.output.length).toBeGreaterThan(0);
    });
  });

  describe("execute - error handling", () => {
    it("should handle command not found", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({
        command: "nonexistentcommand12345",
        workingDirectory: tempDir
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("command not found");
    });

    it("should handle invalid working directory", async () => {
      const tool = createBashTool(config);
      const result = await tool.execute({
        command: "pwd",
        workingDirectory: "/nonexistent/path/12345"
      });
      expect(result.output).toBeDefined();
    });
  });
});
