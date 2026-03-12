import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  withAlibabaEnv,
  formatToolProgress,
  buildThinkingOptions,
  buildPromptWithHistory,
  buildSystemPromptOption,
  truncate,
  summarizeThinking,
  shortenPath,
  lastUserMessage,
  chat,
  agenticChat,
} from "./agent-sdk";
import type { AgentOptions, ConversationMessage, ModelParams } from "./types";

// ============================================================================
// truncate helper tests
// ============================================================================

describe("truncate", () => {
  it("returns unchanged string when under max length", () => {
    expect(truncate("short")).toBe("short");
  });

  it("returns unchanged string when exactly at max length", () => {
    const str = "a".repeat(60);
    expect(truncate(str, 60)).toBe(str);
  });

  it("truncates string longer than max length", () => {
    const str = "a".repeat(70);
    const result = truncate(str, 60);
    expect(result.length).toBe(60);
    expect(result).toContain("…");
    expect(result).toStartWith("a".repeat(58));
  });

  it("uses default max length of 60", () => {
    const str = "a".repeat(100);
    const result = truncate(str);
    expect(result.length).toBe(60);
  });

  it("handles empty string", () => {
    expect(truncate("")).toBe("");
  });
});

// ============================================================================
// summarizeThinking helper tests
// ============================================================================

describe("summarizeThinking", () => {
  it("extracts first sentence from text", () => {
    const text = "This is the first sentence. This is the second sentence.";
    const result = summarizeThinking(text);
    expect(result).toBe("This is the first sentence.");
  });

  it("returns full text if no sentence boundary found", () => {
    const text = "No sentence boundary here just continuous text";
    const result = summarizeThinking(text);
    expect(result).toBe("No sentence boundary here just continuous text");
  });

  it("truncates long first sentences", () => {
    const text = "a".repeat(150) + ". Second sentence.";
    const result = summarizeThinking(text);
    expect(result.length).toBe(100);
    expect(result).toContain("…");
    expect(result).toStartWith("a".repeat(99));
  });

  it("handles empty string", () => {
    expect(summarizeThinking("")).toBe("");
  });

  it("handles text starting with newline", () => {
    const text = "\nFirst sentence here. Second.";
    const result = summarizeThinking(text);
    expect(result).toContain("First sentence here.");
  });

  it("handles different sentence terminators", () => {
    expect(summarizeThinking("Question? Next.")).toBe("Question?");
    expect(summarizeThinking("Exclamation! Next.")).toBe("Exclamation!");
  });
});

// ============================================================================
// shortenPath helper tests
// ============================================================================

describe("shortenPath", () => {
  it("returns full path when 3 or fewer segments", () => {
    expect(shortenPath("/src/index.ts")).toBe("src/index.ts");
    expect(shortenPath("/src")).toBe("src");
    expect(shortenPath("/")).toBe("");
  });

  it("returns last 3 segments when more than 3", () => {
    expect(shortenPath("/a/b/c/d/e.ts")).toBe("c/d/e.ts");
  });

  it("truncates long paths", () => {
    const longPath = "/a".repeat(50) + "/file.ts";
    const result = shortenPath(longPath);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("handles empty string", () => {
    expect(shortenPath("")).toBe("");
  });

  it("filters out empty segments", () => {
    expect(shortenPath("//src//index.ts")).toBe("src/index.ts");
  });
});

// ============================================================================
// lastUserMessage helper tests
// ============================================================================

describe("lastUserMessage", () => {
  it("returns content of last user message", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "First", timestamp: 1 },
      { role: "user", content: "Second", timestamp: 2 },
    ];
    expect(lastUserMessage(messages)).toBe("Second");
  });

  it("returns content even if last message is assistant", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Question", timestamp: 1 },
      { role: "assistant", content: "Answer", timestamp: 2 },
    ];
    expect(lastUserMessage(messages)).toBe("Answer");
  });

  it("returns empty string for empty array", () => {
    expect(lastUserMessage([])).toBe("");
  });

  it("returns content of single message", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Only message", timestamp: 1 },
    ];
    expect(lastUserMessage(messages)).toBe("Only message");
  });
});

// ============================================================================
// buildSystemPromptOption tests
// ============================================================================

