/**
 * ask_user — Pause execution and ask the user a question.
 *
 * The tool sends the question to the user's chat, blocks until
 * they reply, and returns their answer as the tool result.
 *
 * Supports optional choices (rendered as inline keyboard buttons on Telegram).
 * Times out after 5 minutes by default.
 */
import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { MessageContent, InlineButton } from "../channels/types";
import { getQuestionBus } from "../agent/question-bus";
import { createLogger } from "../logger";

import { getErrorMessage } from "../lib/error-serialization";
const log = createLogger("tool:ask-user");

export interface AskUserToolConfig {
  /** The chat ID to send questions to (bound at creation time) */
  readonly chatId: string;
  /** Send a message to the user (via the active channel) */
  readonly sendMessage: (content: MessageContent) => Promise<void>;
}

export function createAskUserTool(config: AskUserToolConfig): ToolDefinition {
  const { chatId, sendMessage } = config;

  return {
    name: "ask_user",
    description:
      "Ask the user a question and wait for their response. " +
      "Use this when you need clarification, approval, or a decision before proceeding. " +
      "Provide clear, specific questions. Optionally include choices for the user to pick from. " +
      "The tool will block until the user replies (up to 5 minutes).",
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question to ask. Be specific and concise. " +
            "Include context about why you're asking.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of choices. If provided, the user sees clickable buttons " +
            "(on Telegram) or numbered options. Keep to 2-5 options.",
        },
        timeout_seconds: {
          type: "number",
          description:
            "How long to wait for a response in seconds. Default: 300 (5 minutes). Max: 600.",
        },
      },
      required: ["question"],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const question = String(input.question ?? "").trim();
      if (!question) {
        return { output: "Error: question is required", isError: true };
      }

      const options = Array.isArray(input.options)
        ? input.options.map(String).filter(Boolean)
        : undefined;

      const rawTimeout = Number(input.timeout_seconds) || 300;
      const timeoutMs = Math.min(Math.max(rawTimeout, 0.1), 600) * 1000;

      // Build the message content
      const messageText = `❓ ${question}`;
      const content: MessageContent =
        options && options.length > 0
          ? {
              text: messageText,
              // Each option is a button in its own row
              inlineButtons: options.map(
                (opt): readonly InlineButton[] => [
                  { label: opt, callbackData: opt },
                ],
              ),
            }
          : { text: messageText };

      try {
        // Send the question to the user
        await sendMessage(content);

        // Wait for the answer via the question bus
        const bus = getQuestionBus();
        const answer = await bus.ask(chatId, question, options, timeoutMs);

        // If the user clicked a button (answer matches an option), report it
        if (options && options.length > 0) {
          const optIndex = options.indexOf(answer);
          if (optIndex !== -1) {
            return {
              output: `User selected: "${options[optIndex]}"`,
              isError: false,
            };
          }
          // Also support numeric replies (for non-Telegram channels)
          const num = parseInt(answer.trim(), 10);
          if (num >= 1 && num <= options.length) {
            const selected = options[num - 1]!;
            return {
              output: `User selected option ${num}: "${selected}"`,
              isError: false,
            };
          }
        }

        return {
          output: `User responded: "${answer}"`,
          isError: false,
        };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.warn("ask_user failed", { chatId, error: msg });
        return {
          output: `Failed to get user response: ${msg}`,
          isError: true,
        };
      }
    },
  };
}
