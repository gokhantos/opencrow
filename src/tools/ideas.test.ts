import { describe, it, expect } from "bun:test";
import { createIdeaTools, createSaveIdeaTool } from "./ideas";
import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockMemoryManager(): MemoryManager {
  return {
    search: async () => [],
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

function getToolByName(
  tools: readonly ToolDefinition[],
  name: string,
): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Tests: createIdeaTools (factory)
// ---------------------------------------------------------------------------

describe("createIdeaTools", () => {
  it("should return 6 tools without memoryManager", () => {
    const tools = createIdeaTools("test-agent");
    expect(tools).toHaveLength(6);
  });

  it("should return 7 tools with memoryManager (adds search_similar_ideas)", () => {
    const tools = createIdeaTools("test-agent", mockMemoryManager());
    expect(tools).toHaveLength(7);
  });

  it("should include search_similar_ideas only when memoryManager provided", () => {
    const withMm = createIdeaTools("test-agent", mockMemoryManager());
    const withoutMm = createIdeaTools("test-agent");

    const namesWithMm = withMm.map((t) => t.name);
    const namesWithoutMm = withoutMm.map((t) => t.name);

    expect(namesWithMm).toContain("search_similar_ideas");
    expect(namesWithoutMm).not.toContain("search_similar_ideas");
  });

  it("should include all expected tool names", () => {
    const tools = createIdeaTools("test-agent", mockMemoryManager());
    const names = tools.map((t) => t.name);
    expect(names).toContain("save_idea");
    expect(names).toContain("get_previous_ideas");
    expect(names).toContain("get_idea_stats");
    expect(names).toContain("update_idea_stage");
    expect(names).toContain("query_ideas");
    expect(names).toContain("get_ideas_trends");
    expect(names).toContain("search_similar_ideas");
  });

  it("should have all tools with ideas category", () => {
    const tools = createIdeaTools("test-agent", mockMemoryManager());
    for (const tool of tools) {
      expect(tool.categories).toContain("ideas");
    }
  });

  it("should have unique names for every tool", () => {
    const tools = createIdeaTools("test-agent", mockMemoryManager());
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// Tests: save_idea tool
// ---------------------------------------------------------------------------

describe("save_idea tool definition", () => {
  const tool = createSaveIdeaTool("test-agent");

  it("should have the correct name", () => {
    expect(tool.name).toBe("save_idea");
  });

  it("should have ideas category", () => {
    expect(tool.categories).toContain("ideas");
  });

  it("should require title, summary, reasoning, category", () => {
    const required = tool.inputSchema.required as string[];
    expect(required).toContain("title");
    expect(required).toContain("summary");
    expect(required).toContain("reasoning");
    expect(required).toContain("category");
  });

  it("should not require quality_score or sources_used", () => {
    const required = tool.inputSchema.required as string[];
    expect(required).not.toContain("quality_score");
    expect(required).not.toContain("sources_used");
  });

  it("should have category enum with mobile_app, crypto_project, ai_app, open_source, general", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.category.enum).toEqual([
      "mobile_app",
      "crypto_project",
      "ai_app",
      "open_source",
      "general",
    ]);
  });

  it("should have quality_score as number type", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.quality_score.type).toBe("number");
  });

  it("should return error when title is missing (execute)", async () => {
    const result = await tool.execute({
      summary: "s",
      reasoning: "r",
      category: "general",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return error when summary is missing (execute)", async () => {
    const result = await tool.execute({
      title: "t",
      reasoning: "r",
      category: "general",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return error when reasoning is missing (execute)", async () => {
    const result = await tool.execute({
      title: "t",
      summary: "s",
      category: "general",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return error when category is missing (execute)", async () => {
    const result = await tool.execute({
      title: "t",
      summary: "s",
      reasoning: "r",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });
});

// ---------------------------------------------------------------------------
// Tests: get_previous_ideas tool
// ---------------------------------------------------------------------------

describe("get_previous_ideas tool definition", () => {
  const tools = createIdeaTools("test-agent");
  const tool = getToolByName(tools, "get_previous_ideas")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("get_previous_ideas");
  });

  it("should have no required fields", () => {
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("should have optional limit property", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("limit");
    expect(props.limit.type).toBe("number");
  });

  it("should mention duplicates or previous in description", () => {
    expect(tool.description.toLowerCase()).toContain("previous");
  });
});

// ---------------------------------------------------------------------------
// Tests: update_idea_stage tool
// ---------------------------------------------------------------------------

describe("update_idea_stage tool definition", () => {
  const tools = createIdeaTools("test-agent");
  const tool = getToolByName(tools, "update_idea_stage")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("update_idea_stage");
  });

  it("should require id and stage", () => {
    const required = tool.inputSchema.required as string[];
    expect(required).toContain("id");
    expect(required).toContain("stage");
  });

  it("should have stage enum with pipeline stages", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.stage.enum).toEqual([
      "idea",
      "signal",
      "synthesis",
      "validated",
      "archived",
    ]);
  });

  it("should return error when id is missing (execute)", async () => {
    const result = await tool.execute({ stage: "signal" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return error when stage is invalid (execute)", async () => {
    const result = await tool.execute({ id: "some-id", stage: "invalid" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid or missing stage");
  });
});

// ---------------------------------------------------------------------------
// Tests: query_ideas tool
// ---------------------------------------------------------------------------

describe("query_ideas tool definition", () => {
  const tools = createIdeaTools("test-agent");
  const tool = getToolByName(tools, "query_ideas")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("query_ideas");
  });

  it("should have no required fields", () => {
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("should have stage, category, and limit in properties", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("stage");
    expect(props).toHaveProperty("category");
    expect(props).toHaveProperty("limit");
  });

  it("should have valid category enum values", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.category.enum).toEqual([
      "mobile_app",
      "crypto_project",
      "ai_app",
      "open_source",
      "general",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests: get_ideas_trends tool
// ---------------------------------------------------------------------------

describe("get_ideas_trends tool definition", () => {
  const tools = createIdeaTools("test-agent");
  const tool = getToolByName(tools, "get_ideas_trends")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("get_ideas_trends");
  });

  it("should have no required fields", () => {
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("should have days_back property", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("days_back");
  });
});

// ---------------------------------------------------------------------------
// Tests: search_similar_ideas tool
// ---------------------------------------------------------------------------

describe("search_similar_ideas tool definition", () => {
  const tools = createIdeaTools("test-agent", mockMemoryManager());
  const tool = getToolByName(tools, "search_similar_ideas")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("search_similar_ideas");
  });

  it("should require query", () => {
    const required = tool.inputSchema.required as string[];
    expect(required).toContain("query");
  });

  it("should have query and limit in properties", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("limit");
  });

  it("should have ideas category", () => {
    expect(tool.categories).toContain("ideas");
  });

  it("should return error when query is missing (execute)", async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field");
  });

  it("should return safe message when no similar ideas found", async () => {
    const result = await tool.execute({ query: "totally unique idea" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("No similar ideas found");
  });
});

// ---------------------------------------------------------------------------
// Tests: get_idea_stats tool
// ---------------------------------------------------------------------------

describe("get_idea_stats tool definition", () => {
  const tools = createIdeaTools("test-agent");
  const tool = getToolByName(tools, "get_idea_stats")!;

  it("should have the correct name", () => {
    expect(tool.name).toBe("get_idea_stats");
  });

  it("should have no required fields", () => {
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("should have empty properties", () => {
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(Object.keys(props)).toHaveLength(0);
  });
});
