import { describe, it, expect } from "bun:test";
import { ToolRouter, createToolRouter } from "./router";
import type { ToolDefinition } from "./types";
import type { SemanticToolIndex } from "./semantic-index";

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makeTool(
  name: string,
  description: string,
  categories: ToolDefinition["categories"] = ["research"],
): ToolDefinition {
  return {
    name,
    description,
    categories,
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      return { output: "", isError: false };
    },
  };
}

const TOOLS: readonly ToolDefinition[] = [
  makeTool("technical_analysis", "Run technical analysis on price charts", ["analytics"]),
  makeTool("get_candles", "Fetch OHLCV candlestick data", ["analytics"]),
  makeTool("search_memory", "Search agent memory for relevant context", ["memory"]),
  makeTool("bash", "Execute bash shell commands", ["code"]),
  makeTool("read_file", "Read a file from disk", ["fileops", "code"]),
];

// ──────────────────────────────────────────────────────────────
// Unit tests: keyword/category routing (synchronous path)
// ──────────────────────────────────────────────────────────────

describe("ToolRouter (keyword routing)", () => {
  it("createToolRouter returns a ToolRouter", () => {
    const router = createToolRouter(TOOLS);
    expect(router).toBeInstanceOf(ToolRouter);
  });

  it("getRelevantTools returns tools up to the limit", () => {
    const router = createToolRouter(TOOLS);
    const result = router.getRelevantTools(["analytics"], [], 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("getRelevantTools scores analytics tools higher for analytics intent", () => {
    const router = createToolRouter(TOOLS);
    const result = router.getRelevantTools(["analytics"], []);
    const names = result.map((t) => t.name);
    expect(names.indexOf("technical_analysis")).toBeLessThan(
      names.indexOf("bash"),
    );
  });

  it("recordExecution boosts recently-used tools", () => {
    const router = createToolRouter(TOOLS);
    router.recordExecution("search_memory", true);
    const result = router.getRelevantTools([], []);
    const names = result.map((t) => t.name);
    // search_memory should appear before tools with no history
    expect(names.indexOf("search_memory")).toBeLessThan(names.indexOf("get_candles"));
  });

  it("setTools updates the tools list", () => {
    const router = createToolRouter(TOOLS);
    const newTool = makeTool("new_tool", "Brand new tool");
    router.setTools([...TOOLS, newTool]);
    const result = router.getAllTools();
    expect(result.map((t) => t.name)).toContain("new_tool");
  });
});

// ──────────────────────────────────────────────────────────────
// Static helpers
// ──────────────────────────────────────────────────────────────

describe("ToolRouter.detectIntent", () => {
  it("detects research intent from search keywords", () => {
    const intent = ToolRouter.detectIntent("search for recent news");
    expect(intent).toContain("research");
  });

  it("detects code intent from code keywords", () => {
    const intent = ToolRouter.detectIntent("write a function to parse JSON");
    expect(intent).toContain("code");
  });

  it("detects memory intent", () => {
    const intent = ToolRouter.detectIntent("remember this preference");
    expect(intent).toContain("memory");
  });

  it("returns default intents for unrecognized message", () => {
    const intent = ToolRouter.detectIntent("hello there");
    expect(intent.length).toBeGreaterThan(0);
  });
});

describe("ToolRouter.extractKeywords", () => {
  it("strips stopwords", () => {
    const keywords = ToolRouter.extractKeywords("the quick fox will jump");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("will");
  });

  it("returns words longer than 3 chars", () => {
    const keywords = ToolRouter.extractKeywords("analyze bitcoin price chart");
    expect(keywords).toContain("analyze");
    expect(keywords).toContain("bitcoin");
  });

  it("returns at most 10 keywords", () => {
    const longMessage = Array.from({ length: 20 }, (_, i) => `keyword${i}`).join(" ");
    const keywords = ToolRouter.extractKeywords(longMessage);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });
});

// ──────────────────────────────────────────────────────────────
// Semantic routing path
// ──────────────────────────────────────────────────────────────

describe("ToolRouter.getRelevantToolsForMessage", () => {
  function makeSemanticIndex(
    names: readonly string[],
    available = true,
  ): SemanticToolIndex {
    return {
      isAvailable() {
        return available;
      },
      async init() {},
      async search(_query: string, limit: number): Promise<readonly string[]> {
        return names.slice(0, limit);
      },
    };
  }

  it("uses semantic index when available", async () => {
    const router = createToolRouter(TOOLS);
    const idx = makeSemanticIndex(["technical_analysis", "get_candles"]);
    router.setSemanticIndex(idx);

    const result = await router.getRelevantToolsForMessage("check BTC chart", 5);
    expect(result.map((t) => t.name)).toEqual(["technical_analysis", "get_candles"]);
  });

  it("preserves semantic ranking order", async () => {
    const router = createToolRouter(TOOLS);
    // Semantic index prefers get_candles first
    const idx = makeSemanticIndex(["get_candles", "technical_analysis"]);
    router.setSemanticIndex(idx);

    const result = await router.getRelevantToolsForMessage("candle data", 5);
    expect(result[0]?.name).toBe("get_candles");
    expect(result[1]?.name).toBe("technical_analysis");
  });

  it("falls back to keyword routing when semantic index is unavailable", async () => {
    const router = createToolRouter(TOOLS);
    const idx = makeSemanticIndex(["technical_analysis"], false); // unavailable
    router.setSemanticIndex(idx);

    const result = await router.getRelevantToolsForMessage("code and files", 10);
    // Should still return results via keyword fallback
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back when semantic index returns empty", async () => {
    const router = createToolRouter(TOOLS);
    const emptyIdx = makeSemanticIndex([]); // returns nothing
    router.setSemanticIndex(emptyIdx);

    const result = await router.getRelevantToolsForMessage("write some code", 10);
    // Keyword fallback should kick in and return tools
    expect(result.length).toBeGreaterThan(0);
  });

  it("uses keyword routing when no semantic index set", async () => {
    const router = createToolRouter(TOOLS);
    const result = await router.getRelevantToolsForMessage("search for news", 10);
    expect(result.length).toBeGreaterThan(0);
  });

  it("only returns tools that exist in the registry", async () => {
    const router = createToolRouter(TOOLS);
    // Semantic index returns a phantom name that doesn't exist
    const idx = makeSemanticIndex(["ghost_tool", "technical_analysis"]);
    router.setSemanticIndex(idx);

    const result = await router.getRelevantToolsForMessage("chart", 5);
    const resultNames = result.map((t) => t.name);
    expect(resultNames).not.toContain("ghost_tool");
    expect(resultNames).toContain("technical_analysis");
  });
});
