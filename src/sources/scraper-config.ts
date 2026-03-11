import { getOverride } from "../store/config-overrides";
import { createLogger } from "../logger";
import { getErrorMessage } from "../lib/error-serialization";

const log = createLogger("scraper-config");
const NAMESPACE = "scraper-config";

export async function loadScraperIntervalMs(
  scraperId: string,
  defaultMinutes: number,
): Promise<number> {
  try {
    const override = (await getOverride(NAMESPACE, scraperId)) as {
      intervalMinutes?: number;
    } | null;
    const minutes = override?.intervalMinutes ?? defaultMinutes;
    return minutes * 60_000;
  } catch (err) {
    log.warn("Failed to load scraper interval, using default", {
      scraperId,
      error: getErrorMessage(err),
    });
    return defaultMinutes * 60_000;
  }
}