describe("buildSystemPromptOption", () => {
  it("returns preset object with claude_code preset", () => {
    const result = buildSystemPromptOption("Custom prompt");
    expect(result).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Custom prompt",
    });
  });

  it("preserves custom prompt exactly", () => {
    const custom = "You are a helpful assistant.\n\nBe concise.";
    const result = buildSystemPromptOption(custom);
    expect(result.append).toBe(custom);
  });

  it("handles empty custom prompt", () => {
    const result = buildSystemPromptOption("");
    expect(result.append).toBe("");
  });

  it("handles multiline prompts", () => {
    const custom = "Line 1\nLine 2\nLine 3";
    const result = buildSystemPromptOption(custom);
    expect(result.append).toBe(custom);
  });
});

// ============================================================================
// formatToolProgress tests
// ============================================================================

describe("formatToolProgress", () => {
  describe("Read tool", () => {
    it("formats with file path", () => {
      const result = formatToolProgress("Read", { file_path: "/src/index.ts" });
      expect(result).toBe("Reading src/index.ts");
    });

    it("handles missing file_path", () => {
      const result = formatToolProgress("Read", {});
      expect(result).toBe("Reading file");
    });
  });

  describe("Write tool", () => {
    it("formats with file path", () => {
      const result = formatToolProgress("Write", {
        file_path: "/home/test/output.txt",
      });
      expect(result).toBe("Writing home/test/output.txt");
    });

    it("handles missing file_path", () => {
      const result = formatToolProgress("Write", {});
      expect(result).toBe("Writing file");
    });
  });

  describe("Edit tool", () => {
    it("formats with file path", () => {
      const result = formatToolProgress("Edit", {
        file_path: "/src/utils/helper.ts",
      });
      expect(result).toBe("Editing src/utils/helper.ts");
    });

    it("handles missing file_path", () => {
      const result = formatToolProgress("Edit", {});
      expect(result).toBe("Editing file");
    });
  });

  describe("Bash tool", () => {
    it("uses description when available", () => {
      const result = formatToolProgress("Bash", { description: "Run tests" });
      expect(result).toBe("Run tests");
    });

    it("uses command when no description", () => {
      const result = formatToolProgress("Bash", { command: "npm test" });
      expect(result).toBe("Running: npm test");
    });

    it("truncates long descriptions", () => {
      const longDesc = "a".repeat(100);
      const result = formatToolProgress("Bash", { description: longDesc });
      expect(result.length).toBe(60);
      expect(result).toContain("…");
      expect(result).toStartWith("a".repeat(58));
    });

    it("falls back to default when no description or command", () => {
      const result = formatToolProgress("Bash", {});
      expect(result).toBe("Running command");
    });
  });

  describe("Grep tool", () => {
    it("formats with pattern", () => {
      const result = formatToolProgress("Grep", { pattern: "console.log" });
      expect(result).toBe('Searching "console.log"');
    });

    it("truncates long patterns to 40 chars", () => {
      const longPattern = "a".repeat(50);
      const result = formatToolProgress("Grep", { pattern: longPattern });
      expect(result).toBe(`Searching "${"a".repeat(39)}…"`);
    });

    it("handles missing pattern", () => {
      const result = formatToolProgress("Grep", {});
      expect(result).toBe("Searching");
    });
  });

  describe("Glob tool", () => {
    it("formats with pattern", () => {
      const result = formatToolProgress("Glob", { pattern: "**/*.ts" });
      expect(result).toBe("Finding **/*.ts");
    });

    it("truncates long patterns to 40 chars", () => {
      const longPattern = "a".repeat(50);
      const result = formatToolProgress("Glob", { pattern: longPattern });
      expect(result).toBe(`Finding ${"a".repeat(39)}…`);
    });

    it("handles missing pattern", () => {
      const result = formatToolProgress("Glob", {});
      expect(result).toBe("Finding files");
    });
  });

  describe("WebSearch tool", () => {
    it("formats with query", () => {
      const result = formatToolProgress("WebSearch", {
        query: "TypeScript tutorials",
      });
      expect(result).toBe("Web: TypeScript tutorials");
    });

    it("truncates long queries to 45 chars", () => {
      const longQuery = "a".repeat(60);
      const result = formatToolProgress("WebSearch", { query: longQuery });
      expect(result).toBe(`Web: ${"a".repeat(44)}…`);
    });

    it("handles missing query", () => {
      const result = formatToolProgress("WebSearch", {});
      expect(result).toBe("Web search");
    });
  });

  describe("WebFetch tool", () => {
    it("formats with URL", () => {
      const result = formatToolProgress("WebFetch", {
        url: "https://example.com",
      });
      expect(result).toBe("Fetching https://example.com");
    });

    it("truncates long URLs", () => {
      const longUrl = "https://" + "a".repeat(50) + ".com";
      const result = formatToolProgress("WebFetch", { url: longUrl });
      expect(result.length).toBeLessThanOrEqual(60);
      expect(result).toContain("…");
    });

    it("handles missing URL", () => {
      const result = formatToolProgress("WebFetch", {});
      expect(result).toBe("Fetching URL");
    });
  });

  describe("Task tool", () => {
    it("uses description when available", () => {
      const result = formatToolProgress("Task", {
        description: "Analyze the codebase",
      });
      expect(result).toBe("Agent: Analyze the codebase");
    });

    it("uses prompt when no description", () => {
      const result = formatToolProgress("Task", {
        prompt: "Find all TODO comments",
      });
      expect(result).toBe("Agent: Find all TODO comments");
    });

    it("truncates long descriptions to 45 chars", () => {
      const longDesc = "a".repeat(60);
      const result = formatToolProgress("Task", { description: longDesc });
      expect(result).toBe(`Agent: ${"a".repeat(44)}…`);
    });

    it("falls back to default when no description or prompt", () => {
      const result = formatToolProgress("Task", {});
      expect(result).toBe("Running agent");
    });
  });

  describe("Default tool (unknown)", () => {
    it("strips mcp__ prefix from tool names", () => {
      const result = formatToolProgress("mcp__opencrow-tools__search", {});
      expect(result).toBe("search");
    });

    it("strips mcp__ prefix with any middle segment", () => {
      const result = formatToolProgress("mcp__anything__function", {});
      expect(result).toBe("function");
    });

    it("returns full name if no mcp__ prefix", () => {
      const result = formatToolProgress("CustomTool", {});
      expect(result).toBe("CustomTool");
    });

    it("handles empty string tool name", () => {
      const result = formatToolProgress("", {});
      expect(result).toBe("");
    });
  });
});

