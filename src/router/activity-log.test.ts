import { describe, test, expect } from "bun:test";
import { createActivityLog } from "./activity-log";
import type { Channel, ChannelName } from "../channels/types";

function createMockChannel(): Channel & {
  sentMessages: string[];
  editedMessages: { messageId: number; text: string }[];
} {
  let nextId = 100;
  const sentMessages: string[] = [];
  const editedMessages: { messageId: number; text: string }[] = [];

  return {
    name: "telegram" as ChannelName,
    sentMessages,
    editedMessages,
    async connect() {},
    async disconnect() {},
    async sendMessage(_chatId, content) {
      sentMessages.push(content.text ?? "");
      return nextId++;
    },
    async editMessage(_chatId, messageId, text) {
      editedMessages.push({ messageId, text });
    },
    async deleteMessage() {},
    async sendTyping() {},
    onMessage() {},
    isConnected() {
      return true;
    },
  };
}

describe("ActivityLog", () => {
  test("start sends initial working message", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    expect(channel.sentMessages).toEqual(["<b>OpenCrow is working...</b>"]);
  });

  test("tool events create entries", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    log.onProgress({
      type: "tool_start",
      agentId: "main",
      tool: "Reading config.ts",
    });
    log.onProgress({
      type: "tool_done",
      agentId: "main",
      tool: "Reading config.ts",
      result: "50 lines",
    });

    await log.finalize();

    const finalEdit = channel.editedMessages.at(-1)!.text;
    expect(finalEdit).toContain("🔧 <code>Reading config.ts</code>");
    expect(finalEdit).toContain("↳ 50 lines");
    expect(finalEdit).toContain("<b>OpenCrow worked on this:</b>");
  });

  test("sub-agent events are indented under parent", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    // Parent tool
    log.onProgress({
      type: "tool_start",
      agentId: "main",
      tool: "Reading config.ts",
    });

    // Sub-agent starts
    log.onProgress({
      type: "subagent_start",
      agentId: "main",
      childAgent: "backend",
      task: "Implement notification endpoint",
    });

    // Sub-agent's own tool events (agentId = "backend")
    log.onProgress({
      type: "tool_start",
      agentId: "backend",
      tool: "Reading api.ts",
    });
    log.onProgress({
      type: "tool_done",
      agentId: "backend",
      tool: "Reading api.ts",
      result: "200 lines",
    });
    log.onProgress({
      type: "tool_start",
      agentId: "backend",
      tool: "Editing api.ts",
    });
    log.onProgress({
      type: "tool_done",
      agentId: "backend",
      tool: "Editing api.ts",
      result: "Applied changes",
    });

    // Sub-agent completes
    log.onProgress({
      type: "complete",
      agentId: "backend",
      durationMs: 5000,
      toolUseCount: 2,
    });
    log.onProgress({
      type: "subagent_done",
      agentId: "main",
      childAgent: "backend",
    });

    await log.finalize();

    const finalEdit = channel.editedMessages.at(-1)!.text;
    const lines = finalEdit.split("\n");

    // Parent tool at indent 0
    expect(lines).toContainEqual("🔧 <code>Reading config.ts</code>");

    // Sub-agent header at indent 0
    expect(
      lines.some(
        (l) =>
          l.includes("🤖") &&
          l.includes("<b>backend</b>") &&
          l.includes("Implement notification"),
      ),
    ).toBe(true);

    // Sub-agent tools indented (2 spaces)
    expect(lines).toContainEqual("  🔧 <code>Reading api.ts</code>");
    expect(lines).toContainEqual("    ↳ 200 lines");
    expect(lines).toContainEqual("  🔧 <code>Editing api.ts</code>");
    expect(lines).toContainEqual("    ↳ Applied changes");

    // Sub-agent done with tool count, indented
    expect(
      lines.some(
        (l) =>
          l.includes("✅") &&
          l.includes("backend done") &&
          l.includes("2 tools"),
      ),
    ).toBe(true);
  });

  test("sub-agent task is truncated when too long", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    const longTask = "A".repeat(100);
    log.onProgress({
      type: "subagent_start",
      agentId: "main",
      childAgent: "backend",
      task: longTask,
    });

    log.onProgress({
      type: "subagent_done",
      agentId: "main",
      childAgent: "backend",
    });

    await log.finalize();

    const finalEdit = channel.editedMessages.at(-1)!.text;
    // Task should be truncated with ellipsis
    expect(finalEdit).toContain("…");
    expect(finalEdit).not.toContain(longTask);
  });

  test("sub-agent complete event does not appear in log", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    log.onProgress({
      type: "subagent_start",
      agentId: "main",
      childAgent: "backend",
      task: "Do stuff",
    });
    log.onProgress({
      type: "complete",
      agentId: "backend",
      durationMs: 1000,
      toolUseCount: 1,
    });
    log.onProgress({
      type: "subagent_done",
      agentId: "main",
      childAgent: "backend",
    });

    await log.finalize();

    const finalEdit = channel.editedMessages.at(-1)!.text;
    // Should not contain sub-agent's "Done in" — only the parent's
    const doneMatches = finalEdit.match(/Done in/g);
    expect(doneMatches?.length).toBe(1);
  });

  test("multiple sub-agents tracked independently", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    // Start two sub-agents
    log.onProgress({
      type: "subagent_start",
      agentId: "main",
      childAgent: "backend",
      task: "API work",
    });
    log.onProgress({
      type: "subagent_start",
      agentId: "main",
      childAgent: "frontend",
      task: "UI work",
    });

    // Backend does 2 tools
    log.onProgress({ type: "tool_start", agentId: "backend", tool: "Read" });
    log.onProgress({ type: "tool_start", agentId: "backend", tool: "Edit" });

    // Frontend does 1 tool
    log.onProgress({ type: "tool_start", agentId: "frontend", tool: "Write" });

    // Both complete
    log.onProgress({
      type: "subagent_done",
      agentId: "main",
      childAgent: "backend",
    });
    log.onProgress({
      type: "subagent_done",
      agentId: "main",
      childAgent: "frontend",
    });

    await log.finalize();

    const finalEdit = channel.editedMessages.at(-1)!.text;
    expect(finalEdit).toContain("backend done · 2 tools");
    expect(finalEdit).toContain("frontend done · 1 tools");
  });

  test("finalize shows error state", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    log.onProgress({
      type: "tool_start",
      agentId: "main",
      tool: "Bash",
    });

    await log.finalize({ error: true });

    const finalEdit = channel.editedMessages.at(-1)!.text;
    expect(finalEdit).toContain("Failed after");
  });

  test("thinking events show at correct indent", async () => {
    const channel = createMockChannel();
    const log = createActivityLog(channel, "chat1");
    await log.start();

    log.onProgress({
      type: "subagent_start",
      agentId: "main",
      childAgent: "architect",
      task: "Design system",
    });

    log.onProgress({
      type: "thinking",
      agentId: "architect",
      summary: "Analyzing requirements",
    });

    log.onProgress({
      type: "subagent_done",
      agentId: "main",
      childAgent: "architect",
    });

    await log.finalize();

    const finalEdit = channel.editedMessages.at(-1)!.text;
    const lines = finalEdit.split("\n");
    // Thinking from sub-agent should be indented (HTML italic)
    expect(lines).toContainEqual("  💭 <i>Analyzing requirements</i>");
  });
});
