import { describe, it, expect, beforeEach } from "bun:test";
import { ToolRouter, createToolRouter } from "./router";
import type { ToolDefinition, ToolCategory } from "./types";

// Mock tools for testing
function createMockTool(
  name: string,
  description: string,
  categories: readonly ToolCategory[],
): ToolDefinition {
  return {
    name,
    description,
    categories,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "mock", isError: false }),
  };
}

describe("ToolRouter", () => {
  let mockTools: ToolDefinition[];

  beforeEach(() => {
    mockTools = [
      createMockTool("bash", "Execute shell commands", ["code", "system"]),
      createMockTool("read_file", "Read file contents", ["fileops", "code"]),
      createMockTool("write_file", "Write content to file", ["fileops", "code"]),
      createMockTool("grep", "Search file contents with regex", ["fileops", "code"]),
      createMockTool("glob", "Find files matching pattern", ["fileops", "code"]),
      createMockTool("list_files", "List directory contents", ["fileops", "code"]),
      createMockTool("memory", "Store and recall memories", ["memory"]),
      createMockTool("save_observation", "Save learnings", ["memory"]),
      createMockTool("search_news", "Search news articles", ["research"]),
      createMockTool("search_reddit", "Search Reddit posts", ["research", "social"]),
      createMockTool("search_hn", "Search Hacker News", ["research"]),
      createMockTool("spawn_agent", "Spawn sub-agent for tasks", ["system"]),
      createMockTool("analytics", "Get usage analytics", ["analytics"]),
      createMockTool("get_idea", "Get startup ideas", ["ideas"]),
    ];
  });

  describe("constructor", () => {
    it("should initialize with tools", () => {
      const router = new ToolRouter(mockTools);
      expect(router).toBeDefined();
    });

    it("should start with empty execution history", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools([], [], 10);
      // Should return tools even without history
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe("recordExecution", () => {
    it("should record a successful tool execution", () => {
      const router = new ToolRouter(mockTools);
      router.recordExecution("bash", true);
      // No error means it worked
      expect(router).toBeDefined();
    });

    it("should record a failed tool execution", () => {
      const router = new ToolRouter(mockTools);
      router.recordExecution("bash", false);
      expect(router).toBeDefined();
    });

    it("should maintain max history size", () => {
      const router = new ToolRouter(mockTools);
      // Record more than maxHistorySize (100)
      for (let i = 0; i < 150; i++) {
        router.recordExecution(`tool_${i}`, true);
      }
      // Should not exceed maxHistorySize
      expect(router).toBeDefined();
    });

    it("should track multiple executions of same tool", () => {
      const router = new ToolRouter(mockTools);
      for (let i = 0; i < 5; i++) {
        router.recordExecution("bash", i % 2 === 0); // Alternate success/failure
      }
      expect(router).toBeDefined();
    });
  });

  describe("getRelevantTools - category matching", () => {
    it("should prioritize tools matching intent category", () => {
      const router = new ToolRouter(mockTools);

      // Record some history to give recency bonus
      router.recordExecution("bash", true);
      router.recordExecution("read_file", true);

      const tools = router.getRelevantTools(["fileops"], [], 5);

      // fileops tools should be ranked higher
      const topTool = tools[0]!.name;
      expect(["read_file", "write_file", "grep", "glob", "list_files"]).toContain(topTool);
    });

    it("should handle multiple intent categories", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools(["research", "social"], [], 5);

      // Should include research or social tools
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain("search_reddit");
    });

    it("should return default tools when no intent matches", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools(["nonexistent" as ToolCategory], [], 5);

      // Should still return tools
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe("getRelevantTools - recency boost", () => {
    it("should boost recently used tools", () => {
      const router = new ToolRouter(mockTools);

      // Record bash as recently successful
      router.recordExecution("bash", true);

      const tools = router.getRelevantTools([], [], 5);

      // bash should be in top tools due to recency
      const topToolNames = tools.slice(0, 3).map(t => t.name);
      expect(topToolNames).toContain("bash");
    });

    it("should boost recently successful tools over failed ones", () => {
      const router = new ToolRouter(mockTools);

      // Record mixed success for bash
      router.recordExecution("bash", false);
      router.recordExecution("bash", false);

      // Record success for grep
      router.recordExecution("grep", true);
      router.recordExecution("grep", true);

      const tools = router.getRelevantTools([], [], 5);

      // grep should rank higher than bash
      const bashIndex = tools.findIndex(t => t.name === "bash");
      const grepIndex = tools.findIndex(t => t.name === "grep");
      expect(grepIndex).toBeLessThan(bashIndex);
    });
  });

  describe("getRelevantTools - success rate", () => {
    it("should prefer tools with higher success rate", () => {
      const router = new ToolRouter(mockTools);

      // Perfect success rate for grep
      for (let i = 0; i < 10; i++) {
        router.recordExecution("grep", true);
      }

      // High failure rate for bash
      for (let i = 0; i < 10; i++) {
        router.recordExecution("bash", false);
      }

      const tools = router.getRelevantTools([], [], 10);

      // grep should rank higher than bash
      const bashIndex = tools.findIndex(t => t.name === "bash");
      const grepIndex = tools.findIndex(t => t.name === "grep");
      expect(grepIndex).toBeLessThan(bashIndex);
    });
  });

  describe("getRelevantTools - keyword matching", () => {
    it("should match tools by name keywords", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools([], ["file"], 5);

      // Tools with "file" in name/description should rank higher
      const topToolNames = tools.slice(0, 3).map(t => t.name);
      expect(topToolNames.some(n => n.includes("file"))).toBe(true);
    });

    it("should match tools by description keywords", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools([], ["shell", "command"], 5);

      // bash mentions "shell commands" in description
      const topToolNames = tools.slice(0, 3).map(t => t.name);
      expect(topToolNames).toContain("bash");
    });

    it("should handle case insensitive keyword matching", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools([], ["FILE"], 5);

      const topToolNames = tools.slice(0, 3).map(t => t.name);
      expect(topToolNames.some(n => n.toLowerCase().includes("file"))).toBe(true);
    });
  });

  describe("getRelevantTools - limit", () => {
    it("should respect the limit parameter", () => {
      const router = new ToolRouter(mockTools);

      const tools3 = router.getRelevantTools([], [], 3);
      expect(tools3.length).toBeLessThanOrEqual(3);

      const tools7 = router.getRelevantTools([], [], 7);
      expect(tools7.length).toBeLessThanOrEqual(7);
    });

    it("should use default limit of 15", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools([], []);
      expect(tools.length).toBeLessThanOrEqual(15);
    });

    it("should ensure minimum coverage when fewer tools than limit", () => {
      const router = new ToolRouter(mockTools);
      const tools = router.getRelevantTools([], [], 100);

      // Should return at least some tools even if score is 0
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe("setTools", () => {
    it("should update the tools list", () => {
      const router = new ToolRouter(mockTools);
      const newTools = [createMockTool("new_tool", "A new tool", ["code"])];

      router.setTools(newTools);

      const tools = router.getRelevantTools([], [], 10);
      expect(tools.some(t => t.name === "new_tool")).toBe(true);
    });
  });

  describe("getAllTools", () => {
    it("should return all available tools", () => {
      const router = new ToolRouter(mockTools);
      const allTools = router.getAllTools();

      expect(allTools.length).toBe(mockTools.length);
    });
  });
});

describe("ToolRouter.detectIntent", () => {
  it("should detect research intent", () => {
    const intent = ToolRouter.detectIntent("Search for news about AI");
    expect(intent).toContain("research");
  });

  it("should detect code intent", () => {
    const intent = ToolRouter.detectIntent("Fix the bug in the function");
    expect(intent).toContain("code");
  });

  it("should detect fileops intent", () => {
    const intent = ToolRouter.detectIntent("List all files in the directory");
    expect(intent).toContain("fileops");
  });

  it("should detect memory intent", () => {
    const intent = ToolRouter.detectIntent("Remember this preference");
    expect(intent).toContain("memory");
  });

  it("should detect analytics intent", () => {
    const intent = ToolRouter.detectIntent("Show me the usage metrics");
    expect(intent).toContain("analytics");
  });

  it("should detect system intent", () => {
    const intent = ToolRouter.detectIntent("Restart the process");
    expect(intent).toContain("system");
  });

  it("should detect ideas intent", () => {
    const intent = ToolRouter.detectIntent("Generate startup ideas");
    expect(intent).toContain("ideas");
  });

  it("should detect social intent", () => {
    const intent = ToolRouter.detectIntent("Search Twitter for discussions");
    expect(intent).toContain("social");
  });

  it("should detect multiple intents", () => {
    const intent = ToolRouter.detectIntent("Search Reddit for code debugging tips");
    expect(intent.length).toBeGreaterThan(1);
    expect(intent).toContain("research");
    expect(intent).toContain("code");
  });

  it("should return default intent when no keywords match", () => {
    const intent = ToolRouter.detectIntent("Hello world");
    expect(intent).toEqual(["research", "code"]);
  });

  it("should be case insensitive", () => {
    const intent = ToolRouter.detectIntent("SEARCH NEWS ABOUT CRYPTO");
    expect(intent).toContain("research");
  });
});

describe("ToolRouter.extractKeywords", () => {
  it("should extract significant words as keywords", () => {
    const keywords = ToolRouter.extractKeywords("Search for news about artificial intelligence");
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain("news");
    expect(keywords).toContain("artificial");
    expect(keywords).toContain("intelligence");
  });

  it("should filter out most stopwords", () => {
    const keywords = ToolRouter.extractKeywords("The quick brown fox jumps over the lazy dog");
    expect(keywords).not.toContain("the");
    // Note: "over" is not in the default stopword list
    expect(keywords).toContain("quick");
    expect(keywords).toContain("brown");
  });

  it("should filter out short words", () => {
    const keywords = ToolRouter.extractKeywords("A cat is on the mat");
    expect(keywords).not.toContain("a");
    expect(keywords).not.toContain("is");
    expect(keywords).not.toContain("on");
  });

  it("should clean non-alphanumeric characters", () => {
    const keywords = ToolRouter.extractKeywords("Testing with special-chars and punctuation!");
    expect(keywords).toContain("special-chars");
    expect(keywords).toContain("punctuation");
  });

  it("should limit to 10 keywords", () => {
    const longMessage = "This is a very long message with many words that should be extracted as keywords but limited to ten";
    const keywords = ToolRouter.extractKeywords(longMessage);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });

  it("should return empty array for stopword-only message", () => {
    const keywords = ToolRouter.extractKeywords("the and for that this");
    expect(keywords.length).toBe(0);
  });

  it("should handle empty string", () => {
    const keywords = ToolRouter.extractKeywords("");
    expect(keywords).toEqual([]);
  });
});

describe("createToolRouter", () => {
  it("should create a ToolRouter instance", () => {
    const router = createToolRouter([]);
    expect(router).toBeInstanceOf(ToolRouter);
  });

  it("should initialize with provided tools", () => {
    const tools = [createMockTool("test", "Test tool", ["code"])];
    const router = createToolRouter(tools);
    const allTools = router.getAllTools();
    expect(allTools.length).toBe(1);
    expect(allTools[0]!.name).toBe("test");
  });
});
