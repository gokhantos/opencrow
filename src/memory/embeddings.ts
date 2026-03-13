import type { EmbeddingProvider } from "./types";
import type { EmbeddingsConfig } from "../config/schema";
import { createLogger } from "../logger";

const log = createLogger("embeddings");

const MAX_RETRIES = 3;
const MAX_CONCURRENT_BATCHES = 4;

interface OpenRouterEmbeddingResponse {
  readonly data: readonly { readonly embedding: readonly number[] }[];
  readonly usage: { readonly total_tokens: number };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process batches concurrently with a concurrency limit.
 * Returns results in the same order as the input batches.
 */
async function processWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function createOpenRouterEmbeddingProvider(
  apiKey: string,
  model: string,
  dimensions: number,
  batchSize: number,
): EmbeddingProvider {
  const url = "https://openrouter.ai/api/v1/embeddings";

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: texts, model, dimensions }),
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

      const json = (await response.json()) as OpenRouterEmbeddingResponse;

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

      log.info("Embedded batch (openrouter)", {
        model,
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
      const batches: (readonly string[])[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        batches.push(texts.slice(i, i + batchSize));
      }
      const batchResults = await processWithConcurrency(
        batches,
        MAX_CONCURRENT_BATCHES,
        async (batch) => embedBatch(batch),
      );
      return batchResults.flat();
    },
  };
}

/**
 * Create an OpenRouter embedding provider from config.
 * Returns null and logs a warning if OPENROUTER_API_KEY is not provided.
 */
export function createEmbeddingProviderFromConfig(
  config: EmbeddingsConfig,
  apiKey?: string,
): EmbeddingProvider | null {
  if (!apiKey) {
    log.warn("OpenRouter embedding provider requires OPENROUTER_API_KEY — vector search disabled");
    return null;
  }

  log.info("Using OpenRouter embedding provider", {
    model: config.openrouterModel,
    dimensions: config.dimensions,
  });

  return createOpenRouterEmbeddingProvider(
    apiKey,
    config.openrouterModel,
    config.dimensions,
    config.batchSize,
  );
}

/**
 * @deprecated Use createEmbeddingProviderFromConfig instead.
 * Kept for backward compatibility with embedding-generator.ts
 */
export function createEmbeddingProvider(apiKey: string): EmbeddingProvider {
  return createOpenRouterEmbeddingProvider(
    apiKey,
    "qwen/qwen3-embedding-8b",
    4096,
    100,
  );
}