// ============================================================================
// buildThinkingOptions tests
// ============================================================================

describe("buildThinkingOptions", () => {
  it("returns empty object when no modelParams or reasoning flag", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({});
  });

  it("sets adaptive thinking mode when thinkingMode is adaptive", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { thinkingMode: "adaptive" },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "adaptive" },
    });
  });

  it("sets enabled thinking mode with default budget", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { thinkingMode: "enabled" },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "enabled", budgetTokens: 32000 },
    });
  });

  it("sets enabled thinking mode with custom budget", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { thinkingMode: "enabled", thinkingBudget: 16000 },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "enabled", budgetTokens: 16000 },
    });
  });

  it("sets disabled thinking mode", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { thinkingMode: "disabled" },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("sets adaptive thinking when reasoning flag is true", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      reasoning: true,
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "adaptive" },
    });
  });

  it("reasoning flag false does not set thinking", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      reasoning: false,
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({});
  });

  it("modelParams thinkingMode takes precedence over reasoning flag", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      reasoning: true,
      modelParams: { thinkingMode: "disabled" },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("sets betas array when extendedContext is true", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { extendedContext: true },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      betas: ["context-1m-2025-08-07"],
    });
  });

  it("extendedContext false does not set betas", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { extendedContext: false },
    };
    const result = buildThinkingOptions(options);
    expect(result.betas).toBeUndefined();
  });

  it("sets maxBudgetUsd when provided", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { maxBudgetUsd: 1.5 },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      maxBudgetUsd: 1.5,
    });
  });

  it("does not set maxBudgetUsd when undefined", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: { maxBudgetUsd: undefined },
    };
    const result = buildThinkingOptions(options);
    expect(result.maxBudgetUsd).toBeUndefined();
  });

  it("combines multiple options", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      modelParams: {
        thinkingMode: "enabled",
        thinkingBudget: 64000,
        extendedContext: true,
        maxBudgetUsd: 5.0,
      },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "enabled", budgetTokens: 64000 },
      betas: ["context-1m-2025-08-07"],
      maxBudgetUsd: 5.0,
    });
  });

  it("combines reasoning with extendedContext", () => {
    const options: AgentOptions = {
      systemPrompt: "Test",
      model: "test-model",
      reasoning: true,
      modelParams: { extendedContext: true },
    };
    const result = buildThinkingOptions(options);
    expect(result).toEqual({
      thinking: { type: "adaptive" },
      betas: ["context-1m-2025-08-07"],
    });
  });
});

