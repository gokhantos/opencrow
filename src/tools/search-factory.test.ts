import { describe, it, expect } from "bun:test";
import { createSemanticSearchTool } from "./search-factory";
import type { SemanticSearchToolConfig } from "./search-factory";
import type { MemoryManager } from "../memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock MemoryManager that satisfies the interface for testing. */
function mockMemoryManager(
  results: Array<{ score: number; content: string }> = [],
): MemoryManager {
  return {
    search: async () =>
      results.map((r) => ({
        chunk: {
          id: "c1",
          sourceId: "s1",
          content: r.content,
          chunkIndex: 0,
          tokenCount: 10,
          createdAt: Date.now(),
        },
        score: r.score,
        source: {
          id: "s1",
          kind: "article" as const,
          agentId: "test",
          channel: null,
          chatId: null,
          metadata: {},
          createdAt: Date.now(),
        },
      })),
    indexTweets: async () => "ok",
    indexArticles: async () => "ok",
    indexProducts: async () => "ok",
    indexStories: async () => "ok",
    indexRedditPosts: async () => "ok",
    indexHFModels: async () => "ok",
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

function makeConfig(
  overrides: Partial<SemanticSearchToolConfig> = {},
): SemanticSearchToolConfig {
  return {
    name: "test_search",
    description: "A test search tool.",
    agentId: "agent-1",
    kinds: ["article"],
    memoryManager: mockMemoryManager(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSemanticSearchTool", () => {
  // -- Tool definition tests ------------------------------------------------

  it("should have correct name from config", () => {
    const tool = createSemanticSearchTool(makeConfig({ name: "search_news" }));
    expect(tool.name).toBe("search_news");
  });

  it("should have correct description from config", () => {
    const tool = createSemanticSearchTool(
      makeConfig({ description: "Search all news articles." }),
    );
    expect(tool.description).toBe("Search all news articles.");
  });

  it('should have "research" category', () => {
    const tool = createSemanticSearchTool(makeConfig());
    expect(tool.categories).toContain("research");
  });

  it("should have query as required in inputSchema", () => {
    const tool = createSemanticSearchTool(makeConfig());
    expect(tool.inputSchema.required).toEqual(["query"]);
  });

  it("should have query and limit properties in inputSchema", () => {
    const tool = createSemanticSearchTool(makeConfig());
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("limit");
  });

  it("should include extra input fields in schema when provided", () => {
    const tool = createSemanticSearchTool(
      makeConfig({
        extraInputFields: {
          source: { type: "string", description: "Source filter." },
        },
      }),
    );
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("source");
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("limit");
  });

  it("should embed default limit in limit description", () => {
    const tool = createSemanticSearchTool(
      makeConfig({ defaultLimit: 15, maxLimit: 25 }),
    );
    const props = tool.inputSchema.properties as Record<
      string,
      { description: string }
    >;
    expect(props.limit!.description).toContain("15");
    expect(props.limit!.description).toContain("25");
  });

  // -- Execute: input validation --------------------------------------------

  it("should return error when query is missing", async () => {
    const tool = createSemanticSearchTool(makeConfig());
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return error when query is empty string", async () => {
    const tool = createSemanticSearchTool(makeConfig());
    const result = await tool.execute({ query: "" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  // -- Execute: empty results -----------------------------------------------

  it("should return empty message when no results found", async () => {
    const tool = createSemanticSearchTool(
      makeConfig({ memoryManager: mockMemoryManager([]) }),
    );
    const result = await tool.execute({ query: "something" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("No matching results found.");
  });

  it("should return custom empty message when configured", async () => {
    const tool = createSemanticSearchTool(
      makeConfig({
        memoryManager: mockMemoryManager([]),
        emptyMessage: "Nothing here!",
      }),
    );
    const result = await tool.execute({ query: "something" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Nothing here!");
  });

  // -- Execute: successful results ------------------------------------------

  it("should return formatted results with default formatter", async () => {
    const tool = createSemanticSearchTool(
      makeConfig({
        memoryManager: mockMemoryManager([
          { score: 0.95, content: "First result" },
          { score: 0.82, content: "Second result" },
        ]),
      }),
    );
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("1. (score: 0.95)");
    expect(result.output).toContain("First result");
    expect(result.output).toContain("2. (score: 0.82)");
    expect(result.output).toContain("Second result");
  });

  it("should use custom formatResult when provided", async () => {
    const tool = createSemanticSearchTool(
      makeConfig({
        memoryManager: mockMemoryManager([{ score: 0.9, content: "Hello" }]),
        formatResult: (r, i) => `[${i}] ${r.chunk.content}`,
      }),
    );
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("[0] Hello");
  });

  it("should respect limit parameter", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      score: 0.9 - i * 0.01,
      content: `Result ${i + 1}`,
    }));
    const tool = createSemanticSearchTool(
      makeConfig({ memoryManager: mockMemoryManager(items) }),
    );
    const result = await tool.execute({ query: "test", limit: 3 });
    expect(result.isError).toBe(false);
    // Should contain first 3 results but not the 4th
    expect(result.output).toContain("Result 1");
    expect(result.output).toContain("Result 3");
    expect(result.output).not.toContain("Result 4");
  });

  // -- Execute: error handling ----------------------------------------------

  it("should handle search errors gracefully", async () => {
    const failing: MemoryManager = {
      ...mockMemoryManager(),
      search: async () => {
        throw new Error("Connection refused");
      },
    } as unknown as MemoryManager;

    const tool = createSemanticSearchTool(
      makeConfig({ memoryManager: failing }),
    );
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Connection refused");
  });

  it("should use custom errorPrefix when provided", async () => {
    const failing: MemoryManager = {
      ...mockMemoryManager(),
      search: async () => {
        throw new Error("timeout");
      },
    } as unknown as MemoryManager;

    const tool = createSemanticSearchTool(
      makeConfig({ memoryManager: failing, errorPrefix: "News search failed" }),
    );
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("News search failed");
    expect(result.output).toContain("timeout");
  });

  // -- Execute: postFilter --------------------------------------------------

  it("should apply postFilter when provided", async () => {
    const tool = createSemanticSearchTool(
      makeConfig({
        memoryManager: mockMemoryManager([
          { score: 0.95, content: "Keep" },
          { score: 0.80, content: "Drop" },
        ]),
        postFilter: (results) =>
          results.filter((r) => r.chunk.content !== "Drop"),
      }),
    );
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Keep");
    expect(result.output).not.toContain("Drop");
  });

  // -- Execute: fetchMultiplier ---------------------------------------------

  it("should use fetchMultiplier when calling search", async () => {
    let capturedLimit = 0;
    const spy: MemoryManager = {
      ...mockMemoryManager(),
      search: async (_agentId: string, _query: string, opts: any) => {
        capturedLimit = opts?.limit ?? 0;
        return [];
      },
    } as unknown as MemoryManager;

    const tool = createSemanticSearchTool(
      makeConfig({
        memoryManager: spy,
        defaultLimit: 10,
        fetchMultiplier: 3,
      }),
    );
    await tool.execute({ query: "test" });
    expect(capturedLimit).toBe(30); // 10 * 3
  });

  // -- Defaults -------------------------------------------------------------

  it("should use default values when config omits optionals", () => {
    const tool = createSemanticSearchTool(makeConfig());
    // These are mainly smoke-test; the defaults are 10/20/1.
    const props = tool.inputSchema.properties as Record<
      string,
      { description: string }
    >;
    expect(props.limit!.description).toContain("10");
    expect(props.limit!.description).toContain("20");
  });
});
