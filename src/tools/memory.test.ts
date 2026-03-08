import { describe, it, expect } from "bun:test";
import {
  createSearchMemoryTool,
  createMemoryTools,
  createGetObservationsTool,
} from "./memory";
import type { ToolDefinition } from "./types";
import type { MemoryManager, SearchResult, MemorySourceKind } from "../memory/types";
import { MEMORY_SOURCE_KINDS } from "../memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSearchResult(
  kind: MemorySourceKind,
  content: string,
  score: number,
  channel: string | null = null,
  chatId: string | null = null,
): SearchResult {
  return {
    chunk: {
      id: "c1",
      sourceId: "s1",
      content,
      chunkIndex: 0,
      tokenCount: 10,
      createdAt: Date.now(),
    },
    score,
    source: {
      id: "s1",
      kind,
      agentId: "test",
      channel,
      chatId,
      metadata: {},
      createdAt: Date.now(),
    },
  };
}

function mockMemoryManager(
  results: SearchResult[] = [],
): MemoryManager {
  return {
    search: async () => results,
    indexTweets: async () => "ok",
    indexArticles: async () => "ok",
    indexProducts: async () => "ok",
    indexStories: async () => "ok",
    indexRedditPosts: async () => "ok",
    indexGithubRepos: async () => "ok",
    indexObservations: async () => "ok",
    indexIdea: async () => "ok",
    indexAppReviews: async () => "ok",
    indexAppRankings: async () => "ok",
    indexTrends: async () => "ok",
    indexDefiProtocols: async () => "ok",
    indexDexTokens: async () => "ok",
    getStats: async () => ({ sourceCount: 0, chunkCount: 0, totalTokens: 0 }),
  } as unknown as MemoryManager;
}

// ---------------------------------------------------------------------------
// Tests: createSearchMemoryTool
// ---------------------------------------------------------------------------

