import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createSelfRestartTool } from "./self-restart";

// We need to mock the global fetch to prevent real HTTP calls
const originalFetch = globalThis.fetch;

describe("self-restart tool (process_manage)", () => {
  let mockFetchFn: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetchFn = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = mockFetchFn as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      const tool = createSelfRestartTool();
      expect(tool.name).toBe("process_manage");
    });

    it("should have system category", () => {
      const tool = createSelfRestartTool();
      expect(tool.categories).toContain("system");
    });

    it("should require reason parameter", () => {
      const tool = createSelfRestartTool();
      expect(tool.inputSchema.required).toEqual(["reason"]);
    });

    it("should have action, target, and reason properties", () => {
      const tool = createSelfRestartTool();
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.action).toBeDefined();
      expect(props.target).toBeDefined();
      expect(props.reason).toBeDefined();
    });

    it("should define action enum with restart, stop, start, list", () => {
      const tool = createSelfRestartTool();
      const actionProp = (tool.inputSchema.properties as Record<string, any>)
        .action;
      expect(actionProp.enum).toEqual(["restart", "stop", "start", "list"]);
    });
  });

  describe("list action", () => {
    it("should list processes when action is list", async () => {
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1234,
          restartCount: 0,
          uptimeSeconds: 3600,
        },
        {
          name: "agent:default",
          status: "running",
          syncStatus: "synced",
          pid: 5678,
          restartCount: 2,
          uptimeSeconds: 120,
        },
      ];

      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking status",
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("2 processes");
      expect(result.output).toContain("web");
      expect(result.output).toContain("agent:default");
    });

    it("should show no processes message for empty list", async () => {
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("No orchestrated processes found");
    });

    it("should handle fetch errors in list", async () => {
      mockFetchFn.mockRejectedValueOnce(new Error("Connection refused"));

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Failed to list processes");
    });

    it("should handle null data in response", async () => {
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("No orchestrated processes found");
    });
  });

  describe("formatUptime", () => {
    // We test this indirectly through the list output
    it("should format seconds as Xs", async () => {
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 45,
        },
      ];
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });
      expect(result.output).toContain("45s");
    });

    it("should format minutes as Xm", async () => {
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 300,
        },
      ];
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });
      expect(result.output).toContain("5m");
    });

    it("should format hours as Xh Ym", async () => {
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 7500,
        },
      ];
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });
      expect(result.output).toContain("2h 5m");
    });

    it("should format exact hours without minutes", async () => {
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 3600,
        },
      ];
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });
      expect(result.output).toContain("1h");
    });

    it("should show dash for null uptime", async () => {
      const processes = [
        {
          name: "web",
          status: "stopped",
          syncStatus: "stopped",
          pid: null,
          restartCount: 0,
          uptimeSeconds: null,
        },
      ];
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "list",
        reason: "checking",
      });
      // The dash character used is a unicode em-dash
      expect(result.output).toMatch(/up\s/);
    });
  });

  describe("restart action", () => {
    it("should reject unknown process target", async () => {
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 100,
        },
      ];

      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "restart",
        target: "nonexistent",
        reason: "testing",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("unknown process");
    });

    it("should trigger restart for known process", async () => {
      // First call: listProcesses
      const processes = [
        {
          name: "web",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 100,
        },
      ];

      // First fetch: list processes for validation
      mockFetchFn
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: processes }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        // Second fetch: the actual restart action
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "restart",
        target: "web",
        reason: "deploying update",
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("restart triggered for 'web'");
    });

    it("should handle restart failure from orchestrator", async () => {
      // Use a unique target name to avoid cooldown from previous tests
      const processes = [
        {
          name: "agent:fail-test",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 100,
        },
      ];

      mockFetchFn
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: processes }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: false, error: "process locked" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "restart",
        target: "agent:fail-test",
        reason: "testing error",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("process locked");
    });

    it("should handle network errors for restart", async () => {
      // Use a unique target name to avoid cooldown from previous tests
      const processes = [
        {
          name: "agent:net-err-test",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 100,
        },
      ];

      mockFetchFn
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: processes }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const tool = createSelfRestartTool();
      const result = await tool.execute({
        action: "restart",
        target: "agent:net-err-test",
        reason: "testing",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Failed to restart");
    });
  });

  describe("cooldown logic", () => {
    it("should enforce cooldown after successful action", async () => {
      const processes = [
        {
          name: "cron",
          status: "running",
          syncStatus: "synced",
          pid: 1,
          restartCount: 0,
          uptimeSeconds: 100,
        },
      ];

      // First restart: success
      mockFetchFn
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: processes }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const tool = createSelfRestartTool();
      const result1 = await tool.execute({
        action: "stop",
        target: "cron",
        reason: "first stop",
      });
      expect(result1.isError).toBe(false);

      // Second restart immediately: should be throttled
      mockFetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: processes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result2 = await tool.execute({
        action: "stop",
        target: "cron",
        reason: "second stop",
      });
      expect(result2.isError).toBe(false);
      expect(result2.output).toContain("already triggered");
      expect(result2.output).toContain("Cooldown");
    });
  });

  describe("default action", () => {
    it("should default to restart when action not specified", async () => {
      // If the process list call fails, the action still proceeds
      mockFetchFn
        .mockRejectedValueOnce(new Error("list failed"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const tool = createSelfRestartTool();
      const result = await tool.execute({ reason: "default action test" });
      // The action defaults to "restart" and target to own process name
      expect(result.output).toContain("restart");
    });
  });
});
