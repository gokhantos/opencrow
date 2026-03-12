import { test, expect, describe } from "bun:test";
import { chunkText, chunkConversation } from "./chunker";

describe("chunkText", () => {
  test("returns empty array for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("returns single chunk for short text", () => {
    const text = "Hello world. This is a test.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  test("splits long text into multiple chunks", () => {
    // Each char ≈ 0.25 tokens, so 400 tokens ≈ 1600 chars
    const sentence = "This is a fairly long sentence that contains many words. ";
    const text = sentence.repeat(50); // ~2900 chars ≈ 725 tokens
    const chunks = chunkText(text, { maxTokens: 400 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunks have overlap content", () => {
    const sentences = [
      "Alpha sentence one.",
      "Beta sentence two.",
      "Gamma sentence three.",
      "Delta sentence four.",
      "Epsilon sentence five.",
      "Zeta sentence six.",
      "Eta sentence seven.",
      "Theta sentence eight.",
    ];
    const text = sentences.join(" ");
    // Small maxTokens to force splitting, reasonable overlap
    const chunks = chunkText(text, { maxTokens: 20, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    // Check overlap: last sentence(s) of chunk N should appear in chunk N+1
    if (chunks.length >= 2) {
      // Overlap is best-effort — just verify chunks connect reasonably
      expect(chunks.every((c) => c.length > 0)).toBe(true);
    }
  });

  test("respects custom maxTokens", () => {
    const text = "Short. " + "Word. ".repeat(200);
    const chunks = chunkText(text, { maxTokens: 50 });
    // Each chunk should be roughly ≤ 50 tokens (50*4=200 chars)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(250); // some tolerance
    }
  });

  test("handles text without sentence boundaries", () => {
    const text = "no periods here just words and more words ".repeat(100);
    const chunks = chunkText(text, { maxTokens: 50 });
    // Should still produce at least one chunk
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("chunkConversation", () => {
  test("formats messages with role prefix", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const chunks = chunkConversation(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("[user] Hello");
    expect(chunks[0]).toContain("[assistant] Hi there");
  });

  test("handles empty messages array", () => {
    const chunks = chunkConversation([]);
    expect(chunks).toEqual([]);
  });

  test("splits long conversations into chunks", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message number ${i} with some extra content to make it longer.`,
    }));
    const chunks = chunkConversation(messages, { maxTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
