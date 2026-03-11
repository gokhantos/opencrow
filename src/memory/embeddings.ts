import type { EmbeddingProvider } from "./types";
import type { EmbeddingsConfig } from "../config/schema";
import { createLogger } from "../logger";

const log = createLogger("embeddings");

const MAX_RETRIES = 3;
const BATCH_DELAY_MS = 200;

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
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        if (i > 0) await delay(BATCH_DELAY_MS);
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await embedBatch(batch);
        results.push(...embeddings);
      }
      return results;
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
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        if (i > 0) await delay(BATCH_DELAY_MS);
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await embedBatch(batch);
        results.push(...embeddings);
      }
      return results;
    },
  };
}

/**
 * Create an embedding provider from config.
 * For "openrouter" provider, an API key is required.
 */
export function createEmbeddingProviderFromConfig(
  config: EmbeddingsConfig,
  apiKey?: string,
): EmbeddingProvider | null {
  if (config.provider === "local") {
    log.info("Using local embedding provider", {
      url: config.localUrl,
      dimensions: config.dimensions,
    });
    return createLocalEmbeddingProvider(
      config.localUrl,
      config.dimensions,
      config.batchSize,
    );
  }

  if (!apiKey) {
    log.warn("OpenRouter embedding provider requires API key");
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
    "openai/text-embedding-3-small",
    512,
    100,
  );
}
