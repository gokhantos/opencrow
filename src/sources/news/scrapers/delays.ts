/** Human-like delay utilities for browser scraping. */

/** Sleep for a random duration between min and max seconds. */
export async function randomDelay(
  minS: number = 0.5,
  maxS: number = 2.0,
): Promise<void> {
  const ms = (minS + Math.random() * (maxS - minS)) * 1000;
  await Bun.sleep(ms);
}