describe("createSearchMemoryTool", () => {
  const tool = createSearchMemoryTool("agent-1", mockMemoryManager());

  // -- Tool definition tests ------------------------------------------------

  it('should have name "search_memory"', () => {
    expect(tool.name).toBe("search_memory");
  });

  it('should have "memory" category', () => {
    expect(tool.categories).toContain("memory");
  });

  it("should require query in inputSchema", () => {
    expect(tool.inputSchema.required).toEqual(["query"]);
  });

  it("should have query, limit, and kinds properties", () => {
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("limit");
    expect(props).toHaveProperty("kinds");
  });

  it("should have kinds enum containing all MEMORY_SOURCE_KINDS", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    const kindsEnum = props.kinds.items.enum;
    for (const kind of MEMORY_SOURCE_KINDS) {
      expect(kindsEnum).toContain(kind);
    }
  });

  it("should mention historical context in description", () => {
    expect(tool.description).toContain("REFERENCE ONLY");
  });

  // -- Execute: empty results -----------------------------------------------

  it("should return friendly message when no results found", async () => {
    const result = await tool.execute({ query: "something obscure" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("No relevant memories found");
  });

  // -- Execute: successful results ------------------------------------------

  it("should return formatted results with scores and source kind", async () => {
    const results = [
      makeSearchResult("conversation", "Hello from a past convo", 0.92, "slack", "chat-123"),
      makeSearchResult("note", "A stored note", 0.85),
    ];
    const tool2 = createSearchMemoryTool("agent-1", mockMemoryManager(results));
    const result = await tool2.execute({ query: "past convos" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("HISTORICAL CONTEXT ONLY");
    expect(result.output).toContain("Result 1");
    expect(result.output).toContain("0.92");
    expect(result.output).toContain("[conversation]");
    expect(result.output).toContain("slack/chat-123");
    expect(result.output).toContain("Result 2");
    expect(result.output).toContain("[note]");
    expect(result.output).toContain("A stored note");
  });

  // -- Execute: error handling ----------------------------------------------

  it("should handle search errors gracefully", async () => {
    const failing = {
      ...mockMemoryManager(),
      search: async () => {
        throw new Error("Qdrant timeout");
      },
    } as unknown as MemoryManager;
    const failTool = createSearchMemoryTool("agent-1", failing);
    const result = await failTool.execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Error searching memory");
    expect(result.output).toContain("Qdrant timeout");
  });

  // -- Execute: limit handling ----------------------------------------------

  it("should pass limit to search capped at 20", async () => {
    let capturedLimit: number | undefined;
    const spy = {
      ...mockMemoryManager(),
      search: async (_agentId: string, _query: string, opts: any) => {
        capturedLimit = opts?.limit;
        return [];
      },
    } as unknown as MemoryManager;

    const spyTool = createSearchMemoryTool("agent-1", spy);
    await spyTool.execute({ query: "test", limit: 100 });
    expect(capturedLimit).toBe(20);
  });

  it("should pass kinds filter when provided", async () => {
    let capturedKinds: string[] | undefined;
    const spy = {
      ...mockMemoryManager(),
      search: async (_agentId: string, _query: string, opts: any) => {
        capturedKinds = opts?.kinds;
        return [];
      },
    } as unknown as MemoryManager;

    const spyTool = createSearchMemoryTool("agent-1", spy);
    await spyTool.execute({ query: "test", kinds: ["note", "conversation"] });
    expect(capturedKinds).toEqual(["note", "conversation"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: createMemoryTools (remember + recall)
// ---------------------------------------------------------------------------

describe("createMemoryTools", () => {
  const tools = createMemoryTools("agent-1");

  it("should return exactly 2 tools", () => {
    expect(tools).toHaveLength(2);
  });

  it('should include "remember" tool', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("remember");
  });

  it('should include "recall" tool', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("recall");
  });

  it("should have both tools with memory category", () => {
    for (const tool of tools) {
      expect(tool.categories).toContain("memory");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: remember tool
// ---------------------------------------------------------------------------

describe("remember tool definition", () => {
  const tools = createMemoryTools("agent-1");
  const tool = tools.find((t) => t.name === "remember")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("remember");
  });

  it("should require key and value", () => {
    const required = tool.inputSchema.required as string[];
    expect(required).toContain("key");
    expect(required).toContain("value");
  });

  it("should have key and value properties as strings", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.key.type).toBe("string");
    expect(props.value.type).toBe("string");
  });

  it("should mention long-term memory in description", () => {
    expect(tool.description.toLowerCase()).toContain("long-term memory");
  });
});

// ---------------------------------------------------------------------------
// Tests: recall tool
// ---------------------------------------------------------------------------

describe("recall tool definition", () => {
  const tools = createMemoryTools("agent-1");
  const tool = tools.find((t) => t.name === "recall")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("recall");
  });

  it("should have no required fields", () => {
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("should have optional key property", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("key");
    expect(props.key.type).toBe("string");
  });

  it("should mention retrieving memory in description", () => {
    expect(tool.description.toLowerCase()).toContain("retrieve");
  });
});

// ---------------------------------------------------------------------------
// Tests: createGetObservationsTool
// ---------------------------------------------------------------------------

describe("createGetObservationsTool", () => {
  const tool = createGetObservationsTool("agent-1");

  it('should have name "get_observations"', () => {
    expect(tool.name).toBe("get_observations");
  });

  it('should have "memory" category', () => {
    expect(tool.categories).toContain("memory");
  });

  it("should have no required fields", () => {
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("should have optional limit property", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("limit");
    expect(props.limit.type).toBe("number");
  });

  it("should mention observations or learnings in description", () => {
    expect(tool.description.toLowerCase()).toContain("observations");
  });

  it("should mention observation types in description", () => {
    expect(tool.description).toContain("preference");
    expect(tool.description).toContain("decision");
    expect(tool.description).toContain("capability");
  });
});
