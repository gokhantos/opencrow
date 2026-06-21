/**
 * Pure, unit-testable helpers for the Pass-2 over-generation chunking fix.
 *
 * Background: `developIdeasWide` used to ask ONE LLM call to emit ~30 dense
 * ideas in a single response, which reliably blew the 210s per-call timeout.
 * The fix splits the input intersections into small chunks and issues one
 * `chat` call per chunk (each staying in the proven ~5k-output / ~90s regime),
 * then concatenates the per-chunk candidate arrays under a hard cap.
 *
 * These two helpers hold the chunk/merge math so it can be tested without a
 * `chat` client; the orchestration (the chat loop + per-chunk try/catch) lives
 * in `developIdeasWide`.
 */

/**
 * Split `items` into contiguous chunks of at most `chunkSize`. Order-preserving
 * and non-mutating. `chunkSize` below 1 is coerced to 1 (defensive guard so a
 * misconfigured value can't produce a zero-length stride / infinite loop).
 * Empty input yields an empty list.
 */
export function chunkIntersections<T>(
  items: readonly T[],
  chunkSize: number,
): readonly (readonly T[])[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: (readonly T[])[] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Concatenate the per-chunk candidate arrays in order and truncate the total at
 * `maxCandidates` (a HARD ceiling across the merged pool). Failed/empty chunks
 * simply contribute nothing, so the surviving chunks' candidates still merge.
 */
export function mergeWithCap<C>(
  chunks: readonly (readonly C[])[],
  maxCandidates: number,
): readonly C[] {
  const cap = Math.max(0, Math.floor(maxCandidates));
  const merged: C[] = [];
  for (const chunk of chunks) {
    for (const candidate of chunk) {
      if (merged.length >= cap) return merged;
      merged.push(candidate);
    }
  }
  return merged;
}
