import { describe, it, expect } from "bun:test";
import { createCrossSourceSearchTool } from "./cross-search";
import type { MemoryManager, MemorySourceKind, SearchResult } from "../memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  kind: MemorySourceKind,
  content: string,
  score: number,
  title = "",
  url = "",
): SearchResult {
  return {
    chunk: {
      id: `c-${kind}-${score}`,
      sourceId: `s-${kind}`,
      content,
      chunkIndex: 0,
      tokenCount: 10,
      createdAt: Date.now(),
    },
    score,
    source: {
      id: `s-${kind}`,
      kind,
      agentId: "shared",
      channel: null,
      chatId: null,
      metadata: { title, url },
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

    getStats: async () => ({ sourceCount: 0, chunkCount: 0, totalTokens: 0 }),
  } as unknown as MemoryManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCrossSourceSearchTool", () => {
  // -- Tool definition tests ------------------------------------------------

  it('should have name "cross_source_search"', () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    expect(tool.name).toBe("cross_source_search");
  });

  it("should have a description mentioning multiple sources", () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    expect(tool.description).toContain("ALL indexed sources");
    expect(tool.description).toContain("Hacker News");
    expect(tool.description).toContain("Reddit");
  });

  it('should have "research" category', () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    expect(tool.categories).toContain("research");
  });

  it("should require query in inputSchema", () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    expect(tool.inputSchema.required).toEqual(["query"]);
  });

  it("should have query, sources, and limit properties", () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("sources");
    expect(props).toHaveProperty("limit");
  });

  it("should list all searchable kinds in sources enum", () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    const props = tool.inputSchema.properties as Record<string, any>;
    const sourceItems = props.sources.items;
    expect(sourceItems.enum).toContain("reuters_news");
    expect(sourceItems.enum).toContain("hackernews_story");
    expect(sourceItems.enum).toContain("reddit_post");
    expect(sourceItems.enum).toContain("x_post");
    expect(sourceItems.enum).toContain("producthunt_product");
    expect(sourceItems.enum).toContain("github_repo");
    expect(sourceItems.enum).toContain("appstore_review");
    expect(sourceItems.enum).toContain("playstore_app");
  });

  // -- Execute: input validation --------------------------------------------

  it("should return error when query is missing", async () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return error when query is empty", async () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    const result = await tool.execute({ query: "" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  // -- Execute: source filtering --------------------------------------------

  it("should return error when all provided sources are invalid", async () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager());
    const result = await tool.execute({
      query: "test",
      sources: ["bogus", "invalid"],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No valid sources");
  });

  it("should filter out invalid source kinds and keep valid ones", async () => {
    let capturedKinds: MemorySourceKind[] = [];
    const spy = {
      ...mockMemoryManager(),
      search: async (_agentId: string, _query: string, opts: any) => {
        capturedKinds = opts?.kinds ?? [];
        return [];
      },
    } as unknown as MemoryManager;

    const tool = createCrossSourceSearchTool(spy);
    await tool.execute({
      query: "test",
      sources: ["reuters_news", "bogus", "x_post"],
    });
    expect(capturedKinds).toContain("reuters_news");
    expect(capturedKinds).toContain("x_post");
    expect(capturedKinds).not.toContain("bogus");
  });

  // -- Execute: empty results -----------------------------------------------

  it("should return informative message when no results found", async () => {
    const tool = createCrossSourceSearchTool(mockMemoryManager([]));
    const result = await tool.execute({ query: "nonexistent" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("No results found across");
  });

  // -- Execute: successful results ------------------------------------------

  it("should return formatted results with source labels and counts", async () => {
    const results = [
      makeResult("reuters_news", "News about BTC", 0.95, "Bitcoin Surges", "https://news.com/btc"),
      makeResult("hackernews_story", "HN discussion about BTC", 0.88, "Bitcoin on HN", ""),
      makeResult("x_post", "BTC tweet", 0.80, "", ""),
    ];
    const tool = createCrossSourceSearchTool(mockMemoryManager(results));
    const result = await tool.execute({ query: "bitcoin" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Cross-source search: 3 results");
    expect(result.output).toContain("Reuters: 1");
    expect(result.output).toContain("Hacker News: 1");
    expect(result.output).toContain("X/Twitter: 1");
    expect(result.output).toContain("[Reuters]");
    expect(result.output).toContain("Bitcoin Surges");
    expect(result.output).toContain("URL: https://news.com/btc");
  });

  it("should respect limit parameter", async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult("reuters_news", `Result ${i}`, 0.9 - i * 0.01, `Title ${i}`),
    );
    const tool = createCrossSourceSearchTool(mockMemoryManager(results));
    const result = await tool.execute({ query: "test", limit: 3 });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("3 results");
    expect(result.output).not.toContain("Title 3");
  });

  // -- Execute: error handling ----------------------------------------------

  it("should handle search errors gracefully", async () => {
    const failing = {
      ...mockMemoryManager(),
      search: async () => {
        throw new Error("Qdrant is down");
      },
    } as unknown as MemoryManager;

    const tool = createCrossSourceSearchTool(failing);
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Error in cross-source search");
    expect(result.output).toContain("Qdrant is down");
  });

  it("should handle non-Error exceptions", async () => {
    const failing = {
      ...mockMemoryManager(),
      search: async () => {
        throw "unexpected failure";
      },
    } as unknown as MemoryManager;

    const tool = createCrossSourceSearchTool(failing);
    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unexpected failure");
  });

  // -- formatResult edge cases ----------------------------------------------

  it("should use content snippet when title is empty", async () => {
    const results = [
      makeResult("x_post", "A post with no title field set at all", 0.9, "", ""),
    ];
    const tool = createCrossSourceSearchTool(mockMemoryManager(results));
    const result = await tool.execute({ query: "post" });
    expect(result.isError).toBe(false);
    // When title is empty, the formatter uses content.slice(0, 80) as header
    expect(result.output).toContain("A post with no title");
  });
});
