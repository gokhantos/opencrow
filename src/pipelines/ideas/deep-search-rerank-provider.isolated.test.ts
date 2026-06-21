/**
 * Isolated test: llmListwiseRerank threads the routed provider into chat().
 *
 * Regression for the pipeline provider-threading bug — the deep-search listwise
 * reranker used to call buildChatOptions(model) with no provider, so a missing
 * provider silently fell through to "anthropic" (the user's personal Claude
 * OAuth) and a non-Anthropic routed generator (e.g. alibaba/deepseek-v4-flash)
 * dispatched the rerank call to the wrong API. The provider is now a REQUIRED
 * param: the reranker forwards exactly what it is given, with NO Claude default.
 *
 * Filed as *.isolated.test.ts because mock.module replaces the narrowest
 * dependency — ../../agent/chat — so no real LLM call occurs. Mocking only chat
 * (not synthesizer or config) keeps the isolated-lane mock surface minimal.
 *
 * NOTE: mock.module must run BEFORE the unit under test is imported.
 */

import { mock, test, expect, describe } from "bun:test";

// ── Stub: capture the options passed into chat(), return a valid ordering ─────
type CapturedOptions = { model?: string; provider?: string };
const captured: CapturedOptions[] = [];

mock.module("../../agent/chat", () => ({
  chat: async (_messages: unknown, options: CapturedOptions) => {
    captured.push(options);
    // Return the top-K indices most-relevant-first so the rerank takes the
    // happy path rather than the error fallback.
    return { text: "[1,0]" };
  },
}));

// Import AFTER the mock so deep-search-rerank binds to the stubbed chat.
import {
  candidateText,
  llmListwiseRerank,
  type RerankCandidate,
} from "./deep-search-rerank";
import type { SearchResult } from "../../memory/types";

function makeHit(id: string, content: string): SearchResult {
  return {
    score: 0.5,
    chunk: {
      id: `chunk-${id}`,
      sourceId: id,
      content,
      chunkIndex: 0,
      tokenCount: 0,
      createdAt: 0,
    },
    source: {
      id,
      kind: "hackernews_story",
      agentId: "shared",
      channel: null,
      chatId: null,
      metadata: { title: id },
      createdAt: 0,
    },
  } as unknown as SearchResult;
}

function candidate(id: string, content: string): RerankCandidate {
  const hit = makeHit(id, content);
  return { hit, text: candidateText(hit) };
}

// Over-fetched set (count > topK) so the chat path actually runs.
const cands = [
  candidate("a", "alpha evidence"),
  candidate("b", "bravo evidence"),
  candidate("c", "charlie evidence"),
];

describe("llmListwiseRerank provider threading", () => {
  test("forwards a routed non-anthropic provider into chat()", async () => {
    captured.length = 0;
    const out = await llmListwiseRerank("theme", cands, 2, "deepseek-v4-flash", "alibaba");

    expect(captured.length).toBe(1);
    expect(captured[0]?.provider).toBe("alibaba");
    expect(captured[0]?.model).toBe("deepseek-v4-flash");
    // Sanity: it returned the model's ordering (index 1 then 0).
    expect(out.map((c) => c.hit.source.id)).toEqual(["b", "a"]);
  });

  test("forwards an anthropic provider only when explicitly routed to it", async () => {
    captured.length = 0;
    // Anthropic is reachable, but ONLY when the route explicitly selects it —
    // never as a silent default for a missing provider (see the @ts-expect-error
    // guard below).
    await llmListwiseRerank("theme", cands, 2, "claude-sonnet-4-6", "anthropic");

    expect(captured.length).toBe(1);
    expect(captured[0]?.provider).toBe("anthropic");
    expect(captured[0]?.model).toBe("claude-sonnet-4-6");
  });

  // Regression guard: provider is REQUIRED. Omitting it used to default to
  // Anthropic and bill the user's Claude OAuth — that path must no longer compile.
  test("provider has no Claude default (omitting it is a type error)", () => {
    // @ts-expect-error provider is required — a 4-arg call must not compile.
    void (() => llmListwiseRerank("theme", cands, 2, "claude-sonnet-4-6"));
    expect(true).toBe(true);
  });
});
