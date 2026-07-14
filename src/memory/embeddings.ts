import type { EmbeddingProvider } from "./types";
import type { EmbeddingsConfig } from "../config/schema";
import { createLogger } from "../logger";

const log = createLogger("embeddings");

const MAX_RETRIES = 3;
const MAX_CONCURRENT_BATCHES = 4;

interface EmbeddingApiResponse {
  readonly data: readonly { readonly embedding: readonly number[] }[];
  readonly usage?: { readonly total_tokens?: number };
}

interface EmbeddingProviderOptions {
  /** OpenAI-compatible API base, e.g. https://openrouter.ai/api/v1 */
  readonly baseUrl: string;
  /** Optional bearer token — omitted entirely for local servers like Ollama. */
  readonly apiKey?: string;
  readonly model: string;
  /** Requested output size. Sent only when set (local models use a fixed dim). */
  readonly dimensions?: number;
  readonly batchSize: number;
  /** Short label for logs/errors: "openrouter" | "ollama". */
  readonly label: string;
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

function createOpenAICompatibleEmbeddingProvider(
  opts: EmbeddingProviderOptions,
): EmbeddingProvider {
  const { baseUrl, apiKey, model, dimensions, batchSize, label } = opts;
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Local servers (Ollama) need no auth — omit the header entirely.
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          input: texts,
          model,
          // Only OpenRouter/OpenAI accept a custom output size; local models don't.
          ...(dimensions ? { dimensions } : {}),
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
          `Embeddings error (${label}) (${response.status}): ${body}`,
        );
      }

      const json = (await response.json()) as EmbeddingApiResponse;

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
        provider: label,
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

/** Default local Ollama OpenAI-compatible embeddings endpoint + model. */
export const DEFAULT_OLLAMA_EMBEDDINGS_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";

/**
 * Construct a LOCAL Ollama embedding provider DIRECTLY — independent of the
 * memory `features/embeddings` config (which may be set to OpenRouter and lack
 * a key). For jobs that must always embed locally (e.g. the App Store keyword
 * clustering batch job), regardless of how memory search is configured. Ollama
 * exposes an OpenAI-compatible `/embeddings` endpoint and needs no auth, and its
 * local models emit a FIXED native dimension — so no `dimensions` size is
 * requested (mirrors `createEmbeddingProviderFromConfig`'s ollama branch).
 */
export function createLocalOllamaEmbeddingProvider(opts: {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly batchSize?: number;
} = {}): EmbeddingProvider {
  const baseUrl = opts.baseUrl ?? DEFAULT_OLLAMA_EMBEDDINGS_URL;
  const model = opts.model ?? DEFAULT_OLLAMA_EMBEDDINGS_MODEL;
  log.info("Using direct local Ollama embedding provider", { baseUrl, model });
  return createOpenAICompatibleEmbeddingProvider({
    baseUrl,
    // Local Ollama needs no auth — the header is omitted entirely for a falsy key.
    apiKey: undefined,
    model,
    // Local models emit a fixed native dimension — never request a custom size.
    dimensions: undefined,
    batchSize: opts.batchSize ?? 64,
    label: "ollama",
  });
}

/**
 * Create an embedding provider from config.
 *
 * - provider "ollama": local OpenAI-compatible server, no API key required.
 * - provider "openrouter" (default): requires an API key; returns null (and
 *   logs a warning, disabling vector search) when none is provided.
 */
export function createEmbeddingProviderFromConfig(
  config: EmbeddingsConfig,
  apiKey?: string,
): EmbeddingProvider | null {
  const model = config.model ?? config.openrouterModel;

  if (config.provider === "ollama") {
    const baseUrl = config.baseUrl ?? "http://127.0.0.1:11434/v1";
    log.info("Using Ollama embedding provider", {
      baseUrl,
      model,
      dimensions: config.dimensions,
    });
    return createOpenAICompatibleEmbeddingProvider({
      baseUrl,
      apiKey: apiKey || undefined,
      model,
      // Local models emit a fixed native dimension — don't request a custom size.
      dimensions: undefined,
      batchSize: config.batchSize,
      label: "ollama",
    });
  }

  if (!apiKey) {
    log.warn("OpenRouter embedding provider requires OPENROUTER_API_KEY — vector search disabled");
    return null;
  }

  const baseUrl = config.baseUrl ?? "https://openrouter.ai/api/v1";
  log.info("Using OpenRouter embedding provider", {
    model,
    dimensions: config.dimensions,
  });
  return createOpenAICompatibleEmbeddingProvider({
    baseUrl,
    apiKey,
    model,
    dimensions: config.dimensions,
    batchSize: config.batchSize,
    label: "openrouter",
  });
}


