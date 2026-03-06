import { test, expect, describe } from "bun:test";
import { formatIdeasMessage } from "./format-ideas";
import type { GeneratedIdea } from "../sources/ideas/store";

function makeIdea(overrides: Partial<GeneratedIdea> = {}): GeneratedIdea {
  return {
    id: crypto.randomUUID(),
    agent_id: "test-agent",
    title: "Test Idea Title",
    summary: "This is a test idea summary with some details.",
    reasoning: "Good reasoning",
    sources_used: "[]",
    category: "mobile_app",
    rating: null,
    pipeline_stage: "generated",
    quality_score: null,
    model_references: "",
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("formatIdeasMessage", () => {
  test("handles empty ideas list", () => {
    const result = formatIdeasMessage("test-job", []);
    expect(result).toContain("No new ideas generated this run");
    // escapeMarkdown does not escape hyphens — job name is passed through raw
    expect(result).toContain("test-job");
  });

  test("formats single idea", () => {
    const ideas = [
      makeIdea({ title: "Cool App", summary: "A cool app idea." }),
    ];
    const result = formatIdeasMessage("ai-idea-gen", ideas);
    expect(result).toContain("ai idea gen");
    expect(result).toContain("1 new idea");
    expect(result).toContain("Cool App");
    expect(result).toContain("A cool app idea.");
    // Should not say "ideas" (plural) for 1
    expect(result).not.toContain("1 new ideas");
  });

  test("formats multiple ideas with plural", () => {
    const ideas = [
      makeIdea({ title: "App 1" }),
      makeIdea({ title: "App 2" }),
      makeIdea({ title: "App 3" }),
    ];
    const result = formatIdeasMessage("test-gen", ideas);
    expect(result).toContain("3 new ideas");
    expect(result).toContain("App 1");
    expect(result).toContain("App 2");
    expect(result).toContain("App 3");
  });

  test("uses category emoji for mobile_app", () => {
    const ideas = [makeIdea({ category: "mobile_app" })];
    const result = formatIdeasMessage("test", ideas);
    expect(result).toContain("\u{1F4F1}"); // 📱
  });

  test("uses category emoji for crypto_project", () => {
    const ideas = [makeIdea({ category: "crypto_project" })];
    const result = formatIdeasMessage("test", ideas);
    expect(result).toContain("\u26D3"); // ⛓
  });

  test("uses default emoji for unknown category", () => {
    const ideas = [makeIdea({ category: "unknown_cat" })];
    const result = formatIdeasMessage("test", ideas);
    expect(result).toContain("\u{1F4A1}"); // 💡
  });

  test("escapes HTML special characters", () => {
    const ideas = [
      makeIdea({
        title: "App <b>bold</b> & 'quoted'",
        summary: "Summary with <script>alert('xss')</script>",
      }),
    ];
    const result = formatIdeasMessage("test", ideas);
    // escapeHtml converts < > & to entities
    expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;script&gt;");
  });

  test("replaces hyphens with spaces in job name", () => {
    const result = formatIdeasMessage("my-cool-job", [makeIdea()]);
    expect(result).toContain("my cool job");
  });

  test("truncates when total length exceeds 3000", () => {
    const longSummary = "X".repeat(1000);
    const ideas = [
      makeIdea({ title: "Idea 1", summary: longSummary }),
      makeIdea({ title: "Idea 2", summary: longSummary }),
      makeIdea({ title: "Idea 3", summary: longSummary }),
      makeIdea({ title: "Idea 4", summary: longSummary }),
    ];
    const result = formatIdeasMessage("test-gen", ideas);
    expect(result.length).toBeLessThanOrEqual(3000);
    // Should still contain all idea titles
    expect(result).toContain("Idea 1");
    expect(result).toContain("Idea 2");
  });

  test("formats category display name with spaces", () => {
    const ideas = [makeIdea({ category: "mobile_app" })];
    const result = formatIdeasMessage("test", ideas);
    expect(result).toContain("mobile app");
  });

  test("numbers ideas sequentially", () => {
    const ideas = [makeIdea({ title: "First" }), makeIdea({ title: "Second" })];
    const result = formatIdeasMessage("test", ideas);
    expect(result).toContain("1. First");
    expect(result).toContain("2. Second");
  });
});
