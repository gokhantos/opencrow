/**
 * Execute an async function over items in serial batches of `batchSize`,
 * optionally waiting `delayBetweenMs` milliseconds between batches.
 *
 * Results are returned in the same order as the input items.
 */
export async function inBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
  delayBetweenMs?: number,
): Promise<readonly R[]> {
  let results: readonly R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results = [...results, ...batchResults];
    if (delayBetweenMs !== undefined && i + batchSize < items.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayBetweenMs));
    }
  }
  return results;
}