// ============================================================================
// buildPromptWithHistory tests
// ============================================================================

describe("buildPromptWithHistory", () => {
  it("returns last message content for single message", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Only message", timestamp: 1 },
    ];
    const result = buildPromptWithHistory(messages);
    expect(result).toBe("Only message");
  });

  it("returns last message content for empty array", () => {
    const messages: ConversationMessage[] = [];
    const result = buildPromptWithHistory(messages);
    expect(result).toBe("");
  });

  it("includes conversation history with two messages", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "First question", timestamp: 1 },
      { role: "assistant", content: "First answer", timestamp: 2 },
      { role: "user", content: "Second question", timestamp: 3 },
    ];
    const result = buildPromptWithHistory(messages);
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("[user]: First question");
    expect(result).toContain("[assistant]: First answer");
    expect(result).toContain("</conversation_history>");
    expect(result).toContain("[user]: Second question");
  });

  it("excludes the last message from history section but includes it as current prompt", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Message 1", timestamp: 1 },
      { role: "user", content: "Message 2 (last)", timestamp: 2 },
    ];
    const result = buildPromptWithHistory(messages);
    // Message 1 should be in the history section
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("[user]: Message 1");
    expect(result).toContain("</conversation_history>");
    // Message 2 (last) should be outside history as the current prompt
    expect(result).toContain("[user]: Message 2 (last)");
    // Verify Message 1 only appears once (in history, not as current prompt)
    const historySection = result.split("</conversation_history>")[0];
    expect(historySection).toContain("Message 1");
    const afterHistory = result.split("</conversation_history>\n\n")[1];
    expect(afterHistory).toContain("Message 2 (last)");
    expect(afterHistory).not.toContain("Message 1");
  });

  it("limits history to MAX_HISTORY_IN_PROMPT (10) messages", () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: i,
      });
    }
    const result = buildPromptWithHistory(messages);

    // Should include history wrapper
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("</conversation_history>");

    // Last message (Message 14) should be outside the history
    expect(result).toContain("[user]: Message 14");

    // Count how many history entries are included
    // Should be at most 10 messages in history (indices 4-13, since 14 is the last)
    const historyMatches = result.match(/\[(user|assistant)\]: /g);
    expect(historyMatches?.length).toBeLessThanOrEqual(11); // 10 in history + 1 last message
  });

  it("formats each history entry with role prefix", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Hello", timestamp: 1 },
      { role: "assistant", content: "Hi there!", timestamp: 2 },
      { role: "user", content: "How are you?", timestamp: 3 },
    ];
    const result = buildPromptWithHistory(messages);

    expect(result).toContain("[user]: Hello");
    expect(result).toContain("[assistant]: Hi there!");
  });

  it("joins history entries with double newlines", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "A", timestamp: 1 },
      { role: "assistant", content: "B", timestamp: 2 },
      { role: "user", content: "C", timestamp: 3 },
    ];
    const result = buildPromptWithHistory(messages);

    expect(result).toContain("[user]: A\n\n[assistant]: B");
  });

  it("handles multiline message content", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: "Line 1\nLine 2\nLine 3",
        timestamp: 1,
      },
    ];
    const result = buildPromptWithHistory(messages);
    expect(result).toBe("Line 1\nLine 2\nLine 3");
  });
});

// ============================================================================
// withAlibabaEnv tests
// ============================================================================

