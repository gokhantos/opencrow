import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import { sendAgentMessage, getPendingCount } from "../agent/message-bus";
import { createLogger } from "../logger";

const log = createLogger("tool:send-message");

export function createSendMessageTool(agentId: string): ToolDefinition {
  return {
    name: "send_agent_message",
    description:
      "Send an asynchronous message to another agent. " +
      "Use this to notify other agents about events, share findings, or request action. " +
      "The message is delivered asynchronously — the target agent processes it on its next cycle. " +
      "Examples: alert signal-analyzer about a market event, ask idea-validator to review an idea.",
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        to_agent_id: {
          type: "string",
          description: "The ID of the target agent to send the message to.",
        },
        topic: {
          type: "string",
          description:
            "A short topic/category for the message (e.g. 'market-alert', 'review-request', 'data-update').",
        },
        payload: {
          type: "string",
          description:
            "The message content. Include all relevant context the target agent needs to act on this.",
        },
      },
      required: ["to_agent_id", "topic", "payload"],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const toAgentId = String(input.to_agent_id ?? "");
      const topic = String(input.topic ?? "general");
      const payload = String(input.payload ?? "");

      if (!toAgentId) {
        return { output: "Error: to_agent_id is required.", isError: true };
      }
      if (!payload) {
        return { output: "Error: payload is required.", isError: true };
      }

      try {
        const messageId = await sendAgentMessage(
          agentId,
          toAgentId,
          topic,
          payload,
        );

        const pending = await getPendingCount(toAgentId);

        log.info("Agent message sent via tool", {
          from: agentId,
          to: toAgentId,
          topic,
          messageId,
        });

        return {
          output: `Message sent to ${toAgentId} (id: ${messageId}). Topic: ${topic}. ${pending} message(s) pending for that agent.`,
          isError: false,
        };
      } catch (err) {
        log.error("Failed to send agent message", {
          from: agentId,
          to: toAgentId,
          error: err,
        });
        return {
          output: `Error sending message: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
