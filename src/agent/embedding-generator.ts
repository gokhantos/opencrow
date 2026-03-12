/**
 * Embedding generator with OpenRouter API provider
 * Reuses existing memory/embeddings.ts infrastructure
 */

import { createEmbeddingProvider } from "../memory/embeddings";

// Cached provider instance
let embeddingProvider: ReturnType<typeof createEmbeddingProvider> | null = null;

/**
 * Get or create the embedding provider instance
 */
async function getProvider(): Promise<ReturnType<typeof createEmbeddingProvider> | null> {
  if (!embeddingProvider) {
    const { getSecret } = await import("../config/secrets");
    const key =
      (await getSecret("OPENROUTER_API_KEY")) ?? (await getSecret("VOYAGE_API_KEY"));
    if (!key) return null;
    embeddingProvider = createEmbeddingProvider(key);
  }
  return embeddingProvider;
}

/**
 * Generate embedding for a single text
 * Uses OpenRouter API (text-embedding-3-small, 512 dimensions)
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const provider = await getProvider();
  if (!provider) {
    throw new Error("No embedding API key available");
  }

  const embeddings = await provider.embed([text]);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error("Failed to generate embedding - empty response");
  }
  return embedding;
}

/**
 * Generate embeddings for multiple texts (batch)
 */
export async function generateEmbeddings(
  texts: string[],
): Promise<Float32Array[]> {
  const provider = await getProvider();
  if (!provider) {
    throw new Error("No embedding API key available");
  }
  return provider.embed(texts);
}