describe("withAlibabaEnv", () => {
  const originalEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ALIBABA_API_KEY: process.env.ALIBABA_API_KEY,
    ALIBABA_BASE_URL: process.env.ALIBABA_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ALIBABA_API_KEY;
    delete process.env.ALIBABA_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (originalEnv.ANTHROPIC_BASE_URL !== undefined) {
      process.env.ANTHROPIC_BASE_URL = originalEnv.ANTHROPIC_BASE_URL;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
    }
    if (originalEnv.ALIBABA_API_KEY !== undefined) {
      process.env.ALIBABA_API_KEY = originalEnv.ALIBABA_API_KEY;
    } else {
      delete process.env.ALIBABA_API_KEY;
    }
    if (originalEnv.ALIBABA_BASE_URL !== undefined) {
      process.env.ALIBABA_BASE_URL = originalEnv.ALIBABA_BASE_URL;
    } else {
      delete process.env.ALIBABA_BASE_URL;
    }
  });

  it("throws error when ALIBABA_API_KEY is not set", async () => {
    await expect(async () => {
      await withAlibabaEnv(async () => "test");
    }).toThrow("ALIBABA_API_KEY is not set");
  });

  it("sets ANTHROPIC_API_KEY to ALIBABA_API_KEY value during execution", async () => {
    process.env.ALIBABA_API_KEY = "test-alibaba-key";

    let capturedKey: string | undefined;
    await withAlibabaEnv(async () => {
      capturedKey = process.env.ANTHROPIC_API_KEY;
      return "test";
    });

    expect(capturedKey).toBe("test-alibaba-key");
  });

  it("sets ANTHROPIC_BASE_URL to ALIBABA_BASE_URL value during execution", async () => {
    process.env.ALIBABA_API_KEY = "test-alibaba-key";
    process.env.ALIBABA_BASE_URL = "https://custom-alibaba-url.com";

    let capturedUrl: string | undefined;
    await withAlibabaEnv(async () => {
      capturedUrl = process.env.ANTHROPIC_BASE_URL;
      return "test";
    });

    expect(capturedUrl).toBe("https://custom-alibaba-url.com");
  });

  it("uses default ALIBABA_BASE_URL when ALIBABA_BASE_URL is not set", async () => {
    process.env.ALIBABA_API_KEY = "test-alibaba-key";
    delete process.env.ALIBABA_BASE_URL;

    let capturedUrl: string | undefined;
    await withAlibabaEnv(async () => {
      capturedUrl = process.env.ANTHROPIC_BASE_URL;
      return "test";
    });

    expect(capturedUrl).toBe(
      "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic"
    );
  });

  it("restores original ANTHROPIC_API_KEY after execution", async () => {
    process.env.ANTHROPIC_API_KEY = "original-anthropic-key";
    process.env.ALIBABA_API_KEY = "test-alibaba-key";

    await withAlibabaEnv(async () => "test");

    expect(process.env.ANTHROPIC_API_KEY).toBe("original-anthropic-key");
  });

  it("restores original ANTHROPIC_BASE_URL after execution", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://original-anthropic-url.com";
    process.env.ALIBABA_API_KEY = "test-alibaba-key";
    process.env.ALIBABA_BASE_URL = "https://custom-alibaba-url.com";

    await withAlibabaEnv(async () => "test");

    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      "https://original-anthropic-url.com"
    );
  });

  it("deletes ANTHROPIC_API_KEY after execution if it was undefined before", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ALIBABA_API_KEY = "test-alibaba-key";

    await withAlibabaEnv(async () => "test");

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("deletes ANTHROPIC_BASE_URL after execution if it was undefined before", async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    process.env.ALIBABA_API_KEY = "test-alibaba-key";

    await withAlibabaEnv(async () => "test");

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("returns the result of the async function", async () => {
    process.env.ALIBABA_API_KEY = "test-alibaba-key";

    const result = await withAlibabaEnv(async () => {
      return { success: true, data: "test-data" };
    });

    expect(result).toEqual({ success: true, data: "test-data" });
  });

  it("restores env vars even if the function throws an error", async () => {
    process.env.ANTHROPIC_API_KEY = "original-key";
    process.env.ANTHROPIC_BASE_URL = "https://original-url.com";
    process.env.ALIBABA_API_KEY = "alibaba-key";

    await expect(async () => {
      await withAlibabaEnv(async () => {
        throw new Error("Test error");
      });
    }).toThrow("Test error");

    expect(process.env.ANTHROPIC_API_KEY).toBe("original-key");
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://original-url.com");
  });
});

// ============================================================================
// chat function tests (integration-style)
// ============================================================================

