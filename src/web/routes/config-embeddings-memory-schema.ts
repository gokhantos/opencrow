/**
 * Pure validation + transform logic for the Embeddings & Memory config route.
 * Kept separate from the Hono wiring so it can be unit-tested without a DB.
 */
import { z } from "zod";

/** config_overrides row that maps onto config.memorySearch.backend. */
export const MEMORY_NAMESPACE = "config";
export const MEMORY_KEY = "memory";

/**
 * Partial override body for the memory backend. Mirrors the schema's
 * `memoryBackendKindSchema` enum. The loader deep-merges this onto
 * `memorySearch.backend`.
 */
export const memoryOverrideSchema = z
  .object({
    backend: z.enum(["qdrant", "mem0"]),
  })
  .strict();

export type MemoryOverride = z.infer<typeof memoryOverrideSchema>;

/**
 * Body for the guarded embeddings-dimensions change. `confirmReindex` must be
 * explicitly `true` for an actual change to be applied — the route returns 409
 * otherwise. Bounds match `embeddingsConfigSchema.dimensions` (32..4096).
 */
export const dimensionsChangeSchema = z
  .object({
    dimensions: z.number().int().min(32).max(4096),
    confirmReindex: z.boolean().default(false),
  })
  .strict();

export type DimensionsChange = z.infer<typeof dimensionsChangeSchema>;

/**
 * Whether `next` is a real change from `current`. Pure helper so the "no-op"
 * vs "needs-confirmation" branch is testable in isolation.
 */
export function isDimensionsChange(current: number, next: number): boolean {
  return current !== next;
}
