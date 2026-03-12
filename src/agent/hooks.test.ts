import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
} from "bun:test";
import { buildSdkHooks } from "./hooks";
import { initDb, closeDb } from "../store/db";
import type { ProgressEvent } from "./types";

const agentId = "test-agent";
const sessionId = "test-session";

describe("buildSdkHooks", () => {
  beforeAll(async () => {
    await initDb("postgres://opencrow:opencrow@127.0.0.1:5432/opencrow");
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("basic hook creation", () => {
    it("creates default hooks when no config provided", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });

      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.PostToolUseFailure).toBeDefined();
      expect(hooks.SessionStart).toBeDefined();
      expect(hooks.SessionEnd).toBeDefined();
      expect(hooks.SubagentStart).toBeDefined();
      expect(hooks.SubagentStop).toBeDefined();
      expect(hooks.UserPromptSubmit).toBeDefined();
      expect(hooks.Stop).toBeDefined();
      // Notification only created when onProgress callback provided
      expect(hooks.Notification).toBeUndefined();
    });

    it("creates hooks with correct matcher pattern", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });

      expect(hooks.PreToolUse![0]!.matcher).toBe("Bash");
      expect(hooks.PostToolUse![0]!.matcher).toBe("*");
      expect(hooks.PostToolUseFailure![0]!.matcher).toBe("*");
      expect(hooks.SessionStart![0]!.matcher).toBe("*");
      expect(hooks.SessionEnd![0]!.matcher).toBe("*");
      expect(hooks.SubagentStart![0]!.matcher).toBe("*");
      expect(hooks.SubagentStop![0]!.matcher).toBe("*");
      expect(hooks.UserPromptSubmit![0]!.matcher).toBe("*");
      expect(hooks.Stop![0]!.matcher).toBe("*");
    });

    it("creates hooks with correct agentId", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });

      expect(hooks.PreToolUse![0]!.hooks).toHaveLength(1);
      expect(hooks.PostToolUse![0]!.hooks).toHaveLength(1);
      expect(hooks.PostToolUseFailure![0]!.hooks).toHaveLength(1);
      expect(hooks.SessionStart![0]!.hooks).toHaveLength(1);
      expect(hooks.SessionEnd![0]!.hooks).toHaveLength(1);
      expect(hooks.SubagentStart![0]!.hooks).toHaveLength(1);
      expect(hooks.SubagentStop![0]!.hooks).toHaveLength(1);
      expect(hooks.UserPromptSubmit![0]!.hooks).toHaveLength(1);
      expect(hooks.Stop![0]!.hooks).toHaveLength(1);
    });

    it("disables PreToolUse when dangerousCommandBlocking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: false },
      });

      expect(hooks.PreToolUse).toBeUndefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.SessionStart).toBeDefined();
    });

    it("enables PreToolUse when dangerousCommandBlocking is explicitly true", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });

      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PreToolUse![0]!.matcher).toBe("Bash");
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.SessionStart).toBeDefined();
    });

    it("disables audit log when hooksConfig.auditLog is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { auditLog: false },
      });

      expect(hooks.PostToolUse).toBeUndefined();
      expect(hooks.PostToolUseFailure).toBeUndefined();
      expect(hooks.Stop).toBeDefined();
      // PreToolUse is OFF by default, so still undefined
      expect(hooks.PreToolUse).toBeUndefined();
    });

    it("disables session tracking when sessionTracking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { sessionTracking: false },
      });

      expect(hooks.SessionStart).toBeUndefined();
      expect(hooks.SessionEnd).toBeUndefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.Stop).toBeDefined();
    });

    it("disables subagent tracking when subagentTracking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { subagentTracking: false },
      });

      expect(hooks.SubagentStart).toBeUndefined();
      expect(hooks.SubagentStop).toBeUndefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.Stop).toBeDefined();
    });

    it("disables prompt logging when promptLogging is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { promptLogging: false },
      });

      expect(hooks.UserPromptSubmit).toBeUndefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.Stop).toBeDefined();
    });

    it("creates Notification hook when onProgress callback provided", () => {
      const onProgress = vi.fn();
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { auditLog: false },
        onProgress,
      });
      expect(hooks.Notification).toBeDefined();
    });

    it("creates Notification hook with callback function", () => {
      const onProgress = vi.fn();
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { auditLog: false },
        onProgress,
      });
      expect(hooks.Notification).toBeDefined();
    });
  });

  describe("PostToolUse hook (audit logger)", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.PostToolUse?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.PostToolUse?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        tool_name: "test_tool",
        tool_input: { foo: "bar" },
        tool_response: { result: "ok" },
      });

      expect(result).toEqual({});
    });
  });

  describe("PostToolUseFailure hook (audit failure logger)", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.PostToolUseFailure?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.PostToolUseFailure?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        tool_name: "test_tool",
        tool_input: { foo: "bar" },
        error: "something went wrong",
      });

      expect(result).toEqual({});
    });
  });

  describe("Stop hook", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.Stop?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.Stop?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({});

      expect(result).toEqual({});
    });
  });

  describe("Notification hook", () => {
    it("creates hook with correct structure when onProgress provided", () => {
      const onProgress = vi.fn();
      const hooks = buildSdkHooks({ agentId, sessionId, onProgress });
      const hook = hooks.Notification?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("forwards notification message to onProgress", async () => {
      const onProgress = vi.fn<(event: ProgressEvent) => void>();
      const hooks = buildSdkHooks({ agentId, sessionId, onProgress });
      const hook = hooks.Notification?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({ message: "Test notification" });

      expect(onProgress).toHaveBeenCalledWith({
        type: "thinking",
        agentId,
        summary: "Test notification",
      });
      expect(result).toEqual({});
    });

    it("uses title field when message not provided", async () => {
      const onProgress = vi.fn<(event: ProgressEvent) => void>();
      const hooks = buildSdkHooks({ agentId, sessionId, onProgress });
      const hook = hooks.Notification?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({ title: "Test title" });

      expect(onProgress).toHaveBeenCalledWith({
        type: "thinking",
        agentId,
        summary: "Test title",
      });
      expect(result).toEqual({});
    });

    it("truncates long messages to 100 chars", async () => {
      const onProgress = vi.fn<(event: ProgressEvent) => void>();
      const hooks = buildSdkHooks({ agentId, sessionId, onProgress });
      const hook = hooks.Notification?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const longMessage = "x".repeat(150);
      const result = await hook({ message: longMessage });

      expect(onProgress).toHaveBeenCalledWith({
        type: "thinking",
        agentId,
        summary: "x".repeat(100),
      });
      expect(result).toEqual({});
    });

    it("does not throw when onProgress not provided", async () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { notifications: false },
      });

      // Notification hook should not exist when disabled
      expect(hooks.Notification).toBeUndefined();
    });
  });

  describe("PreToolUse hook (dangerous command blocking)", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });
      const hook = hooks.PreToolUse?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("blocks dangerous rm command", async () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });
      const hook = hooks.PreToolUse?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        tool_name: "Bash",
        tool_input: { command: "rm -rf /etc" },
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            "Blocked dangerous command",
          ),
        },
      });
    });

    it("blocks dangerous dd command", async () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });
      const hook = hooks.PreToolUse?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        tool_name: "Bash",
        tool_input: { command: "dd if=/dev/zero of=/dev/sda" },
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            "Blocked dangerous command",
          ),
        },
      });
    });

    it("allows safe commands", async () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });
      const hook = hooks.PreToolUse?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      });

      expect(result).toEqual({});
    });

    it("only checks Bash tool", async () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: true },
      });
      const hook = hooks.PreToolUse?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        tool_name: "Read",
        tool_input: { file_path: "/etc/passwd" },
      });

      expect(result).toEqual({});
    });

    it("is disabled when dangerousCommandBlocking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { dangerousCommandBlocking: false },
      });

      expect(hooks.PreToolUse).toBeUndefined();
    });
  });

  describe("SessionStart hook", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SessionStart?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SessionStart?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        session_id: sessionId,
        prompt: "Test prompt",
      });

      expect(result).toEqual({});
    });

    it("is disabled when sessionTracking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { sessionTracking: false },
      });

      expect(hooks.SessionStart).toBeUndefined();
    });
  });

  describe("SessionEnd hook", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SessionEnd?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SessionEnd?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        session_id: sessionId,
        result: "Test result",
      });

      expect(result).toEqual({});
    });

    it("is disabled when sessionTracking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { sessionTracking: false },
      });

      expect(hooks.SessionEnd).toBeUndefined();
    });
  });

  describe("SubagentStart hook", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SubagentStart?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SubagentStart?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        subagent_id: "test-subagent",
        task: "Test task",
        session_id: sessionId,
      });

      expect(result).toEqual({});
    });

    it("is disabled when subagentTracking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { subagentTracking: false },
      });

      expect(hooks.SubagentStart).toBeUndefined();
    });
  });

  describe("SubagentStop hook", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SubagentStop?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.SubagentStop?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        subagent_id: "test-subagent",
        result: "Test result",
        status: "completed",
      });

      expect(result).toEqual({});
    });

    it("is disabled when subagentTracking is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { subagentTracking: false },
      });

      expect(hooks.SubagentStop).toBeUndefined();
    });
  });

  describe("UserPromptSubmit hook", () => {
    it("creates hook with correct structure", () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.UserPromptSubmit?.[0]?.hooks?.[0];

      expect(hook).toBeDefined();
      expect(typeof hook).toBe("function");
    });

    it("hook returns empty object", async () => {
      const hooks = buildSdkHooks({ agentId, sessionId });
      const hook = hooks.UserPromptSubmit?.[0]?.hooks?.[0];

      if (!hook) throw new Error("Hook not defined");
      const result = await hook({
        prompt: "Test user prompt",
        session_id: sessionId,
      });

      expect(result).toEqual({});
    });

    it("is disabled when promptLogging is false", () => {
      const hooks = buildSdkHooks({
        agentId,
        sessionId,
        hooksConfig: { promptLogging: false },
      });

      expect(hooks.UserPromptSubmit).toBeUndefined();
    });
  });
});
