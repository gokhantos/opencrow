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

interface LocalEmbeddingResponse {
  readonly embeddings: readonly (readonly number[])[];
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

function createLocalEmbeddingProvider(
  baseUrl: string,
  dimensions: number,
  batchSize: number,
): EmbeddingProvider {
  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts, dimensions }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Local embedding server error (${response.status}): ${body}`,
          );
        }

        const json = (await response.json()) as LocalEmbeddingResponse;
        log.info("Embedded batch (local)", {
          chunks: json.embeddings.length,
        });
        return json.embeddings.map((e) => new Float32Array(e));
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          log.warn("Local embedding failed, retrying", {
            attempt: attempt + 1,
            backoffMs,
            error: String(err),
          });
          await delay(backoffMs);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Local embedding failed after ${MAX_RETRIES} retries`);
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
 * Creates a provider that tries the primary provider first, falling back
 * to the secondary if the primary fails after all retries.
 */
function createFallbackEmbeddingProvider(
  primary: EmbeddingProvider,
  fallback: EmbeddingProvider,
  primaryName: string,
  fallbackName: string,
): EmbeddingProvider {
  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      try {
        return await primary.embed(texts);
      } catch (err) {
        log.warn(`${primaryName} embedding failed, falling back to ${fallbackName}`, {
          error: String(err),
          textCount: texts.length,
        });
        return fallback.embed(texts);
      }
    },
  };
}

/**
 * Create an embedding provider from config.
 * When provider is "local", automatically falls back to OpenRouter if available.
 * For "openrouter" provider, an API key is required.
 */
export function createEmbeddingProviderFromConfig(
  config: EmbeddingsConfig,
  apiKey?: string,
): EmbeddingProvider | null {
  const localProvider = createLocalEmbeddingProvider(
    config.localUrl,
    config.dimensions,
    config.batchSize,
  );

  const openRouterProvider = apiKey
    ? createOpenRouterEmbeddingProvider(
        apiKey,
        config.openrouterModel,
        config.dimensions,
        config.batchSize,
      )
    : null;

  if (config.provider === "local") {
    log.info("Using local embedding provider", {
      url: config.localUrl,
      dimensions: config.dimensions,
      fallback: openRouterProvider ? "openrouter" : "none",
    });

    if (openRouterProvider) {
      return createFallbackEmbeddingProvider(
        localProvider,
        openRouterProvider,
        "local",
        "openrouter",
      );
    }

    return localProvider;
  }

  if (!apiKey || !openRouterProvider) {
    log.warn("OpenRouter embedding provider requires API key");
    return null;
  }

  log.info("Using OpenRouter embedding provider", {
    model: config.openrouterModel,
    dimensions: config.dimensions,
    fallback: "local",
  });

  return createFallbackEmbeddingProvider(
    openRouterProvider,
    localProvider,
    "openrouter",
    "local",
  );
}

/**
 * @deprecated Use createEmbeddingProviderFromConfig instead.
 * Kept for backward compatibility with embedding-generator.ts
 */
export function createEmbeddingProvider(apiKey: string): EmbeddingProvider {
  return createOpenRouterEmbeddingProvider(
    apiKey,
    "openai/text-embedding-3-small",
    512,
    100,
  );
}
