import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockQuery = mock(() => Promise.resolve([] as Record<string, unknown>[]));
mock.module("../store/db", () => ({
  getDb: () => mockQuery,
}));

mock.module("../logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const { createSendMessageTool } = await import("./send-message");

describe("send_agent_message tool", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() =>
      Promise.resolve([] as Record<string, unknown>[]),
    );
  });

  describe("tool metadata", () => {
    test("has correct name", () => {
      const tool = createSendMessageTool("test-agent");
      expect(tool.name).toBe("send_agent_message");
    });

    test("requires to_agent_id, topic, payload", () => {
      const tool = createSendMessageTool("test-agent");
      const schema = tool.inputSchema as {
        required: string[];
      };
      expect(schema.required).toContain("to_agent_id");
      expect(schema.required).toContain("topic");
      expect(schema.required).toContain("payload");
    });
  });

  describe("validation", () => {
    test("rejects empty to_agent_id", async () => {
      const tool = createSendMessageTool("test-agent");
      const result = await tool.execute({
        to_agent_id: "",
        topic: "alert",
        payload: "hello",
      });
      expect(result.output).toContain("Error");
    });

    test("rejects empty payload", async () => {
      const tool = createSendMessageTool("test-agent");
      const result = await tool.execute({
        to_agent_id: "other-agent",
        topic: "alert",
        payload: "",
      });
      expect(result.output).toContain("Error");
    });
  });

  describe("successful send", () => {
    test("returns message id on success", async () => {
      let callCount = 0;
      mockQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([{ id: "msg-abc" }] as Record<string, unknown>[]);
        return Promise.resolve([{ count: 1 }] as Record<string, unknown>[]);
      });

      const tool = createSendMessageTool("test-agent");
      const result = await tool.execute({
        to_agent_id: "signal-analyzer",
        topic: "market-alert",
        payload: "BTC dropped 5%",
      });
      expect(result.output).toContain("msg-abc");
      expect(result.output).toContain("signal-analyzer");
    });
  });

  describe("error handling", () => {
    test("handles database errors gracefully", async () => {
      mockQuery.mockImplementation((): Promise<Record<string, unknown>[]> => {
        throw new Error("Connection refused");
      });

      const tool = createSendMessageTool("test-agent");
      const result = await tool.execute({
        to_agent_id: "other",
        topic: "test",
        payload: "hello",
      });
      expect(result.output).toContain("Error");
    });
  });
});
