/**
 * Deep-search reranking helpers (gated behind smart.deepSearchReranker).
 *
 * Two strategies, both isolated to the ideas pipeline (they do NOT touch the
 * shared memory search path):
 *   1. LLM listwise rerank via the project's chat path — asks the model to
 *      order candidate snippets by relevance to a theme.
 *   2. Cross-encoder rerank via a local Ollama embeddings server — scores each
 *      (theme, snippet) pair by cosine similarity of independently embedded
 *      texts (a lightweight bi-encoder stand-in when a true cross-encoder
 *      endpoint is unavailable).
 *
 * Every entry point degrades gracefully: on any error the original ordering is
 * returned unchanged, so a reranker failure can never break the pipeline.
 */

import { chat } from "../../agent/chat";
import { createLogger } from "../../logger";
import type { SearchResult } from "../../memory/types";
import type { ModelProvider } from "../../store/model-routing";
import { buildChatOptions, parseJsonFromResponse, sanitizeForPrompt } from "./synthesizer";

const log = createLogger("pipeline:deep-search-rerank");

export interface RerankCandidate {
  readonly hit: SearchResult;
  /** Short text used for relevance comparison (title + snippet). */
  readonly text: string;
}

/** Build a compact comparison string for a search hit. */
export function candidateText(hit: SearchResult): string {
  const meta = hit.source.metadata;
  const title = typeof meta.title === "string" ? meta.title : "";
  const body = hit.chunk.content.slice(0, 300);
  return `${title} ${body}`.trim();
}

/**
 * Listwise LLM rerank: ask the model to return the indices of the most
 * relevant candidates, most-relevant first. Returns the reordered+truncated
 * candidate list. On any failure returns the first `topK` of the input order.
 */
export async function llmListwiseRerank(
  theme: string,
  candidates: readonly RerankCandidate[],
  topK: number,
  model: string,
  // REQUIRED routed provider (no Claude default) — see synthesizer buildChatOptions.
  provider: ModelProvider,
): Promise<readonly RerankCandidate[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= topK) return candidates;

  try {
    const numbered = candidates
      .map((c, i) => `[${i}] ${sanitizeForPrompt(c.text).slice(0, 280)}`)
      .join("\n");

    const prompt = [
      `Theme: "${sanitizeForPrompt(theme).slice(0, 200)}"`,
      "",
      "Below are numbered evidence snippets. Rank them by how strongly they",
      `support or relate to the theme. Return ONLY a JSON array of the ${topK}`,
      "most relevant snippet indices, most-relevant first. Example: [3,0,7]",
      "",
      numbered,
    ].join("\n");

    const response = await chat(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      buildChatOptions(model, provider),
    );

    const order = parseJsonFromResponse<number[]>(response.text, []);
    if (!Array.isArray(order) || order.length === 0) {
      return candidates.slice(0, topK);
    }

    const seen = new Set<number>();
    const ranked: RerankCandidate[] = [];
    for (const idx of order) {
      if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
      if (idx < 0 || idx >= candidates.length) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      const c = candidates[idx];
      if (c) ranked.push(c);
      if (ranked.length >= topK) break;
    }

    if (ranked.length === 0) return candidates.slice(0, topK);

    // Backfill any shortfall with original-order leftovers (deterministic).
    if (ranked.length < topK) {
      for (let i = 0; i < candidates.length && ranked.length < topK; i++) {
        if (!seen.has(i)) {
          const c = candidates[i];
          if (c) {
            seen.add(i);
            ranked.push(c);
          }
        }
      }
    }

    return ranked;
  } catch (err) {
    log.warn("llmListwiseRerank failed, falling back to input order", { err });
    return candidates.slice(0, topK);
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CrossEncoderEmbedder {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * Cross-encoder-style rerank using an injected embedder (the existing Ollama
 * embedding provider). Embeds the theme and each candidate, then scores by
 * cosine similarity. On any failure returns the first `topK` of input order.
 */
export async function embeddingRerank(
  theme: string,
  candidates: readonly RerankCandidate[],
  topK: number,
  embedder: CrossEncoderEmbedder,
): Promise<readonly RerankCandidate[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= topK) return candidates;

  try {
    const texts = [theme, ...candidates.map((c) => c.text.slice(0, 500))];
    const vectors = await embedder.embed(texts);
    const themeVec = vectors[0];
    if (!themeVec) return candidates.slice(0, topK);

    const scored = candidates.map((c, i) => {
      const vec = vectors[i + 1];
      const score = vec ? cosineSimilarity(themeVec, vec) : -Infinity;
      return { candidate: c, score };
    });

    return [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.candidate);
  } catch (err) {
    log.warn("embeddingRerank failed, falling back to input order", { err });
    return candidates.slice(0, topK);
  }
}
