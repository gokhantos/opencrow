import type { EmbeddingProvider } from "./types";
import { createLogger } from "../logger";

const log = createLogger("embeddings");

const OPENROUTER_EMBEDDINGS_URL =
  "https://openrouter.ai/api/v1/embeddings";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 512;
const MAX_BATCH_SIZE = 100;
const BATCH_DELAY_MS = 200;
const MAX_RETRIES = 3;

interface EmbeddingResponse {
  readonly data: readonly { readonly embedding: readonly number[] }[];
  readonly usage: { readonly total_tokens: number };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEmbeddingProvider(apiKey: string): EmbeddingProvider {
  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (response.status === 429) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        log.warn("Embedding rate limited, retrying", {
          attempt: attempt + 1,
          backoffMs,
        });
        await delay(backoffMs);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `OpenRouter embeddings error (${response.status}): ${body}`,
        );
      }

      const json = (await response.json()) as EmbeddingResponse;

      // OpenRouter returns HTTP 200 with an error body when no upstream provider
      // could handle the request ("No successful provider responses", code 404).
      // This is a transient routing failure — retry with backoff.
      if (!json.data || !Array.isArray(json.data)) {
        const isProviderRouting =
          (json as unknown as { error?: { code?: number } }).error?.code === 404;
        if (isProviderRouting && attempt < MAX_RETRIES - 1) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          log.warn("Embedding provider routing failure, retrying", {
            attempt: attempt + 1,
            backoffMs,
          });
          await delay(backoffMs);
          continue;
        }
        throw new Error(
          `Unexpected embedding response (missing data): ${JSON.stringify(json).slice(0, 200)}`,
        );
      }

      log.info("Embedded batch", {
        model: EMBEDDING_MODEL,
        chunks: json.data.length,
        tokens: json.usage?.total_tokens,
      });

      return json.data.map((d) => new Float32Array(d.embedding));
    }

    throw new Error(
      `Embedding failed after ${MAX_RETRIES} retries (rate limited or no provider)`,
    );
  }

  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        if (i > 0) await delay(BATCH_DELAY_MS);
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const embeddings = await embedBatch(batch);
        results.push(...embeddings);
      }

      return results;
    },
  };
}
