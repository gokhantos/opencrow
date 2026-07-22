import { describe, it, expect } from "bun:test";
import { createAppStoreTools } from "./appstore";
import { requireString } from "./input-helpers";

function getAnalyzeKeywordGapTool() {
  const tools = createAppStoreTools(null);
  const tool = tools.find((t) => t.name === "analyze_keyword_gap");
  if (!tool) throw new Error("analyze_keyword_gap tool not registered");
  return tool;
}

describe("analyze_keyword_gap input validation", () => {
  it("declares a bounded, non-empty keyword in its input schema", () => {
    const tool = getAnalyzeKeywordGapTool();
    const properties = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.keyword?.minLength).toBe(1);
    expect(properties.keyword?.maxLength).toBe(200);
  });

  it("rejects an empty keyword before any scan is attempted", async () => {
    const tool = getAnalyzeKeywordGapTool();
    const result = await tool.execute({ keyword: "" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field: keyword");
  });

  it("rejects a whitespace-only keyword before any scan is attempted", async () => {
    const tool = getAnalyzeKeywordGapTool();
    const result = await tool.execute({ keyword: "   " });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field: keyword");
  });

  it("rejects a missing keyword field before any scan is attempted", async () => {
    const tool = getAnalyzeKeywordGapTool();
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Missing required field: keyword");
  });

  it("bounds an over-200-char keyword to 200 chars, matching the tool's extraction opts", () => {
    const overlong = "a".repeat(250);
    const result = requireString({ keyword: overlong }, "keyword", { maxLength: 200 });
    expect(result).toBe("a".repeat(200));
    expect(typeof result === "string" && result.length).toBe(200);
  });
});