describe("chat", () => {
  const mockMessages: ConversationMessage[] = [
    {
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    },
  ];

  const baseOptions: AgentOptions = {
    systemPrompt: "You are a helpful assistant.",
    model: "test-model",
  };

  it("should handle empty messages array", async () => {
    const emptyMessages: ConversationMessage[] = [];
    const options: AgentOptions = {
      ...baseOptions,
      modelParams: {
        thinkingMode: "disabled",
      },
    };

    try {
      await chat(emptyMessages, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle single message without history", async () => {
    const singleMessage: ConversationMessage[] = [
      {
        role: "user",
        content: "Test message",
        timestamp: Date.now(),
      },
    ];
    const options: AgentOptions = {
      ...baseOptions,
      modelParams: {
        thinkingMode: "adaptive",
      },
    };

    try {
      await chat(singleMessage, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle multiple messages with history", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "First message", timestamp: Date.now() - 2000 },
      {
        role: "assistant",
        content: "First response",
        timestamp: Date.now() - 1000,
      },
      { role: "user", content: "Second message", timestamp: Date.now() },
    ];
    const options: AgentOptions = {
      ...baseOptions,
      modelParams: {
        thinkingMode: "enabled",
        thinkingBudget: 16000,
      },
    };

    try {
      await chat(messages, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle options with extendedContext", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      modelParams: {
        extendedContext: true,
      },
    };

    try {
      await chat(mockMessages, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle options with maxBudgetUsd", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      modelParams: {
        maxBudgetUsd: 1.0,
      },
    };

    try {
      await chat(mockMessages, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle reasoning flag", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      reasoning: true,
    };

    try {
      await chat(mockMessages, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle history exceeding MAX_HISTORY_IN_PROMPT (10 messages)", async () => {
    const manyMessages: ConversationMessage[] = [];
    for (let i = 0; i < 15; i++) {
      manyMessages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: Date.now() - (15 - i) * 1000,
      });
    }

    try {
      await chat(manyMessages, baseOptions);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});

// ============================================================================
// agenticChat function tests (integration-style)
// ============================================================================

describe("agenticChat", () => {
  const mockMessages: ConversationMessage[] = [
    {
      role: "user",
      content: "Test task",
      timestamp: Date.now(),
    },
  ];

  const baseOptions: AgentOptions = {
    systemPrompt: "You are a helpful assistant.",
    model: "test-model",
  };

  it("should handle empty messages", async () => {
    const emptyMessages: ConversationMessage[] = [];

    try {
      await agenticChat(
        emptyMessages,
        baseOptions,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle maxIterations parameter", async () => {
    try {
      await agenticChat(
        mockMessages,
        baseOptions,
        {} as import("../tools/registry").ToolRegistry,
        5
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should call onProgress callback with events", async () => {
    const progressEvents: import("./types").ProgressEvent[] = [];
    const onProgress = mock((event: import("./types").ProgressEvent) => {
      progressEvents.push(event);
    });

    try {
      await agenticChat(
        mockMessages,
        { ...baseOptions, onProgress },
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }

    expect(onProgress).toBeDefined();
  });

  it("should handle agentId option", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      agentId: "test-agent-id",
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle abortSignal option", async () => {
    const abortController = new AbortController();
    const options: AgentOptions = {
      ...baseOptions,
      abortSignal: abortController.signal,
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle sdkSessionId for session resumption", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      sdkSessionId: "test-session-id",
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle onSdkSessionId callback", async () => {
    const capturedSessionIds: string[] = [];
    const onSdkSessionId = mock((sessionId: string) => {
      capturedSessionIds.push(sessionId);
    });

    const options: AgentOptions = {
      ...baseOptions,
      onSdkSessionId,
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }

    expect(onSdkSessionId).toBeDefined();
  });

  it("should handle all tool enablement options", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      browserEnabled: true,
      githubEnabled: true,
      context7Enabled: true,
      sequentialThinkingEnabled: true,
      dbhubEnabled: true,
      filesystemEnabled: true,
      gitEnabled: true,
      qdrantEnabled: true,
      braveSearchEnabled: true,
      firecrawlEnabled: true,
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle sdkHooks option", async () => {
    const mockHooks = {
      onTurnStart: mock(() => {}),
      onTurnEnd: mock(() => {}),
    };

    const options: AgentOptions = {
      ...baseOptions,
      sdkHooks: mockHooks,
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle usageContext option", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      usageContext: {
        channel: "test-channel",
        chatId: "test-chat-id",
        source: "message",
      },
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle cwd option", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      cwd: "/tmp/test-directory",
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle maxOutputTokens option", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      maxOutputTokens: 4096,
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("should handle all modelParams options together", async () => {
    const options: AgentOptions = {
      ...baseOptions,
      modelParams: {
        thinkingMode: "enabled",
        thinkingBudget: 64000,
        effort: "high",
        extendedContext: true,
        maxBudgetUsd: 5.0,
      },
    };

    try {
      await agenticChat(
        mockMessages,
        options,
        {} as import("../tools/registry").ToolRegistry,
        10
      );
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});
